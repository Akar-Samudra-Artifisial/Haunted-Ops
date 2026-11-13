import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { makeService } from '../test/arbs.js';
import { FULL, REDUCED, house, scene } from '../test/scene-fakes.js';
import { DARK_DIM, MAX_STEP_MS, createAnimator, valueNoise, visibleParticles } from './animator.js';
import { PerfGovernor } from './governor.js';
import { PARTICLE_CAP } from './particles.js';
import type { Frame } from './surface.js';

const metrics = (errorRate: number | null, p95Ms: number | null, up: number | null) => ({ errorRate, p95Ms, up, at: 'x' });

function run(a: ReturnType<typeof createAnimator>, ms: number, from = 0, dt = 16): { frame: Frame; time: number } {
  let t = from;
  let frame!: Frame;
  for (let e = 0; e < ms; e += dt) {
    t += dt;
    frame = a.step(dt, t);
  }
  return { frame, time: t };
}

function animator(services = house(), options = FULL) {
  const { model, layout } = scene(services, options);
  const a = createAnimator();
  a.setLayout(layout);
  a.setModel(model);
  return { a, layout };
}

describe('Animator transitions', () => {
  it('moves toward a dark room by about 95 percent in one second and never overshoots', () => {
    const calm = scene(house());
    const dark = scene(house({ ledger: { hauntLevel: 4, metrics: metrics(null, null, 0) } }));
    const a = createAnimator();
    a.setLayout(calm.layout);
    a.setModel(calm.model);
    run(a, 500);
    a.setModel(dark.model);
    let last = 0;
    let t = 500;
    let frame!: Frame;
    for (let i = 0; i < 62; i++) {
      t += 16;
      frame = a.step(16, t);
      const dim = frame.rooms.find((r) => r.name === 'ledger')!.dim;
      expect(dim).toBeGreaterThanOrEqual(last - 1e-9);
      expect(dim).toBeLessThanOrEqual(DARK_DIM);
      last = dim;
    }
    expect(last).toBeGreaterThan(0.85);
    expect(last).toBeLessThan(DARK_DIM + 1e-9);
  });

  it('fades ghosts in one by one as the count rises, and out again', () => {
    const calm = scene(house({ payments: { hauntLevel: 2 } }));
    const haunted = scene(house({ payments: { hauntLevel: 2, metrics: metrics(0.5, 100, 1) } }));
    const a = createAnimator();
    a.setLayout(calm.layout);
    a.setModel(calm.model);
    run(a, 300);
    a.setModel(haunted.model);
    const early = run(a, 100, 300).frame;
    // Slots appear in index order: the first is clearer than the last while they fade in.
    expect(early.ghosts.count).toBe(12);
    expect(early.ghosts.alpha[0]!).toBeGreaterThan(early.ghosts.alpha[11]!);
    const settled = run(a, 4000, 400);
    expect(settled.frame.ghosts.alpha[11]!).toBeGreaterThan(0.8);
    expect(settled.frame.ghosts.alpha[0]!).toBeCloseTo(settled.frame.ghosts.alpha[11]!, 2);
    // Slots leave in reverse order: the last goes first.
    a.setModel(calm.model);
    const leaving = run(a, 400, settled.time);
    expect(leaving.frame.ghosts.alpha[0]!).toBeGreaterThan(leaving.frame.ghosts.alpha[11]!);
    const out = run(a, 8000, leaving.time).frame;
    expect(out.ghosts.count).toBe(0);
  });

  it('draws no ghosts, fog or motes in a dark room', () => {
    const { a } = animator(house({ ledger: { hauntLevel: 4, metrics: metrics(0.5, 3000, 0) } }).slice(3));
    const frame = run(a, 3000).frame;
    expect(frame.ghosts.count + frame.fog.count + frame.fogBank.count + frame.motes.count).toBe(0);
    expect(frame.rooms[0]).toMatchObject({ dark: true });
    expect(frame.rooms[0]!.light).toBe(0);
    expect(frame.rooms[0]!.outlineAlpha).toBeGreaterThan(0.95);
  });

  it('shows ghosts for errors and fog for latency in lit rooms', () => {
    const { a } = animator([makeService('payments', { hauntLevel: 2, metrics: metrics(0.4, 2500, 1) })]);
    const frame = run(a, 3000).frame;
    expect(frame.ghosts.count).toBeGreaterThan(5);
    expect(frame.fog.count + frame.fogBank.count).toBeGreaterThan(5);
    expect(frame.ghosts.alpha[0]).toBeGreaterThan(0.3);
  });

  it('draws thick fog in two layers at level 2: a low bank on the floor and wisps above it', () => {
    // Like ?demo=orders-fog: p95 2.4 s, level 2, reason p95.
    const { a, layout } = animator([makeService('orders', { hauntLevel: 2, reason: { kind: 'p95', value: 2400 }, metrics: metrics(0.002, 2400, 1) })]);
    const frame = run(a, 4000).frame;
    expect(frame.fogBank.count).toBeGreaterThanOrEqual(6);
    expect(frame.fog.count).toBeGreaterThanOrEqual(6);
    const alphas = (b: Frame['fog']) => Array.from(b.alpha.slice(0, b.count));
    expect(Math.min(...alphas(frame.fogBank))).toBeGreaterThan(0.6);
    expect(Math.min(...alphas(frame.fog))).toBeGreaterThan(0.5);
    // The bank hugs the floor; the wisps float higher on average.
    const room = layout.rooms[0]!;
    const meanY = (b: Frame['fog']) => alphas(b).reduce((n, _, i) => n + b.y[i]!, 0) / b.count;
    expect(meanY(frame.fogBank)).toBeGreaterThan(meanY(frame.fog));
    for (let i = 0; i < frame.fogBank.count; i++) {
      expect(frame.fogBank.y[i]!).toBeGreaterThanOrEqual(room.floor[0].y);
      expect(frame.fogBank.y[i]!).toBeLessThanOrEqual(room.floor[2].y);
    }
  });

  it('keeps fog visible and still with reduced motion', () => {
    const { a } = animator([makeService('orders', { hauntLevel: 2, reason: { kind: 'p95', value: 2400 }, metrics: metrics(0.002, 2400, 1) })], REDUCED);
    const first = a.step(16, 1000);
    const bank = Array.from(first.fogBank.x.slice(0, first.fogBank.count));
    const wisps = Array.from(first.fog.y.slice(0, first.fog.count));
    expect(bank.length).toBeGreaterThan(0);
    expect(first.fogBank.alpha[0]).toBeGreaterThan(0.5);
    const later = a.step(16, 9000);
    expect(Array.from(later.fogBank.x.slice(0, later.fogBank.count))).toEqual(bank);
    expect(Array.from(later.fog.y.slice(0, later.fog.count))).toEqual(wisps);
  });

  it.each([
    [360, 300],
    [1280, 504],
    [3840, 2160],
  ])('keeps the ghost feet above every text pill of their room at %i by %i', (width, height) => {
    for (const name of ['gate', 'orders', 'payments', 'ledger'] as const) {
      const services = house({ [name]: { hauntLevel: 3, metrics: metrics(0.5, 100, 1) } });
      const { model, layout } = scene(services, FULL, { width, height, dpr: 1 });
      const a = createAnimator();
      a.setLayout(layout);
      a.setModel(model);
      const room = layout.rooms.find((r) => r.name === name)!;
      for (let t = 16; t < 6000; t += 48) {
        const f = a.step(48, t);
        expect(f.ghosts.count).toBeGreaterThan(0);
        for (let i = 0; i < f.ghosts.count; i++) {
          // The ghost sprite is anchored at its feet: everything of it is above this line.
          expect(f.ghosts.y[i]!).toBeLessThanOrEqual(room.textTop);
          expect(f.ghosts.y[i]!).toBeLessThan(room.labelBox.y);
        }
      }
    }
  });
});

describe('Animator motion', () => {
  it('flickers and trembles at level 3 and not at level 0', () => {
    const level3 = animator([makeService('payments', { hauntLevel: 3 })]).a;
    const calm = animator([makeService('payments', { hauntLevel: 0 })]).a;
    let minFlicker = 1;
    let maxShake = 0;
    for (let t = 0; t < 4000; t += 16) {
      const f = level3.step(16, t).rooms[0]!;
      minFlicker = Math.min(minFlicker, f.flicker);
      maxShake = Math.max(maxShake, Math.abs(f.shakeX));
    }
    expect(minFlicker).toBeLessThan(0.9);
    expect(maxShake).toBeGreaterThan(0);
    const c = calm.step(16, 1000).rooms[0]!;
    expect([c.flicker, c.shakeX, c.shakeY]).toEqual([1, 0, 0]);
  });

  it('changes brightness direction at most 3 times per second', () => {
    const a = animator([makeService('payments', { hauntLevel: 3 })]).a;
    const values: number[] = [];
    for (let t = 0; t < 10_000; t += 16) values.push(a.step(16, t).rooms[0]!.flicker);
    let turns = 0;
    let dir = 0;
    for (let i = 1; i < values.length; i++) {
      const d = Math.sign(values[i]! - values[i - 1]!);
      if (d !== 0 && dir !== 0 && d !== dir) turns += 1;
      if (d !== 0) dir = d;
    }
    expect(turns / 10).toBeLessThanOrEqual(3);
    expect(valueNoise(5, 2.5, 1)).toBeGreaterThanOrEqual(0);
  });

  it('is still with reduced motion: same wisps at every time, no flicker, no shake, no frame to draw after the transition', () => {
    const services = [makeService('payments', { hauntLevel: 3, metrics: metrics(0.4, 2500, 1) }), makeService('orders')];
    const { a } = animator(services, REDUCED);
    const first = a.step(16, 1000);
    const xs = Array.from(first.ghosts.x.slice(0, first.ghosts.count));
    const second = a.step(16, 9000);
    expect(Array.from(second.ghosts.x.slice(0, second.ghosts.count))).toEqual(xs);
    expect(second.rooms.every((r) => r.flicker === 1 && r.shakeX === 0 && r.shakeY === 0 && r.lampBreath === 0.5)).toBe(true);
    expect(second.moving).toBe(false);
    expect(second.ghosts.count).toBeGreaterThan(0);
  });

  it('keeps moving without reduced motion (lamp, motes, pulses)', () => {
    const { a } = animator();
    expect(run(a, 3000).frame.moving).toBe(true);
  });

  it('returns the same Frame and the same arrays every step', () => {
    const { a } = animator();
    const f1 = a.step(16, 16);
    const arrays = [f1.ghosts.x, f1.fog.alpha, f1.motes.y, f1.pulses.size];
    const f2 = a.step(16, 32);
    expect(f2).toBe(f1);
    expect([f2.ghosts.x, f2.fog.alpha, f2.motes.y, f2.pulses.size]).toEqual(arrays);
    expect(f2.ghosts.x).toBe(arrays[0]);
  });

  it('limits a step to 100 ms', () => {
    const { a } = animator();
    const slow = createAnimator();
    const calm = scene(house());
    const dark = scene(house({ ledger: { hauntLevel: 4 } }));
    for (const x of [a, slow]) {
      x.setLayout(calm.layout);
      x.setModel(calm.model);
    }
    a.step(16, 16);
    slow.step(16, 16);
    a.setModel(dark.model);
    slow.setModel(dark.model);
    const big = a.step(60_000, 60_016).rooms.find((r) => r.name === 'ledger')!.dim;
    const capped = slow.step(MAX_STEP_MS, 116).rooms.find((r) => r.name === 'ledger')!.dim;
    expect(big).toBeCloseTo(capped, 6);
    expect(big).toBeLessThan(DARK_DIM);
  });

  it('shows corridor pulses when the rooms are lit and none when one is dark', () => {
    const lit = animator();
    const frame = run(lit.a, 2000).frame;
    expect(frame.pulses.count).toBe(9);
    expect(frame.corridors.every((c) => c.lit > 0.9)).toBe(true);
    const dark = animator(house({ orders: { hauntLevel: 4 }, payments: { hauntLevel: 4 } }));
    const dim = run(dark.a, 3000).frame;
    expect(dim.corridors.map((c) => c.lit > 0.01)).toEqual([false, false, false]);
    expect(dim.pulses.count).toBe(0);
  });

  it('keeps the total of particles at the cap for a house of nine rooms', () => {
    const nine = Array.from({ length: 9 }, (_, i) =>
      makeService('payments', { room: { x: i % 3, y: Math.floor(i / 3) }, hauntLevel: 2, metrics: metrics(0.5, 3000, 1) }),
    );
    const { a } = animator(nine);
    for (let t = 16; t < 5000; t += 16) {
      const f = a.step(16, t);
      expect(visibleParticles(f)).toBeLessThanOrEqual(PARTICLE_CAP);
    }
  });

  it('enforces the cap without allocating (no array literal in the hot path)', () => {
    // The cap is enforced by `trim`, which only changes counts. A source check keeps it that way.
    const text = readFileSync('src/scene/animator.ts', 'utf8');
    const body = text.slice(text.indexOf('function enforceCap'), text.indexOf('return {', text.indexOf('function enforceCap')));
    expect(body).not.toMatch(/\[\s*frame\./);
    expect(body).not.toMatch(/new |\.map\(|\.filter\(|Array\.from/);
  });
});

describe('PerfGovernor', () => {
  const feed = (g: PerfGovernor, frameMs: number, seconds: number): void => {
    for (let t = 0; t < seconds * 1000; t += frameMs) g.push(frameMs);
  };

  it('goes to low power after 2 s above 20 ms, not before', () => {
    const slow = new PerfGovernor();
    feed(slow, 25, 1.4);
    expect(slow.quality).toBe('full');
    feed(slow, 25, 1.2);
    expect(slow.quality).toBe('low');
  });

  it('ignores a single slow frame and a mix that averages under 20 ms', () => {
    const g = new PerfGovernor();
    g.push(400);
    feed(g, 16, 3);
    expect(g.quality).toBe('full');
    for (let i = 0; i < 200; i++) g.push(i % 2 === 0 ? 30 : 8);
    expect(g.quality).toBe('full');
  });

  it('comes back only after 10 s under 14 ms', () => {
    const g = new PerfGovernor();
    feed(g, 30, 3);
    expect(g.quality).toBe('low');
    feed(g, 10, 8);
    expect(g.quality).toBe('low');
    feed(g, 10, 3);
    expect(g.quality).toBe('full');
  });

  it('does not come back while the frame time is between 14 and 20 ms', () => {
    const g = new PerfGovernor();
    feed(g, 30, 3);
    feed(g, 17, 30);
    expect(g.quality).toBe('low');
  });
});
