/** One request to Tower. `token` overrides the runner's credential for one call (enrollment). */
export interface TransportRequest {
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
  token?: string;
}

export interface TransportResponse {
  status: number;
  body: unknown;
}

/** Sends one request and resolves with whatever status Tower answered. Rejects only on network loss. */
export type Transport = (
  request: TransportRequest,
) => Promise<TransportResponse>;

/** The request never got an answer. The write may or may not have happened, so callers resend. */
export class TransportError extends Error {
  override readonly name = 'TransportError';
}

/** Tower answered with a refusal. `code` is the stable error code from the response body. */
export class TowerRefusal extends Error {
  override readonly name = 'TowerRefusal';

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Reads `{error: {code, message}}` from a refusal body. Anything else is an unknown refusal. */
export function refusalOf(response: TransportResponse): TowerRefusal {
  const error = (
    response.body as
      | { error?: { code?: unknown; message?: unknown } }
      | undefined
  )?.error;
  const code = typeof error?.code === 'string' ? error.code : 'unknown';
  const message =
    typeof error?.message === 'string'
      ? error.message
      : `Tower answered ${response.status}`;
  return new TowerRefusal(response.status, code, message);
}

/** A transport over `fetch`. `baseUrl` is the Tower origin, optionally with a path prefix. */
export function createHttpTransport(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Transport {
  const origin = baseUrl.replace(/\/+$/, '');
  return async ({ method, path, body, token }) => {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (token !== undefined) {
      headers.authorization = `Bearer ${token}`;
    }
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
    }
    let response: Response;
    try {
      // A stalled connection ends with a timeout, so a poll cannot hang on Tower forever.
      response = await fetchImpl(`${origin}${path}`, {
        method,
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new TransportError(
        `request to ${path} failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
    let text: string;
    try {
      text = await readCapped(response);
    } catch (error) {
      // A body cut off mid-read is a lost connection, and callers resend on it.
      if (error instanceof TransportError) {
        throw error;
      }
      throw new TransportError(
        `request to ${path} failed while reading the body: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = text === '' ? undefined : JSON.parse(text);
    } catch {
      throw new TransportError(`Tower answered ${path} with a non-JSON body`);
    }
    return { status: response.status, body: parsed };
  };
}

/** How long one request may take, from sending to the end of the body. */
const REQUEST_TIMEOUT_MS = 30_000;

/** Largest response the runner will read. Tower's answers are small JSON documents. */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/** Reads the body, and stops with a TransportError once it passes the limit. */
async function readCapped(response: Response): Promise<string> {
  if (response.body === null) {
    return '';
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new TransportError(
        'Tower answered with more than the response limit',
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
