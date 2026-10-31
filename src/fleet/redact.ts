export const REDACTED = '[REDACTED]';

/** Longest string scanned. Callers cap their inputs lower; this bounds anything that slips past. */
const MAX_SCANNED = 100_000;

const SECRET_WORDS =
  'secret|token|passw(?:or)?d|passwd|pwd|passphrase|api[_-]?key|private[_-]?key|credential';

/**
 * Secret shapes scanned in every string Tower stores from a runner. Best effort: it catches
 * well-known token formats and key/value assignments, not a secret split across fields or
 * encoded. Every quantifier is bounded or anchored on a literal, so the cost is linear in the
 * input: no pattern starts with an open-ended scan that a long repeated word could re-run.
 */
const PATTERNS: readonly RegExp[] = [
  // Private key blocks (PEM and PGP armor), including a truncated one that lacks its END line.
  /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----|$)/g,
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
  // Webhook URLs, where the path is the credential.
  /hooks\.slack\.com\/services\/[A-Za-z0-9/_-]{8,}/gi,
  /discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+/gi,
  // Signed-URL and query-string credentials.
  /[?&](?:sig|signature|x-amz-signature|x-amz-security-token|x-amz-credential|access_token|api_key|apikey|token)=[^&\s"']+/gi,
  // Credentials inside a URL.
  /\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s/:@]{1,200}:[^\s/@]{1,200}@/gi,
  // Bearer values.
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/g,
  // An Authorization header: the whole value, scheme included, to the end of the line.
  /authorization["']?\s{0,5}[:=]\s{0,5}(?:"[^"\n]{0,2000}"|'[^'\n]{0,2000}'|[^\n"']{1,2000})/gi,
  // name = value or name: value, where the name says it is a secret. A quoted value is taken whole.
  new RegExp(
    `(?:${SECRET_WORDS})[\\w.-]{0,40}["']?\\s{0,5}[:=]\\s{0,5}(?:"[^"\\n]{0,2000}"|'[^'\\n]{0,2000}'|[^\\s"',;]{1,2000})`,
    'gi',
  ),
  // `pass` alone is too common a word, so it counts only directly before a separator.
  /\bpass(?=["']?\s{0,5}[:=])["']?\s{0,5}[:=]\s{0,5}(?:"[^"\n]{0,2000}"|'[^'\n]{0,2000}'|[^\s"',;]{1,2000})/gi,
];

/** Object keys whose value is never stored, whatever it looks like. */
const SECRET_KEY = new RegExp(
  `${SECRET_WORDS}|^pass$|authorization|cookie`,
  'i',
);

const MAX_DEPTH = 8;

export function redactString(text: string): string {
  let out =
    text.length > MAX_SCANNED
      ? `${text.slice(0, MAX_SCANNED)}[TRUNCATED]`
      : text;
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
