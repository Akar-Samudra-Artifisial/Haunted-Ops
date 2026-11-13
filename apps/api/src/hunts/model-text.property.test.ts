import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { HUNT_LIMITS } from '@haunted-ops/shared';
import { sanitizeModelText } from './model-text.js';

const RUNS = { numRuns: 400 };

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const BIDI = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
const INVISIBLE = /\u00ad|\u034f|\u180e|[\u200b-\u200d]|[\u2060-\u2064]|\ufeff/;

const pieces = fc.constantFrom(
  'plain words',
  'line\nbreak',
  '\ttab',
  '\u001b[31mred\u001b[0m',
  'a\u202eb',
  'z\u200bw\u200d',
  '\ufeffbom',
  'see https://evil.example/x?y=1 now',
  'ftp://host/file',
  'javascript:alert(1)',
  'www.example.org/path',
  '[click here](https://evil.example)',
  '![img](data:text/html,x)',
  '[ref][1]',
  '<b>bold</b>',
  '<script>alert(1)</script>',
  '<img src=x onerror=y',
  '   many    spaces   ',
  'mailto:me@example.org',
);
const text = fc.array(pieces, { maxLength: 12 }).map((p) => p.join(' '));

// Feature: exorcist-agent, Property 23: model text on the page is plain
describe('Property 23: sanitizeModelText gives one short line of plain text', () => {
  it('has no control, direction or invisible character, single spaces, and respects the cap, for any string', () => {
    fc.assert(
      fc.property(fc.oneof(text, fc.string({ maxLength: 800 }), fc.string({ unit: 'binary', maxLength: 300 })), fc.constantFrom(HUNT_LIMITS.summary, HUNT_LIMITS.fixHint), (value, cap) => {
        const out = sanitizeModelText(value, cap);
        expect(out.length).toBeLessThanOrEqual(cap);
        expect(CONTROL.test(out)).toBe(false);
        expect(BIDI.test(out)).toBe(false);
        expect(INVISIBLE.test(out)).toBe(false);
        expect(/\s{2}/.test(out)).toBe(false);
        expect(out).toBe(out.trim());
      }),
      RUNS,
    );
  });

  it('leaves no URL, markdown link or tag in text that has them', () => {
    fc.assert(
      fc.property(text, fc.constantFrom(HUNT_LIMITS.summary, HUNT_LIMITS.fixHint), (value, cap) => {
        const out = sanitizeModelText(value, cap);
        expect(/https?:|ftp:|file:|data:|javascript:|vbscript:|mailto:|www\./i.test(out)).toBe(false);
        expect(/:\/\//.test(out)).toBe(false);
        expect(out.includes('<')).toBe(false);
        expect(out.includes('](')).toBe(false);
        expect(/\s{2}/.test(out)).toBe(false);
        expect(out).toBe(out.trim());
      }),
      RUNS,
    );
  });

  it('cleaning again changes nothing', () => {
    fc.assert(
      fc.property(text, (value) => {
        const once = sanitizeModelText(value, HUNT_LIMITS.summary);
        expect(sanitizeModelText(once, HUNT_LIMITS.summary)).toBe(once);
      }),
      RUNS,
    );
  });

  it('keeps the words around what it removes, and the documented caps are 400 and 300', () => {
    expect(HUNT_LIMITS.summary).toBe(400);
    expect(HUNT_LIMITS.fixHint).toBe(300);
    expect(sanitizeModelText('The guard\nwas removed.  See [the diff](https://x.example/d) or https://x.example now <b>please</b>.', 400)).toBe('The guard was removed. See or now please .');
    expect(sanitizeModelText('a\u202eb\u200bc', 50)).toBe('abc');
    expect(sanitizeModelText('x'.repeat(1000), 400)).toHaveLength(400);
    expect(sanitizeModelText(undefined, 400)).toBe('');
  });
});
