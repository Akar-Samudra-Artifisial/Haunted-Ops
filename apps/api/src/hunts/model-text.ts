import { clean, cutChars } from '@haunted-ops/exorcist-mcp/untrusted';

/** Direction controls: they can make text read in another order than it is written. */
const BIDI = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
/** Characters that show nothing: soft hyphen, zero-width space and joiners, word joiner, BOM, and the like. */
const INVISIBLE = /\u00ad|\u034f|\u180e|[\u200b-\u200d]|[\u2060-\u2064]|\ufeff/g;
/** `[text](target)` and `![alt](target)`, the whole of it. */
const MARKDOWN_LINK = /!?\[[^\]]*\]\([^)]*\)/g;
/** A reference style link, `[text][ref]`. */
const MARKDOWN_REFERENCE = /\[[^\]]*\]\[[^\]]*\]/g;
/** A URL with a scheme, or one that starts with `www.`. */
const URL = /\b(?:[a-z][a-z0-9+.-]{1,15}):\/\/[^\s<>]*|\b(?:https?|ftp|file|data|javascript|vbscript|mailto|ssh|tel):[^\s<>]*|\bwww\.[^\s<>]*/gi;
/** An HTML tag, or the start of one that is never closed. */
const TAG = /<[^>]*>?/g;

/**
 * Text that a model wrote and a public page shows. It is cleaned of control characters and ANSI escapes,
 * of direction controls and invisible characters (they hide or reorder text), of markdown links, URLs and
 * HTML tags (a page must not carry a link or markup of the model's choosing), then its whitespace is
 * collapsed to single spaces, and it is cut to `max` characters. The result is one line of plain text, and
 * cleaning it again changes nothing.
 */
export function sanitizeModelText(value: unknown, max: number): string {
  let text = clean(value, max * 4, false);
  for (let pass = 0; pass < 6; pass++) {
    const before = text;
    text = text
      .replace(BIDI, '')
      .replace(INVISIBLE, '')
      .replace(MARKDOWN_LINK, ' ')
      .replace(MARKDOWN_REFERENCE, ' ')
      .replace(URL, ' ')
      .replace(TAG, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (text === before) break;
  }
  return cutChars(text, max).trim();
}
