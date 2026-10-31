/**
 * The `tower.issues.v1` contract: what Tower needs from an issue provider. Tower never imports a
 * provider's runtime. A provider parses its own URLs, reads one issue, closes one issue, and may
 * decode its own webhooks. Everything it returns about an issue's text is untrusted.
 */
export const ISSUE_CONTRACT = 'tower.issues.v1';

export interface IssueRef {
  provider: string;
  /** `owner/name`, lower-case. */
  repo: string;
  number: number;
  /** The normalized URL Tower stores. */
  url: string;
}

export interface IssueSnapshot {
  /** Provider-stable identity of this issue. A transfer or recreation changes it. */
  nodeId: string;
  repo: string;
  number: number;
  state: 'open' | 'closed';
  /** Untrusted text. Stored and shown as data. */
  title: string;
  /** Open issues that block this one. Counted only when the caller asked for blockers. */
  openBlockers: number;
}

export const PROVIDER_FAILURES = [
  'not_found',
  'permission',
  'rate_limited',
  'unavailable',
  'invalid_response',
  'transferred',
] as const;
export type ProviderFailureKind = (typeof PROVIDER_FAILURES)[number];

export interface ProviderFailure {
  kind: ProviderFailureKind;
  /** Tower-worded and safe to store. Never copied from the provider's body. */
  message: string;
  /** Present for `rate_limited`. Seconds the provider asked Tower to wait. */
  retryAfterSeconds?: number;
}

export type ProviderResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ProviderFailure };

export interface CloseRequest {
  /** Origin marker. The provider puts it where its own events will carry it back. */
  marker: string;
  /** Tower's own wording for the close note. */
  note: string;
}

/** What a provider's webhook decodes to. Only fields Tower acts on. */
export type WebhookObservation =
  | { kind: 'ping' }
  | {
      kind: 'issue';
      action: string;
      repo: string;
      number: number;
      nodeId: string | null;
      state: 'open' | 'closed' | null;
      title: string | null;
      /** True for a transfer or deletion: the URL no longer names the same issue. */
      identityLost: boolean;
    }
  | {
      kind: 'comment';
      repo: string;
      number: number;
      /** Origin marker found in the comment, if any. */
      marker: string | null;
    };

export interface WebhookCodec {
  /** Constant-time check of the signature over the raw body. False for anything malformed. */
  verify(secret: string, rawBody: Uint8Array, headers: Headers): boolean;
  deliveryId(headers: Headers): string | undefined;
  /** Decodes a verified delivery. Undefined for an event Tower ignores. */
  decode(headers: Headers, body: unknown): WebhookObservation | undefined;
}

export interface IssueProvider {
  readonly id: string;
  readonly contract: typeof ISSUE_CONTRACT;
  /** Pure. Undefined when the URL is not an issue this provider owns. */
  parseUrl(url: string): IssueRef | undefined;
  getIssue(
    ref: IssueRef,
    options?: { includeBlockers?: boolean },
  ): Promise<ProviderResult<IssueSnapshot>>;
  /** Closing a closed issue succeeds. The caller reads the issue back afterwards. */
  closeIssue(
    ref: IssueRef,
    request: CloseRequest,
  ): Promise<ProviderResult<{ commented: boolean }>>;
  readonly webhook?: WebhookCodec;
}

function isHiddenCode(code: number): boolean {
  return (
    code <= 0x1f ||
    code === 0x7f ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

/** Text from a provider can carry control and bidirectional characters. Strip them and bound the size. */
export function cleanUntrustedText(value: string, max: number): string {
  let stripped = '';
  for (const char of value) {
    stripped += isHiddenCode(char.codePointAt(0) ?? 0) ? ' ' : char;
  }
  return stripped.length > max ? `${stripped.slice(0, max)}…` : stripped;
}
