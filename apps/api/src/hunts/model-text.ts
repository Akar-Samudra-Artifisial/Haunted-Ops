import { clean, cutChars } from '@haunted-ops/exorcist-mcp/untrusted';

/** Direction controls: they can make text read in another order than it is written. */
const BIDI = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
/** Characters that show nothing: soft hyphen, zero-width space and joiners, word joiner, BOM, and the like. */
const INVISIBLE = /\u00ad|\u034f|\u180e|[\u200b-\u200d]|[\u2060-\u2064]|\ufeff/g;
/** A URL with a scheme, or one that starts with `www.`. */
const URL = /\b(?:[a-z][a-z0-9+.-]{1,15}):\/\/[^\s<>]*|\b(?:https?|ftp|file|data|javascript|vbscript|mailto|ssh|tel):[^\s<>]*|\bwww\.[^\s<>]*/gi;
/** An HTML tag, or the start of one that is never closed. */
const TAG = /<[^>]*>?/g;

/**
 * Replaces each `[text](target)` and `![alt](target)` (`kind` 'link'), or each `[text][ref]` (`kind` 'reference'), by a
 * space. The same matches as the regular expressions `!?\[[^\]]*\]\([^)]*\)` and `\[[^\]]*\]\[[^\]]*\]` give, in
 * linear time: those scan to the end of the text from every `[` and take quadratic time on a long run of `[`. Every `[`
 * before the same `]` has the same outcome, so a failed `[` lets the scan go on after its `]`, and when no closing
 * character is left no later match is possible.
 */
export function replaceMarkdownLinks(text: string, kind: 'link' | 'reference'): string {
  const second = kind === 'link' ? '(' : '[';
  const last = kind === 'link' ? ')' : ']';
  let out = '';
  let pos = 0;
  let i = text.indexOf('[');
  while (i !== -1) {
    const close = text.indexOf(']', i + 1);
    if (close === -1) break;
    if (text[close + 1] === second) {
      const end = text.indexOf(last, close + 2);
      if (end === -1) break;
      const start = kind === 'link' && i > pos && text[i - 1] === '!' ? i - 1 : i;
      out += `${text.slice(pos, start)} `;
      pos = end + 1;
      i = text.indexOf('[', pos);
    } else {
      i = text.indexOf('[', close + 1);
    }
  }
  return pos === 0 ? text : out + text.slice(pos);
}
/** Removes direction controls and invisible characters and nothing else (a diff keeps its lines and its spaces). */
export function stripHidden(text: string): string {
  return text.replace(BIDI, '').replace(INVISIBLE, '');
}

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
    text = replaceMarkdownLinks(replaceMarkdownLinks(text.replace(BIDI, '').replace(INVISIBLE, ''), 'link'), 'reference')
      .replace(URL, ' ')
      .replace(TAG, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (text === before) break;
  }
  return cutChars(text, max).trim();
}
