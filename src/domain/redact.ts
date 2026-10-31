/**
 * Secret redaction for anything a runner or provider sends us (receipts, evidence,
 * failure text). Evidence must stay retrievable after the session ends, so it must
 * never carry credentials.
 */
const PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\btwr_[a-z]_[A-Za-z0-9_-]{20,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /(\b(?:authorization|bearer)\b[:=\s]+)(?!\[REDACTED\])[A-Za-z0-9._~+/=-]{12,}/gi,
  /(\b(?:password|passwd|secret|token|api[_-]?key|client[_-]?secret)\b["']?\s*[:=]\s*["']?)(?!\[REDACTED\])[^\s"',;]{6,}/gi,
];

export function redactString(s: string): { text: string; count: number } {
  let count = 0;
  let text = s;
  for (const re of PATTERNS) {
    text = text.replace(re, (match: string, group: unknown) => {
      count++;
      // Patterns with a capture group keep their label ("password=") and redact the value.
      const prefix = typeof group === 'string' && match.startsWith(group) ? group : '';
      return `${prefix}[REDACTED]`;
    });
  }
  return { text, count };
}

/** Deep-redact a JSON value. Returns a new value and the number of redactions. */
export function redact<T>(value: T): { value: T; count: number } {
  let count = 0;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const r = redactString(v);
      count += r.count;
      return r.text;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) {
        if (/^(token|secret|password|api_?key|authorization|private_?key|credentials?)$/i.test(k) && typeof val === 'string' && val) {
          count++;
          out[k] = '[REDACTED]';
        } else out[k] = walk(val);
      }
      return out;
    }
    return v;
  };
  return { value: walk(value) as T, count };
}
