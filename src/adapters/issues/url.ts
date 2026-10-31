import { fail } from '../../domain/errors.ts';

/**
 * Normalize an externally supplied issue URL. Tower stores links as data and
 * never fetches arbitrary URLs, but it still refuses URLs that point at private
 * infrastructure or carry credentials so a link cannot become an SSRF vector
 * for any adapter or agent that follows it.
 */
export function normalizeIssueUrl(raw: string): URL {
  if (typeof raw !== 'string' || raw.length > 2048) return fail('invalid', 'issue URL must be a string under 2048 characters');
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return fail('invalid', `not a valid URL: ${raw.slice(0, 100)}`);
  }
  if (url.protocol !== 'https:') fail('invalid', 'issue URLs must use https');
  if (url.username || url.password) fail('invalid', 'issue URLs must not contain credentials');
  if (url.port && url.port !== '443') fail('invalid', 'issue URLs must use the default https port');
  const host = url.hostname.toLowerCase();
  if (isPrivateHost(host)) fail('invalid', `issue URL host ${host} is not allowed`);
  url.hash = '';
  url.hostname = host;
  return url;
}

export function isPrivateHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.home.arpa')) return true;
  if (!h.includes('.') && !h.includes(':')) return true;
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (h.includes(':')) return h === '::1' || h === '::' || /^f[cd]/i.test(h) || /^fe80/i.test(h) || h.startsWith('::ffff:');
  return false;
}

/** Bound untrusted provider/user text before storage. It is data, never instructions. */
export function untrustedText(s: string | undefined | null, max = 4000): string | null {
  if (s === undefined || s === null) return null;
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, max);
}
