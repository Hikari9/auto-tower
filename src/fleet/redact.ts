export const REDACTED = '[REDACTED]';

/**
 * Secret shapes scanned in every string Tower stores from a runner. Best effort: it catches
 * well-known token formats and key/value assignments, not a secret split across fields or
 * encoded. Order matters only for overlap; each pattern is replaced as a whole.
 */
const PATTERNS: readonly RegExp[] = [
  // PEM blocks, including a truncated one that lacks its END line.
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
  // Tower's own credentials.
  /\btw[re]_[A-Za-z0-9_-]{16,}/g,
  // GitHub tokens, GitLab, Slack, Stripe, npm, Google API keys, AWS access key ids.
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{16,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g,
  /\bnpm_[A-Za-z0-9]{30,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  // Provider API keys such as sk-... and sk-ant-...
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  // JSON web tokens.
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  // Credentials inside a URL.
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/gi,
  // Authorization headers.
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/g,
  // name = value or name: value, where the name says it is a secret.
  /\b[\w.-]*(?:secret|token|passw(?:or)?d|passwd|pwd|api[_-]?key|private[_-]?key|credential|authorization)[\w.-]*["']?\s*[:=]\s*["']?[^\s"',;]{4,}/gi,
];

/** Object keys whose value is never stored, whatever it looks like. */
const SECRET_KEY =
  /secret|token|passw(?:or)?d|passwd|pwd|api[_-]?key|private[_-]?key|credential|authorization|cookie/i;

const MAX_DEPTH = 8;

export function redactString(text: string): string {
  let out = text;
  for (const pattern of PATTERNS) {
    out = out.replace(pattern, (match) =>
      // Keep a URL's scheme and host readable, so the redaction still says where it pointed.
      match.includes('://') && match.endsWith('@')
        ? `${match.slice(0, match.indexOf('://') + 3)}${REDACTED}@`
        : REDACTED,
    );
  }
  return out;
}

/** Redacts every string in a JSON value, and the value under any secret-named key. Pure. */
export function redactValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    return redactString(value);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (depth >= MAX_DEPTH) {
    return REDACTED;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    out[redactString(key)] = SECRET_KEY.test(key)
      ? REDACTED
      : redactValue(nested, depth + 1);
  }
  return out;
}
