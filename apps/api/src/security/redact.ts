/** Key names that suggest a secret. Their values are never written to logs. */
export const SECRET_KEY_PATTERN = /token|key|secret|password|passwd|authorization|cookie|credential/i;
export const REDACTED = '[redacted]';

/** A PostgreSQL connection string anywhere in free text, up to whitespace or a quote. */
const POSTGRES_URL = /\bpostgres(?:ql)?:\/\/[^\s"'`<>]*/gi;
/** Credentials in any URL: `scheme://user:pass@` (the password part is required). */
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*):\/\/[^\s/@:"'`<>]*:[^\s/@"'`<>]*@/gi;

/**
 * Scrubs secrets that appear inside free text: whole PostgreSQL connection
 * strings, and `user:pass@` credentials of any other URL.
 */
export function scrubText(text: string): string {
  return text.replace(POSTGRES_URL, REDACTED).replace(URL_CREDENTIALS, `$1://${REDACTED}@`);
}

/**
 * Returns a deep copy of value where every property whose name matches the
 * secret pattern is replaced with "[redacted]", and every string is passed
 * through scrubText(). Cycles become "[circular]".
 */
export function redact(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === 'string') return scrubText(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((v) => redact(v, seen));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      // defineProperty, not assignment: a key named "__proto__" must stay an own property of the copy.
      Object.defineProperty(out, k, {
        value: SECRET_KEY_PATTERN.test(k) ? REDACTED : redact(v, seen),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  } finally {
    seen.delete(value);
  }
}
