/**
 * Link URLs are stored and shown, and a provider builds its own API URLs from parsed parts. Tower
 * never fetches a stored URL. These checks still keep a stored link from naming an internal
 * address, so nothing downstream can be pointed at one by accident or on purpose.
 */

const INTERNAL_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.intranet',
  '.lan',
  '.home',
  '.corp',
  '.private',
  '.home.arpa',
];

const MAX_URL_LENGTH = 2_000;

export interface UrlRefusal {
  ok: false;
  message: string;
}

export type UrlResult = { ok: true; url: URL } | UrlRefusal;

const refuse = (message: string): UrlRefusal => ({ ok: false, message });

/** True for any host written as an IP address, in any form the URL parser accepts. */
export function isIpLiteral(hostname: string): boolean {
  // The URL parser rewrites decimal, hex and octal IPv4 into dotted form and keeps IPv6 in brackets.
  return hostname.startsWith('[') || /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
}

/** A name that is not a public DNS name: no dot, or an internal-use suffix. */
export function isInternalName(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return (
    host === 'localhost' ||
    !host.includes('.') ||
    INTERNAL_SUFFIXES.some((suffix) => host.endsWith(suffix))
  );
}

function hasWhitespaceOrControl(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/**
 * Parses an https URL that names a public DNS host. Refuses credentials, a custom port, IP
 * literals (which covers loopback, private, link-local and metadata addresses in every notation)
 * and internal names. The fragment is dropped.
 */
export function parsePublicHttpsUrl(raw: string): UrlResult {
  if (raw.length > MAX_URL_LENGTH) {
    return refuse(`must be at most ${MAX_URL_LENGTH} characters`);
  }
  if (hasWhitespaceOrControl(raw)) {
    return refuse('must not contain whitespace or control characters');
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return refuse('must be an absolute URL');
  }
  if (url.protocol !== 'https:') {
    return refuse('must use https');
  }
  if (url.username !== '' || url.password !== '') {
    return refuse('must not contain credentials');
  }
  if (url.port !== '') {
    return refuse('must use the default https port');
  }
  if (isIpLiteral(url.hostname)) {
    return refuse('must name a DNS host, not an IP address');
  }
  if (isInternalName(url.hostname)) {
    return refuse('must name a public host, not an internal one');
  }
  url.hash = '';
  return { ok: true, url };
}
