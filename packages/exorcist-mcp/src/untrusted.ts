/**
 * Everything the lab, Prometheus or the model hands us is untrusted text. Before it reaches the
 * agent it is cleaned (no ANSI escapes, no control characters), capped, wrapped in a clearly
 * marked envelope that no data can close, and any secret of this process is masked.
 */

/** Largest tool result, in UTF-8 bytes. */
export const MAX_RESULT_BYTES = 24 * 1024;

export const ERROR_CODES = [
  'bad_input',
  'not_found',
  'lab_unavailable',
  'lab_error',
  'metrics_unavailable',
  'call_limit',
  'already_submitted',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/* eslint-disable no-control-regex */
const OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g;
const CSI = /\u001b\[[0-?]*[ -/]*[@-~]?/g;
const CSI8 = /\u009b[0-?]*[ -/]*[@-~]?/g;
const ESC2 = /\u001b[@-Z\\-_]?/g;
const CONTROL_SINGLE = /[\u0000-\u001f\u007f-\u009f]/g;
const CONTROL_MULTI = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
/* eslint-enable no-control-regex */

/** Cuts to at most `max` UTF-16 code units without splitting a surrogate pair. */
export function cutChars(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return text.slice(0, Math.max(0, end));
}

/** Cuts to at most `maxBytes` of UTF-8 on a character boundary. */
export function cutBytes(text: string, maxBytes: number): string {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= maxBytes) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (Buffer.byteLength(cutChars(text, mid), 'utf8') <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return cutChars(text, lo);
}

/**
 * Removes ANSI escapes and control characters, then caps to `max` characters. A single-line value
 * turns controls into spaces; a multi-line value (a diff) keeps only line feeds and tabs. The text
 * is cut to 4 times the cap before any regex runs, so a huge value costs little.
 */
export function clean(value: unknown, max: number, multiline = false): string {
  const text = typeof value === 'string' ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
  const bounded = cutChars(text, max * 4);
  const noAnsi = bounded.replace(OSC, '').replace(CSI, '').replace(CSI8, '').replace(ESC2, '');
  const noControl = multiline ? noAnsi.replace(/\r\n?/g, '\n').replace(CONTROL_MULTI, '') : noAnsi.replace(CONTROL_SINGLE, ' ');
  return cutChars(noControl, max);
}

/** Replaces every occurrence of each secret (8 or more characters) with `[redacted]`. */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) if (s.length >= 8) out = out.split(s).join('[redacted]');
  return out;
}

/** JSON that cannot close the `<untrusted_data>` wrapper, nor break a line separator. */
function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

export function wrap(json: string): string {
  return `<untrusted_data>\n${json}\n</untrusted_data>`;
}

export type Source = 'lab' | 'prometheus' | 'server';

export interface Envelope {
  text: string;
  isError: boolean;
}

/**
 * Wraps a success result. Over `MAX_RESULT_BYTES`, `shrink` is asked for a smaller version of the
 * data until it fits (the result then says `truncated: true`); if it cannot shrink any more the
 * data is replaced by an empty object.
 */
export function envelope<T>(
  tool: string,
  source: Source,
  data: T,
  truncated: boolean,
  shrink: (data: T) => T | null,
  secrets: readonly string[],
): Envelope {
  let current: T | null = data;
  let cut = truncated;
  for (let i = 0; i < 10_000 && current !== null; i++) {
    const text = wrap(redact(safeJson({ untrusted_data: true, tool, source, truncated: cut, data: current }), secrets));
    if (Buffer.byteLength(text, 'utf8') <= MAX_RESULT_BYTES) return { text, isError: false };
    current = shrink(current);
    cut = true;
  }
  return { text: wrap(safeJson({ untrusted_data: true, tool, source, truncated: true, data: {} })), isError: false };
}

/** Wraps an error result. Only a fixed code (and, for `bad_input`, the field path) is sent. */
export function errorEnvelope(tool: string, code: ErrorCode, field?: string): Envelope {
  const error: { code: ErrorCode; field?: string } = { code };
  if (field !== undefined) error.field = clean(field, 80);
  return { text: wrap(safeJson({ untrusted_data: true, tool, error })), isError: true };
}

/** Halves the text at `key` of an object (a diff); null when it is already short. */
export function shrinkText<T extends Record<string, unknown>>(key: keyof T, min = 64): (data: T) => T | null {
  return (data) => {
    const value = data[key];
    if (typeof value !== 'string' || value.length <= min) return null;
    return { ...data, [key]: cutChars(value, Math.floor(value.length / 2)) };
  };
}

/** Drops the oldest item of the list at `key` (items are oldest first); null when it is empty. */
export function shrinkList<T extends Record<string, unknown>>(key: keyof T): (data: T) => T | null {
  return (data) => {
    const value = data[key];
    if (!Array.isArray(value) || value.length === 0) return null;
    return { ...data, [key]: value.slice(Math.max(1, Math.ceil(value.length / 8))) };
  };
}
