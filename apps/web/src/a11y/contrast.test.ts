import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { contrastRatio, parseHex, relativeLuminance } from './contrast.js';

const css = readFileSync('src/styles.css', 'utf8');

/** The custom properties of a rule block whose selector is exactly `selector`. */
function tokens(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) return {};
  const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('\n}', start));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) out[m[1] as string] = (m[2] as string).trim();
  return out;
}
const normal = tokens(':root');
const accessible = { ...normal, ...tokens(":root[data-a11y='on']") };

type Kind = 'text' | 'ui';
interface Pair {
  name: string;
  kind: Kind;
  fg: string;
  bg: string;
  /** Pairs of lines and borders that only carry meaning in Accessible mode (the normal lines are decoration). */
  accessibleOnly?: boolean;
}
const SURFACES = [
  ['the page', '--bg'],
  ['a surface', '--surface'],
  ['a raised surface', '--surface-2'],
] as const;
/** Every foreground and background pair that styles.css puts together. Text needs 4.5, a UI part needs 3. */
const PAIRS: readonly Pair[] = [
  ...SURFACES.flatMap(([where, bg]): Pair[] => [
    { name: `text on ${where}`, kind: 'text', fg: '--text', bg },
    { name: `muted text on ${where}`, kind: 'text', fg: '--text-muted', bg },
    { name: `lantern text (healthy, accents) on ${where}`, kind: 'text', fg: '--lantern', bg },
    { name: `danger text on ${where}`, kind: 'text', fg: '--danger', bg },
    { name: `fog text (latency) on ${where}`, kind: 'text', fg: '--fog', bg },
    { name: `ecto text (the Exorcist) on ${where}`, kind: 'text', fg: '--ecto', bg },
    { name: `calm level pill (neutral) on ${where}`, kind: 'text', fg: '--level-calm', bg },
    { name: `uneasy level pill (cold) on ${where}`, kind: 'text', fg: '--level-uneasy', bg },
    { name: `haunted level pill (danger tint) on ${where}`, kind: 'text', fg: '--level-haunted', bg },
    { name: `possessed level pill (danger) on ${where}`, kind: 'text', fg: '--level-possessed', bg },
    { name: `dark level pill (pale outline) on ${where}`, kind: 'text', fg: '--level-dark', bg },
    { name: `focus outline on ${where}`, kind: 'ui', fg: '--focus', bg },
  ]),
  { name: 'text on the selected row', kind: 'text', fg: '--text', bg: '--selected' },
  { name: 'muted text on the selected row', kind: 'text', fg: '--text-muted', bg: '--selected' },
  { name: 'focus outline on the selected row', kind: 'ui', fg: '--focus', bg: '--selected' },
  { name: 'skip link text on its focus-colour background', kind: 'text', fg: '--bg', bg: '--focus' },
  { name: 'lantern border of the diagnosis card on a raised surface', kind: 'ui', fg: '--lantern', bg: '--surface-2' },
  { name: 'lines on the page (Accessible mode)', kind: 'ui', fg: '--line', bg: '--bg', accessibleOnly: true },
  { name: 'lines on a surface (Accessible mode)', kind: 'ui', fg: '--line', bg: '--surface', accessibleOnly: true },
  { name: 'lines on a raised surface (Accessible mode)', kind: 'ui', fg: '--line', bg: '--surface-2', accessibleOnly: true },
];
const pairsFor = (mode: 'normal' | 'accessible'): readonly Pair[] => PAIRS.filter((p) => mode === 'accessible' || p.accessibleOnly !== true);
describe('contrast function', () => {
  it('matches known values', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#fff', '#fff')).toBe(1);
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 2);
    expect(contrastRatio('#767676', '#ffffff')).toBeCloseTo(4.54, 2);
    expect(contrastRatio('#ffffff', '#767676')).toBeCloseTo(4.54, 2);
    expect(relativeLuminance('#000')).toBe(0);
    expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 10);
    expect(parseHex('#abc')).toEqual([170, 187, 204]);
    expect(() => parseHex('red')).toThrow();
  });
});

describe('contrast pairs of styles.css', () => {
  for (const [mode, theme] of [['normal theme', normal], ['Accessible mode', accessible]] as const) {
    describe(mode, () => {
      for (const p of pairsFor(mode === 'normal theme' ? 'normal' : 'accessible')) {
        it(`${p.name} (${p.kind}) meets ${p.kind === 'text' ? '4.5' : '3'}:1`, () => {
          const fg = theme[p.fg];
          const bg = theme[p.bg];
          expect(fg, `${p.fg} is a hex token`).toMatch(/^#[0-9a-f]{6}$/i);
          expect(bg, `${p.bg} is a hex token`).toMatch(/^#[0-9a-f]{6}$/i);
          expect(contrastRatio(fg as string, bg as string)).toBeGreaterThanOrEqual(p.kind === 'text' ? 4.5 : 3);
        });
      }
    });
  }
  it('has no colour literal outside the custom properties, so no colour skips the check', () => {
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((line) => !/^\s*--[a-z0-9-]+:/.test(line));
    for (const line of rules) expect(line, line).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
  });
  it('uses every colour token it declares in a pair or as a wash', () => {
    const washes = new Set(['--focus-wash', '--press-wash']);
    for (const [name, value] of Object.entries(normal)) {
      // Only colour tokens: the type, space, radius and shadow tokens are not pairs.
      if (washes.has(name) || !/^#[0-9a-f]{6}$/i.test(value)) continue;
      expect(PAIRS.some((p) => p.fg === name || p.bg === name), `${name} is in a pair`).toBe(true);
    }
  });
  it('keeps an outline on a focused room button', () => {
    const block = /\.room-button:focus-visible \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(block).toMatch(/outline:\s*3px solid var\(--focus\)/);
  });
});

describe('Property 5: contrast pairs hold and the function is sound', () => {
  // Feature: accessible-mode, Property 5
  const hex = fc.tuple(fc.integer({ min: 0, max: 255 }), fc.integer({ min: 0, max: 255 }), fc.integer({ min: 0, max: 255 })).map(([r, g, b]) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`);
  it('is symmetric, between 1 and 21, and 1 for equal colours', () => {
    fc.assert(
      fc.property(hex, hex, (a, b) => {
        const r = contrastRatio(a, b);
        expect(r).toBeCloseTo(contrastRatio(b, a), 10);
        expect(r).toBeGreaterThanOrEqual(1);
        expect(r).toBeLessThanOrEqual(21 + 1e-9);
        expect(contrastRatio(a, a)).toBe(1);
      }),
      { numRuns: 200 },
    );
  }, 30_000);
  it('holds for every listed pair in both modes', () => {
    fc.assert(
      fc.property(fc.constantFrom(...PAIRS), fc.constantFrom(normal, accessible), (p, theme) => {
        if (p.accessibleOnly === true && theme === normal) return;
        expect(contrastRatio(theme[p.fg] as string, theme[p.bg] as string)).toBeGreaterThanOrEqual(p.kind === 'text' ? 4.5 : 3);
      }),
      { numRuns: 100 },
    );
  });
});

describe('motion rule', () => {
  const blocks = [
    /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '',
    /:root\[data-a11y='on'\] \*,[\s\S]*?\{([^}]*)\}/.exec(css)?.[1] ?? '',
  ];
  it('zeroes every animation and transition, for every element, in both cases', () => {
    for (const b of blocks) {
      expect(b).toMatch(/animation-duration:\s*0s !important/);
      expect(b).toMatch(/transition-duration:\s*0s !important/);
      expect(b).toMatch(/animation-iteration-count:\s*1 !important/);
    }
    expect(css).toMatch(/\*,\s*\*::before,\s*\*::after \{/);
    expect(css).toMatch(/:root\[data-a11y='on'\] \*::after \{/);
  });
  it('declares one keyframes, the soft pulse, used only by the Hunt running pill', () => {
    expect([...css.matchAll(/@keyframes\s+([\w-]+)/g)].map((x) => x[1])).toEqual(['soft-pulse']);
    const users = [...css.matchAll(/([^{}]+)\{[^}]*animation(?:-name)?:[^;}]*soft-pulse[^}]*\}/g)].map((x) => (x[1] as string).trim());
    expect(users).toEqual(['.pill--running']);
  });
  it('has only transitions shorter than 200 ms outside the rule, and no other animation', () => {
    const outside = css.replace(blocks[0] as string, '').replace(blocks[1] as string, '');
    for (const m of outside.matchAll(/transition:\s*([^;]+);/g)) {
      for (const ms of (m[1] as string).matchAll(/(\d+)ms/g)) expect(Number(ms[1])).toBeLessThan(200);
      expect(m[1]).not.toMatch(/\d(\.\d+)?s\b(?<!m)/);
    }
    for (const m of outside.matchAll(/animation[a-z-]*:\s*([^;]+);/g)) expect(m[1]).toMatch(/^(none|0s|1\b|soft-pulse )/);
  });
});

describe('level pills', () => {
  const tokenOf = (name: string): string => (css.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`)) as RegExpMatchArray)[1] as string;
  const ruleOf = (selector: string): string => (css.match(new RegExp(`${selector.replace(/[[\]'.]/g, '\\$&')}\\s*\\{([^}]*)\\}`)) as RegExpMatchArray)[1] as string;

  it('uses a neutral token for the calm pill, never the lantern (amber reads as a warning)', () => {
    const calm = ruleOf(".pill--level[data-level='0']");
    expect(calm).toContain('var(--level-calm)');
    expect(calm).not.toContain('--lantern');
    expect(contrastRatio(tokenOf('--level-calm'), tokenOf('--text-muted'))).toBeLessThan(1.5);
  });

  it('gives each of the five levels its own token and its own rule', () => {
    const names = ['calm', 'uneasy', 'haunted', 'possessed', 'dark'];
    const values = names.map((n) => tokenOf(`--level-${n}`).toLowerCase());
    expect(new Set(values).size).toBe(5);
    names.forEach((n, i) => expect(ruleOf(`.pill--level[data-level='${i}']`)).toContain(`var(--level-${n})`));
    // The lantern is for healthy services and accents, not for a level.
    expect(values).not.toContain(tokenOf('--lantern').toLowerCase());
  });

  it('matches the scene: the uneasy and dark tokens are the scene cold light, the possessed one the danger colour', () => {
    expect(tokenOf('--level-uneasy').toLowerCase()).toBe('#9cc7e6');
    expect(tokenOf('--level-possessed').toLowerCase()).toBe(tokenOf('--danger').toLowerCase());
  });
});
