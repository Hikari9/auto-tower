/** A non-2xx answer from the Tower API. `code` and `message` come from the API's error body. */
export class ApiError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {string} message
   */
  constructor(status, code, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Same HTTP surface as an MCP client: bearer token on every call, no privileged
 * shortcuts. The token comes from `getToken()` and is never placed in a URL.
 *
 * @param {{
 *   fetchImpl?: (path: string, init: RequestInit) => Promise<Response>,
 *   getToken?: () => string | null,
 *   onUnauthorized?: () => void,
 * }} [options]
 */
export function createApiClient({
  fetchImpl = (path, init) => globalThis.fetch(path, init),
  getToken = () => null,
  onUnauthorized = () => {},
} = {}) {
  /**
   * @param {string} method
   * @param {string} path
   * @param {unknown} [body]
   * @returns {Promise<any>}
   */
  async function request(method, path, body) {
    /** @type {Record<string, string>} */
    const headers = { accept: 'application/json' };
    const token = getToken();
    if (token) {
      headers.authorization = `Bearer ${token}`;
    }
    /** @type {RequestInit} */
    const init = { method, headers, cache: 'no-store' };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await fetchImpl(path, init);
    const text = await res.text();
    const data = parseJson(text);
    if (!res.ok) {
      if (res.status === 401) {
        onUnauthorized();
      }
      const error = data?.error ?? {};
      throw new ApiError(
        res.status,
        typeof error.code === 'string' ? error.code : 'http_error',
        typeof error.message === 'string'
          ? error.message
          : `Request failed (${res.status})`,
      );
    }
    if (data === null) {
      // A 2xx body that is not JSON (a proxy page, an empty body) is not a usable answer.
      throw new ApiError(
        res.status,
        'invalid_response',
        'The server returned an unexpected response.',
      );
    }
    return data;
  }

  return {
    get: (/** @type {string} */ path) => request('GET', path),
    post: (/** @type {string} */ path, /** @type {unknown} */ body = {}) =>
      request('POST', path, body),
    put: (/** @type {string} */ path, /** @type {unknown} */ body) =>
      request('PUT', path, body),
  };
}

/** @param {string} text */
function parseJson(text) {
  if (text === '') {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
