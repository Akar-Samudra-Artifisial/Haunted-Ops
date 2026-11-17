import fc from 'fast-check';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FULL, NOW, REDUCED, house, scene } from '../test/scene-fakes.js';
import { huntOf } from '../test/hunt-arbs.js';
import { makeService } from '../test/arbs.js';
import { createAnimator } from './animator.js';
import { MAX_MARKS, huntBadgeOf, toSceneModel } from './model.js';
import { FONT_STACK, LEVEL_COLOR, PALETTE } from './palette.js';
import { MOTE_ALPHA, MOTE_MAX, MOTE_PX, moteSpec, motePeak } from './particles.js';
import { RING_TICKS, fitHuntRing, huntRingArt, huntRingExtent, insideMargin, ringStrokes } from './shapes.js';
import { roomSpriteFit, spriteFloor } from './sprites.js';
import { BADGE_GLOW_MS } from './surface.js';
import type { ProposalSummary } from '@haunted-ops/shared';

const css = readFileSync('src/styles.css', 'utf8');
const token = (name: string): string => {
  const m = new RegExp(`--${name}:\\s*([^;]+);`).exec(css);
  if (!m) throw new Error(`no token ${name}`);
  return (m[1] as string).trim().replace(/"/g, "'");
};

describe('the chip and the badge read like the panel', () => {
  it('uses the font stack of the CSS token --font-ui, one constant', () => {
    expect(FONT_STACK).toBe(token('font-ui'));
  });

  it('uses the colours of the CSS tokens: surface, line, text, text-muted, and the five level colours', () => {
    expect(PALETTE.surface).toBe(token('surface').toLowerCase());
    expect(PALETTE.line).toBe(token('line').toLowerCase());
    expect(PALETTE.uiText).toBe(token('text').toLowerCase());
    expect(PALETTE.uiMuted).toBe(token('text-muted').toLowerCase());
    expect(PALETTE.ecto).toBe(token('ecto').toLowerCase());
    expect(PALETTE.danger).toBe(token('danger').toLowerCase());
    expect(LEVEL_COLOR).toEqual(['calm', 'uneasy', 'haunted', 'possessed', 'dark'].map((l) => token(`level-${l}`).toLowerCase()));
  });
});

describe('the words of the hunt badge', () => {
  const proposal = (status: ProposalSummary['status']): ProposalSummary => ({
    id: 'cmproposalaaaaaaaaaaaaaa1',
    huntId: 'cmhuntaaaaaaaaaaaaaaaaaa1',
    attempt: 1,
    kind: 'revert',
    status,
    prNumber: 1,
    prUrl: null,
    mergedBy: null,
    checks: [],
    failReason: null,
    aiFailReason: null,
    updatedAt: '2026-11-14T10:00:00.000Z',
  });

  it('says "Hunting · n steps" while running (1 step singular), then Diagnosed, Fix proposed and Fix merged, as the summary bar does', () => {
    expect(huntBadgeOf({ hunt: huntOf({ status: 'running', startedAt: NOW, stepCount: 5 }), proposal: null })).toBe('Hunting · 5 steps');
    expect(huntBadgeOf({ hunt: huntOf({ status: 'running', startedAt: NOW, stepCount: 1 }), proposal: null })).toBe('Hunting · 1 step');
    expect(huntBadgeOf({ hunt: huntOf({ status: 'queued' }), proposal: null })).toBe('Hunt queued');
    const done = huntOf({ status: 'succeeded', startedAt: NOW - 5000, finishedAt: NOW - 1000, stepCount: 6 });
    expect(huntBadgeOf({ hunt: done, proposal: null })).toBe('Diagnosed');
    expect(huntBadgeOf({ hunt: done, proposal: proposal('open') })).toBe('Fix proposed');
    expect(huntBadgeOf({ hunt: done, proposal: proposal('merged') })).toBe('Fix merged');
    expect(huntBadgeOf({ hunt: done, proposal: proposal('deployed') })).toBe('Fix merged');
    expect(huntBadgeOf({ hunt: null, proposal: null })).toBeNull();
    expect(huntBadgeOf({ hunt: huntOf({ status: 'failed', startedAt: NOW - 5000, finishedAt: NOW - 1000 }), proposal: null })).toBeNull();
  });

  it('never says "x of y"', () => {
    for (let n = 0; n < 40; n++) expect(huntBadgeOf({ hunt: huntOf({ status: 'running', startedAt: NOW, stepCount: n }), proposal: null })).not.toMatch(/ of /);
  });

  it('is carried by the room of the model, with the step count of the hunt', () => {
    const s = house({ payments: { hunt: huntOf({ status: 'running', startedAt: NOW - 5000, stepCount: 12 }) } });
    const room = toSceneModel(s, NOW, FULL).rooms.find((r) => r.name === 'payments')!;
    expect(room.huntBadge).toBe('Hunting · 12 steps');
    expect(room.hunt?.steps).toBe(12);
    expect(room.hunt?.marks).toBe(MAX_MARKS);
  });
});

// Feature: visual-refresh, Property 14
describe('Property 14: the ring ticks lit equal min(steps, 8) and the badge shows the steps', () => {
  it('holds for any hunt', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 60 }), (steps) => {
        const art = huntRingArt({ x: 100, y: 100 }, 40, 20, steps);
        const lit = art.ticks.filter((t) => t.lit).length;
        expect(lit).toBe(Math.min(steps, MAX_MARKS));
        expect(MAX_MARKS).toBe(RING_TICKS);
        // The next tick is dim while there is one to count: one more tick, not lit.
        const dim = art.ticks.filter((t) => !t.lit);
        expect(dim).toHaveLength(steps < RING_TICKS ? 1 : 0);
        // The ring is an ellipse on the floor plane (twice as wide as high) around the centre; every tick is a dash across it (its middle is on the ring).
        for (const p of art.ring) expect(((p.x - 100) / 40) ** 2 + ((p.y - 100) / 20) ** 2).toBeCloseTo(1, 6);
        for (const t of art.ticks) expect((((t.from.x + t.to.x) / 2 - 100) / 40) ** 2 + (((t.from.y + t.to.y) / 2 - 100) / 20) ** 2).toBeCloseTo(1, 6);
        // The badge of the same hunt shows the steps, and the model draws min(steps, 8) ticks for them.
        const hunt = huntOf({ status: 'running', startedAt: NOW - 5000, stepCount: steps });
        const room = toSceneModel(house({ payments: { hunt } }), NOW, FULL).rooms.find((r) => r.name === 'payments')!;
        expect(room.huntBadge).toBe(`Hunting · ${steps} ${steps === 1 ? 'step' : 'steps'}`);
        expect(room.hunt?.marks).toBe(Math.min(steps, MAX_MARKS));
      }),
      { numRuns: 100 },
    );
  });
});

describe('the floor ring reads at a glance and stays on the floor', () => {
  it('starts at the front (bottom) of the ellipse, so 2 steps are 2 lit ticks there, and spreads the 8 positions evenly', () => {
    const art = huntRingArt({ x: 0, y: 0 }, 40, 20, 2, 12);
    expect(art.ticks.filter((t) => t.lit)).toHaveLength(2);
    const first = art.ticks[0]!;
    expect((first.from.x + first.to.x) / 2).toBeCloseTo(0, 6);
    expect((first.from.y + first.to.y) / 2).toBeCloseTo(20, 6);
    const full = huntRingArt({ x: 0, y: 0 }, 40, 20, RING_TICKS, 12);
    const angles = full.ticks.map((t) => Math.atan2(((t.from.y + t.to.y) / 2) / 20, ((t.from.x + t.to.x) / 2) / 40));
    for (let i = 1; i < angles.length; i++) expect(((angles[i]! - angles[i - 1]! + 3 * Math.PI) % (2 * Math.PI)) - Math.PI).toBeCloseTo(Math.PI / 4, 6);
  });
  it('gives ticks at least 2 px wide, at least 3 times as long as wide, and a ring line at most alpha 0.5, at 390 and 1440', () => {
    for (const width of [390, 1440]) {
      const { layout } = scene(house(), FULL, { width, height: 800, dpr: 1 });
      const st = ringStrokes(layout.scale);
      expect(st.tick).toBeGreaterThanOrEqual(2);
      expect(st.len).toBeGreaterThanOrEqual(3 * st.tick);
      expect(st.len).toBeGreaterThanOrEqual(3 * st.ring);
      expect(st.tick).toBeGreaterThan(st.ring);
      const art = huntRingArt({ x: 0, y: 0 }, 40, 20, 3, st.len);
      for (const t of art.ticks) expect(Math.hypot(t.to.x - t.from.x, t.to.y - t.from.y)).toBeCloseTo(st.len, 6);
    }
    const src = readFileSync('src/scene/pixi-surface.ts', 'utf8');
    expect(Number(/const RING_ALPHA = ([\d.]+);/.exec(src)![1])).toBeLessThanOrEqual(0.5);
    expect(Number(/const TICK_ALPHA = ([\d.]+);/.exec(src)![1])).toBe(1);
    expect(Number(/const TICK_DIM_ALPHA = ([\d.]+);/.exec(src)![1])).toBe(0.3);
  });
  it('keeps the whole ring and its ticks inside the floor of every room, sprite floor or layout floor, at 390, 768, 1024 and 1440', () => {
    for (const width of [390, 768, 1024, 1440]) {
      const { layout } = scene(house(), FULL, { width, height: 800, dpr: 1 });
      expect(layout.rooms.length).toBeGreaterThan(0);
      for (const room of layout.rooms) {
        const st = ringStrokes(layout.scale);
        for (const floor of [room.floor, spriteFloor(roomSpriteFit(room.floor))]) {
          const fit = fitHuntRing(floor, room.exorcistAt, 0.55 * layout.scale, 0.275 * layout.scale, st.len, st.tick / 2 + 2);
          for (const p of huntRingExtent(fit.centre, fit.rx, fit.ry, st.len)) expect(insideMargin(floor, p)).toBeGreaterThanOrEqual(st.tick / 2 + 2 - 1e-6);
        }
      }
    }
  });
});
describe('fine dust in lantern light', () => {
  it('has at most 4 motes in a calm room, 2 in an uneasy one and none from haunted up, none under Reduced motion or in Low quality', () => {
    const count = (level: 0 | 1 | 2 | 3 | 4, options = FULL): number => toSceneModel([makeService('payments', { hauntLevel: level })], NOW, options).rooms[0]!.moteCount;
    expect([0, 1, 2, 3, 4].map((l) => count(l as 0 | 1 | 2 | 3 | 4))).toEqual([4, 2, 0, 0, 0]);
    expect(MOTE_MAX).toBe(4);
    for (const l of [0, 1] as const) expect(count(l, REDUCED)).toBe(0);
    for (const l of [0, 1] as const) expect(count(l, { reducedMotion: false, quality: 'low' })).toBe(0);
  });

  it('gives each mote 2 to 4 px, a peak alpha of 0.25 to 0.45 and a life of 6 to 10 s', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 ** 31 - 1 }), fc.integer({ min: 0, max: MOTE_MAX - 1 }), (seed, i) => {
        const m = moteSpec(seed, i);
        expect(m.size).toBeGreaterThanOrEqual(MOTE_PX.lo);
        expect(m.size).toBeLessThanOrEqual(MOTE_PX.hi);
        expect(motePeak(m)).toBeGreaterThanOrEqual(MOTE_ALPHA.lo);
        expect(motePeak(m)).toBeLessThanOrEqual(MOTE_ALPHA.hi);
        expect(1 / m.speed).toBeGreaterThanOrEqual(6 - 1e-9);
        expect(1 / m.speed).toBeLessThanOrEqual(10 + 1e-9);
      }),
      { numRuns: 100 },
    );
  });

  it('draws motes 2 to 4 px at any zoom, alpha under 0.45, rising and fading, and removes them under Reduced motion', () => {
    for (const viewport of [{ width: 390, height: 844, dpr: 1 }, { width: 3840, height: 2160, dpr: 1 }]) {
      const s = scene(house(), FULL, viewport);
      const a = createAnimator();
      a.setLayout(s.layout);
      a.setModel(s.model);
      let seen = 0;
      const ys: number[] = [];
      for (let t = 0; t < 12_000; t += 100) {
        const f = a.step(100, t);
        for (let k = 0; k < f.motes.count; k++) {
          seen += 1;
          expect(f.motes.size[k]).toBeGreaterThanOrEqual(2);
          expect(f.motes.size[k]).toBeLessThanOrEqual(4);
          expect(f.motes.alpha[k]).toBeLessThanOrEqual(0.45 + 1e-6);
          expect(f.motes.alpha[k]).toBeGreaterThan(0);
        }
        // Per room at most 4, in all at most 4 rooms of 4.
        expect(f.motes.count).toBeLessThanOrEqual(4 * MOTE_MAX);
        if (f.motes.count > 0) ys.push(f.motes.y[0] as number);
      }
      expect(seen).toBeGreaterThan(0);
      // The motes move (they rise over their life, by MOTE_RISE iso units).
      expect(Math.min(...ys)).toBeLessThan(Math.max(...ys));
    }
    const still = scene(house(), REDUCED);
    const b = createAnimator();
    b.setLayout(still.layout);
    b.setModel(still.model);
    for (let t = 0; t < 5000; t += 100) expect(b.step(100, t).motes.count).toBe(0);
  });

  it('puts no mote in a haunted room', () => {
    const s = scene(house({ payments: { hauntLevel: 2 }, orders: { hauntLevel: 3 }, gate: { hauntLevel: 4 } }), FULL);
    const a = createAnimator();
    a.setLayout(s.layout);
    a.setModel(s.model);
    let t = 0;
    for (; t < 3000; t += 100) a.step(100, t);
    // Only the calm ledger room is left: at most 4 motes.
    expect(a.step(100, t).motes.count).toBeLessThanOrEqual(MOTE_MAX);
  });
});

describe('the breath of the hunt badge magnifier', () => {
  const alphaOver = (options: typeof FULL, ms: number): number[] => {
    const s = scene(house({ payments: { hunt: huntOf({ status: 'running', startedAt: NOW - 20_000, stepCount: 3 }) } }), options);
    const a = createAnimator();
    a.setLayout(s.layout);
    a.setModel(s.model);
    const out: number[] = [];
    for (let t = 0; t <= ms; t += 50) out.push(a.step(50, t).rooms.find((r) => r.name === 'payments')!.hunt.badgeGlow);
    return out;
  };

  it('moves between 0.7 and 1 along a sine of 2 s', () => {
    const v = alphaOver(FULL, 6000);
    expect(Math.min(...v)).toBeGreaterThanOrEqual(0.7 - 1e-9);
    expect(Math.max(...v)).toBeLessThanOrEqual(1 + 1e-9);
    expect(Math.max(...v) - Math.min(...v)).toBeGreaterThan(0.25);
    expect(BADGE_GLOW_MS).toBe(2000);
    // The same value one period later.
    expect(v[40]).toBeCloseTo(v[0] as number, 6);
    // No more than 2 changes of direction per second: one rise and one fall per 2 s.
    let turns = 0;
    for (let i = 2; i < v.length; i++) if (Math.sign(v[i]! - v[i - 1]!) !== Math.sign(v[i - 1]! - v[i - 2]!) && v[i] !== v[i - 1]) turns += 1;
    expect(turns).toBeLessThanOrEqual(7);
  });

  it('stays at 1 under Reduced motion and in Low quality', () => {
    for (const options of [REDUCED, { reducedMotion: false, quality: 'low' as const }]) expect(new Set(alphaOver(options, 4000))).toEqual(new Set([1]));
  });
});
