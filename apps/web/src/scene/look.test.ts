import { describe, expect, it } from 'vitest';
import { makeService } from '../test/arbs.js';
import { huntOf } from '../test/hunt-arbs.js';
import { FULL, NOW, REDUCED, house, scene } from '../test/scene-fakes.js';
import { GLOW_PULSE_GAP_MS, GLOW_PULSE_MS, PARALLAX_PX, ROOF_FOCUSED_ALPHA, createAnimator, glowPulse } from './animator.js';
import { LEVEL_LOOK } from './model.js';
import type { Frame } from './surface.js';

function run(a: ReturnType<typeof createAnimator>, ms: number, from: number, dt = 16): { frame: Frame; time: number } {
  let t = from;
  let frame!: Frame;
  for (let e = 0; e < ms; e += dt) {
    t += dt;
    frame = a.step(dt, t);
  }
  return { frame, time: t };
}

const level = (hauntLevel: 0 | 1 | 2 | 3 | 4) => [makeService('payments', { hauntLevel })];

function animatorFor(services: ReturnType<typeof level>, options = FULL) {
  const s = scene(services, options);
  const a = createAnimator();
  a.setLayout(s.layout);
  a.setModel(s.model);
  return { a, layout: s.layout };
}

describe('the soft glow pulse', () => {
  it('is one cycle of at least a second: zero outside, one rise and one fall inside', () => {
    expect(GLOW_PULSE_MS).toBeGreaterThanOrEqual(1000);
    expect(glowPulse(1000, 1000)).toBe(0);
    expect(glowPulse(1000, 1000 + GLOW_PULSE_MS)).toBe(0);
    expect(glowPulse(1000, 500)).toBe(0);
    expect(glowPulse(1000, 1000 + GLOW_PULSE_MS / 2)).toBeCloseTo(1, 6);
    let turns = 0;
    let dir = 0;
    let last = 0;
    let maxChangesPerSecond = 0;
    for (let t = 1000; t <= 1000 + GLOW_PULSE_MS + 1000; t += 10) {
      const v = glowPulse(1000, t);
      const d = Math.sign(v - last);
      if (d !== 0 && dir !== 0 && d !== dir) turns += 1;
      if (d !== 0) dir = d;
      last = v;
    }
    // One peak: the brightness changes direction once in the whole cycle, so at most once per second.
    expect(turns).toBe(1);
    for (let from = 1000; from < 1000 + GLOW_PULSE_MS; from += 100) {
      let changes = 0;
      let d0 = 0;
      let prev = glowPulse(1000, from);
      for (let t = from + 10; t <= from + 1000; t += 10) {
        const v = glowPulse(1000, t);
        const d = Math.sign(v - prev);
        if (d !== 0 && d0 !== 0 && d !== d0) changes += 1;
        if (d !== 0) d0 = d;
        prev = v;
      }
      maxChangesPerSecond = Math.max(maxChangesPerSecond, changes);
    }
    expect(maxChangesPerSecond).toBeLessThanOrEqual(1);
  });

  it('starts when a level rises, not at the first sight, and runs once', () => {
    const { a } = animatorFor(level(0));
    const settled = run(a, 1000, 0);
    expect(settled.frame.rooms[0]!.pulse).toBe(0);
    const up = scene(level(2), FULL);
    a.setModel(up.model);
    let peak = 0;
    let t = settled.time;
    const seen: number[] = [];
    for (let i = 0; i < 400; i++) {
      t += 16;
      const p = a.step(16, t).rooms[0]!.pulse;
      seen.push(p);
      peak = Math.max(peak, p);
    }
    expect(peak).toBeGreaterThan(0.95);
    // After one cycle (2 s) it is over for good.
    expect(seen.slice(-40).every((p) => p === 0)).toBe(true);
    expect(seen.filter((p, i) => p > 0 && (seen[i - 1] ?? 0) === 0)).toHaveLength(1);
  });

  it('never starts a second pulse within a second, so the glow changes at most once per second', () => {
    expect(GLOW_PULSE_GAP_MS).toBeGreaterThanOrEqual(1000);
    const { a } = animatorFor(level(0));
    let t = run(a, 500, 0).time;
    const starts: number[] = [];
    let before = 0;
    for (const lvl of [1, 2, 3] as const) {
      a.setModel(scene(level(lvl), FULL).model);
      for (let i = 0; i < 20; i++) {
        t += 16;
        const p = a.step(16, t).rooms[0]!.pulse;
        if (p > 0 && before === 0) starts.push(t);
        before = p;
      }
    }
    // Three rises within about a second: only the first starts a pulse.
    expect(starts).toHaveLength(1);
  });

  it('does not pulse for a fall, for a dark room, in low quality or with reduced motion', () => {
    for (const [from, to, options] of [
      [3, 1, FULL],
      [2, 4, FULL],
      [0, 2, REDUCED],
      [0, 2, { reducedMotion: false, quality: 'low' as const }],
    ] as const) {
      const { a } = animatorFor(level(from), options);
      let t = run(a, 500, 0).time;
      a.setModel(scene(level(to), options).model);
      let peak = 0;
      for (let i = 0; i < 150; i++) {
        t += 16;
        peak = Math.max(peak, a.step(16, t).rooms[0]!.pulse);
      }
      expect(peak, `${from}->${to}`).toBe(0);
    }
  });
});

describe('what the frame shows for each level', () => {
  it('follows the look table once settled: tint, edge and the danger outline', () => {
    for (const lvl of [0, 1, 2, 3, 4] as const) {
      const { a } = animatorFor(level(lvl));
      const r = run(a, 4000, 0).frame.rooms[0]!;
      const look = LEVEL_LOOK[lvl];
      expect(r.tint).toBeCloseTo(lvl === 4 ? 0 : look.danger, 2);
      expect(r.edge).toBeCloseTo(look.edge, 2);
      expect(r.alarm).toBeCloseTo(look.outline === 'danger' ? look.outlineAlpha : 0, 2);
      expect(r.outlineAlpha).toBeCloseTo(look.outline === 'trim' ? look.outlineAlpha : 0, 2);
      expect(r.light).toBeCloseTo(look.glow, 2);
    }
  });

  it('puts the mist over a room while a Hunt runs and takes it away when it ends', () => {
    const running = [makeService('payments', { hunt: huntOf({ status: 'running', startedAt: NOW - 20_000, stepCount: 2 }) })];
    const ended = [makeService('payments', { hunt: huntOf({ status: 'succeeded', startedAt: NOW - 20_000, finishedAt: NOW - 1000, stepCount: 2 }) })];
    const { a } = animatorFor([makeService('payments', {})]);
    let { frame, time } = run(a, 1000, 0);
    expect(frame.rooms[0]!.mist).toBe(0);
    a.setModel(scene(running, FULL).model);
    ({ frame, time } = run(a, 3000, time));
    expect(frame.rooms[0]!.mist).toBeCloseTo(1, 2);
    a.setModel(scene(ended, FULL).model);
    ({ frame } = run(a, 3000, time));
    expect(frame.rooms[0]!.mist).toBeLessThan(0.01);
  });

  it('keeps the fog layers apart in speed, inside the floor, and shows one in low quality', () => {
    const fogged = [makeService('orders', { hauntLevel: 2, reason: { kind: 'p95', value: 2400 }, metrics: { errorRate: 0.002, p95Ms: 2400, up: 1, at: 'x' } })];
    const full = animatorFor(fogged);
    const low = animatorFor(fogged, { reducedMotion: false, quality: 'low' });
    const f1 = run(full.a, 4000, 0).frame.rooms[0]!;
    const l1 = run(low.a, 4000, 0).frame.rooms[0]!;
    expect(f1.fogLayers.filter((l) => l.alpha > 0.1)).toHaveLength(3);
    expect(l1.fogLayers.filter((l) => l.alpha > 0.1)).toHaveLength(1);
    const track = (a: ReturnType<typeof createAnimator>, from: number) => {
      const xs: number[][] = [[], [], []];
      let t = from;
      for (let i = 0; i < 400; i++) {
        t += 100;
        const r = a.step(100, t).rooms[0]!;
        r.fogLayers.forEach((l, k) => xs[k]!.push(l.x));
      }
      return xs;
    };
    const xs = track(full.a, 4000);
    const travel = xs.map((v) => Math.max(...v) - Math.min(...v));
    expect(new Set(travel.map((n) => n.toFixed(2))).size).toBe(3);
    for (const v of xs) for (const x of v) expect(Math.abs(x)).toBeLessThanOrEqual(0.6);
    // Low quality: the one layer rests no matter how long it runs, the other two are off.
    expect(track(low.a, 4000)[1]!.every((x) => x === 0)).toBe(true);
  });

  it('shifts the sky with the focused room (the camera), fades the roof while a room is focused, and rests in low quality', () => {
    const { a } = animatorFor(house({}));
    let { frame, time } = run(a, 1500, 0);
    expect(frame.roofAlpha).toBeGreaterThan(0.95);
    a.select('gate');
    ({ frame, time } = run(a, 3000, time));
    expect(frame.roofAlpha).toBeCloseTo(ROOF_FOCUSED_ALPHA, 1);
    expect(Math.hypot(frame.parallax.x, frame.parallax.y)).toBeGreaterThan(1);
    expect(Math.abs(frame.parallax.x)).toBeLessThanOrEqual(PARALLAX_PX + 3 + 1e-6);
    a.select(null);
    ({ frame } = run(a, 3000, time));
    expect(frame.roofAlpha).toBeGreaterThan(0.95);

    const lowScene = scene(house({}), { reducedMotion: false, quality: 'low' });
    const b = createAnimator();
    b.setLayout(lowScene.layout);
    b.setModel(lowScene.model);
    b.select('gate');
    const lowFrame = run(b, 3000, 0).frame;
    expect(lowFrame.parallax).toEqual({ x: 0, y: 0 });
  });
});
