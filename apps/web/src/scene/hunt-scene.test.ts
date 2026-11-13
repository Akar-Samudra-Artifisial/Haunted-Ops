import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { validateHuntSummary, validateServiceStates, type ServiceState } from '@haunted-ops/shared';
import { makeService } from '../test/arbs.js';
import { insideConvex, insideDiamond, rectCorners, rectGap } from '../test/geometry.js';
import { huntOf, huntSummaryArb } from '../test/hunt-arbs.js';
import { FULL, NOW, REDUCED, house, scene } from '../test/scene-fakes.js';
import { FIGURE_H, FIGURE_W, computeLayout } from './layout.js';
import { createAnimator, PULSE_GAP_MS, SEAL_MS } from './animator.js';
import { DEMO_DURATION_MS, demoHunt, demoServices, scenarioServices } from './demo.js';
import { ENTER_MS, FIGURE_LINGER_MS, MAX_MARKS, huntVisual, toSceneModel } from './model.js';
import { DEMO_SCENARIOS, parseDemoParam } from './params.js';
import { buildRoomArt } from './shapes.js';

const withHunt = (hunt: ServiceState['hunt']): ServiceState[] => house({ payments: { hauntLevel: 3, reason: { kind: 'error_rate', value: 0.4 }, hunt } });

describe('huntVisual', () => {
  it('has nothing without a Hunt', () => {
    expect(huntVisual(null, NOW)).toBeNull();
    expect(toSceneModel(house(), NOW, FULL).rooms.every((r) => r.hunt === null)).toBe(true);
  });

  it('shows a queued Hunt with no figure and no marks', () => {
    expect(huntVisual(huntOf({ status: 'queued' }), NOW)).toMatchObject({ phase: 'queued', figure: false, marks: 0, result: 'none', label: 'queued' });
  });

  it('walks in for 1.2 s, then works, with at most 8 marks', () => {
    const at = (ago: number) => huntVisual(huntOf({ status: 'running', startedAt: NOW - ago, stepCount: 12 }), NOW);
    expect(at(ENTER_MS - 1)).toMatchObject({ phase: 'entering', figure: true, marks: MAX_MARKS });
    expect(at(ENTER_MS)).toMatchObject({ phase: 'working', figure: true, marks: MAX_MARKS });
    expect(huntVisual(huntOf({ status: 'running', startedAt: NOW - 5000, stepCount: 3 }), NOW)?.marks).toBe(3);
    expect(huntVisual(huntOf({ status: 'running', startedAt: NOW - 5000, stepCount: 3 }), NOW)?.label).toBe('running: step 3, errors');
  });

  it('keeps the figure for 8 s after the end, and the result mark for good', () => {
    const sealed = (ago: number) => huntVisual(huntOf({ status: 'succeeded', startedAt: NOW - 60_000, finishedAt: NOW - ago, stepCount: 6 }), NOW);
    expect(sealed(FIGURE_LINGER_MS - 1)).toMatchObject({ phase: 'sealed', figure: true, result: 'sealed' });
    expect(sealed(FIGURE_LINGER_MS)).toMatchObject({ phase: 'sealed', figure: false, result: 'sealed' });
    const failed = huntVisual(huntOf({ status: 'failed', reason: 'credit_cap', startedAt: NOW - 60_000, finishedAt: NOW - 1000, stepCount: 2 }), NOW);
    expect(failed).toMatchObject({ phase: 'fizzled', figure: true, result: 'failed', label: 'failed: credit cap reached' });
  });

  it('shows a request that was cancelled before it started as a failed mark with no figure', () => {
    const v = huntVisual(huntOf({ status: 'cancelled', reason: 'busy', finishedAt: NOW - 1000 }), NOW);
    expect(v).toMatchObject({ phase: 'fizzled', figure: false, result: 'failed', marks: 0 });
  });

  it('is pure and bounded for any summary and time', () => {
    fc.assert(
      fc.property(huntSummaryArb, fc.integer({ min: 0, max: 400_000 }), (h, dt) => {
        const now = Date.parse(h.queuedAt) + dt;
        const v = huntVisual(h, now);
        expect(huntVisual(h, now)).toEqual(v);
        if (v !== null) {
          expect(v.marks).toBeGreaterThanOrEqual(0);
          expect(v.marks).toBeLessThanOrEqual(MAX_MARKS);
          expect(v.label.length).toBeGreaterThan(0);
          if (h.status === 'queued') expect(v.figure).toBe(false);
          if (v.figure) expect(h.startedAt).not.toBeNull();
        }
      }),
    );
  });

  it('adds the hunt sentence to the room summary', () => {
    const m = toSceneModel(withHunt(huntOf({ status: 'running', startedAt: NOW - 5000, stepCount: 3 })), NOW, FULL);
    expect(m.rooms.find((r) => r.name === 'payments')?.summary).toContain('hunt running: step 3, errors');
    expect(m.summary).toContain('hunt running: step 3, errors');
  });
});

describe('demo hunt', () => {
  it('follows the script: queued 9 s, started 10 s, steps 12 to 24 s, diagnosis 26 s', () => {
    expect(demoHunt(8, 0)).toBeNull();
    expect(demoHunt(9, 0)?.status).toBe('queued');
    expect(demoHunt(10, 0)).toMatchObject({ status: 'running', stepCount: 0 });
    const counts = [12, 15, 18, 21, 24].map((s) => demoHunt(s, 0)?.stepCount);
    expect(counts).toEqual([1, 2, 3, 4, 5]);
    expect(demoHunt(25, 0)?.status).toBe('running');
    expect(demoHunt(26, 0)).toMatchObject({ status: 'succeeded', reason: 'diagnosed', diagnosis: { culpritDeploy: 'd-7' } });
    expect(demoHunt(47, 0)?.status).toBe('succeeded');
  });

  it('passes the Shared validators in the timeline and in every scenario', () => {
    for (let s = 0; s < DEMO_DURATION_MS / 1000; s++) {
      const states = demoServices(s * 1000);
      expect(validateServiceStates(states).ok, `second ${s}`).toBe(true);
      expect(states.filter((x) => x.hunt !== null).map((x) => x.name)).toEqual(s >= 9 ? ['payments'] : []);
    }
    for (const name of DEMO_SCENARIOS) {
      const states = scenarioServices(name);
      expect(validateServiceStates(states).ok, name).toBe(true);
      expect(states.every((x) => x.hunt === null || validateHuntSummary(x.hunt).ok)).toBe(true);
    }
  });

  it('has the three hunt scenarios, frozen and parsed from the URL', () => {
    const phase = (name: (typeof DEMO_SCENARIOS)[number]) => scenarioServices(name).find((s) => s.name === 'payments')?.hunt;
    expect(phase('payments-hunting')).toMatchObject({ status: 'running', stepCount: 3 });
    expect(phase('payments-sealed')).toMatchObject({ status: 'succeeded' });
    expect(phase('payments-fizzled')).toMatchObject({ status: 'failed', reason: 'credit_cap' });
    expect(parseDemoParam('?demo=payments-sealed', { PROD: false })).toEqual({ kind: 'scenario', name: 'payments-sealed' });
    expect(scenarioServices('payments-hunting')).toEqual(scenarioServices('payments-hunting'));
  });

  it('counts the Hunt times from the epoch it is given', () => {
    const a = demoHunt(18, 1_000_000);
    expect(a?.startedAt).toBe(new Date(1_010_000).toISOString());
  });
});

// Feature: exorcist-agent, Property 13
describe('Property 13: the Exorcist figure fits its room for every gallery size', () => {
  const SIZES = [
    { width: 360, height: 800 },
    { width: 1280, height: 720 },
    { width: 3840, height: 2160 },
  ];
  const rooms = house().map((s) => ({ name: s.name, grid: s.room }));

  it('is inside the room, right of every text box, clear of the clock and the Hunt slot', () => {
    for (const size of SIZES) {
      const layout = computeLayout(rooms, { ...size, dpr: 1 });
      for (const r of layout.rooms) {
        const eps = 1e-6;
        const box = r.exorcistBox;
        for (const c of rectCorners(box)) expect(insideConvex(r.silhouette, c), `${size.width} ${r.name}`).toBeGreaterThanOrEqual(-eps);
        expect(insideDiamond(r.floor, r.exorcistAt)).toBeGreaterThanOrEqual(-eps);
        expect(box.w).toBeCloseTo(FIGURE_W * layout.scale);
        expect(box.h).toBeCloseTo(FIGURE_H * layout.scale);
        for (const text of [r.labelBox, r.badgeBox, r.incidentBox, r.huntRect]) expect(rectGap(box, text), `${size.width} ${r.name}`).toBeGreaterThan(0);
        const clock = buildRoomArt(r, layout.scale).clock;
        const nearestX = Math.min(Math.max(clock.center.x, box.x), box.x + box.w);
        const nearestY = Math.min(Math.max(clock.center.y, box.y), box.y + box.h);
        expect(Math.hypot(clock.center.x - nearestX, clock.center.y - nearestY), `${size.width} clock`).toBeGreaterThan(clock.radius);
        // The feet are at the bottom middle of the box.
        expect(r.exorcistAt.y).toBeCloseTo(box.y + box.h);
        expect(r.exorcistAt.x).toBeCloseTo(box.x + box.w / 2);
      }
    }
  });

  it('is computed the same way every time and stays inside the room for any viewport that keeps the labels at full size', () => {
    fc.assert(
      fc.property(fc.integer({ min: 640, max: 3840 }), fc.integer({ min: 480, max: 2160 }), (width, height) => {
        const layout = computeLayout(rooms, { width, height, dpr: 1 });
        expect(computeLayout(rooms, { width, height, dpr: 1 })).toEqual(layout);
        for (const r of layout.rooms) {
          for (const c of rectCorners(r.exorcistBox)) expect(insideConvex(r.silhouette, c)).toBeGreaterThanOrEqual(-1e-6);
          for (const text of [r.labelBox, r.badgeBox, r.incidentBox]) expect(rectGap(r.exorcistBox, text)).toBeGreaterThan(0);
        }
      }),
      { numRuns: 120 },
    );
  });
});

describe('Animator: the Hunt', () => {
  const run = (services: ServiceState[], options = FULL) => {
    const s = scene(services, options);
    const a = createAnimator();
    a.setLayout(s.layout);
    a.setModel(s.model);
    return a;
  };
  const hunt = (a: ReturnType<typeof run>) => a.step(0, 0).rooms.find((r) => r.name === 'payments')!.hunt;
  const running = (steps: number) => withHunt(huntOf({ status: 'running', startedAt: NOW - 5000, stepCount: steps }));

  it('walks the figure in over 1.2 s from the moment it first sees the Hunt', () => {
    const a = run(running(0));
    const room = () => a.step(0, 0).rooms.find((r) => r.name === 'payments')!.hunt;
    let t = 0;
    const walks: number[] = [];
    for (let i = 0; i <= 14; i++) {
      a.step(100, t);
      walks.push(a.step(0, t).rooms.find((r) => r.name === 'payments')!.hunt.walk);
      t += 100;
    }
    expect(walks[0]).toBe(0);
    expect(walks[6]).toBeGreaterThan(0.3);
    expect(walks[6]).toBeLessThan(0.7);
    expect(walks.at(-1)).toBe(1);
    expect(walks).toEqual([...walks].sort((x, y) => x - y));
    expect(room().marks).toBe(0);
  });

  it('lights one lantern pulse per step, never more than 3 per second', () => {
    const services = (n: number) => running(n);
    const s0 = scene(services(0));
    const a = createAnimator();
    a.setLayout(s0.layout);
    a.setModel(s0.model);
    let t = 0;
    for (let i = 0; i < 20; i++) {
      a.step(16, t);
      t += 16;
    }
    const peaks: number[] = [];
    let steps = 0;
    for (let i = 0; i < 125; i++) {
      // A new step every 100 ms for 1 s, then quiet.
      if (i % 6 === 0 && steps < 10) {
        steps += 1;
        a.setModel(scene(services(steps)).model);
      }
      const f = a.step(16, t).rooms.find((r) => r.name === 'payments')!.hunt;
      if (f.lantern > 0.99) peaks.push(t);
      t += 16;
    }
    // Pulses (full brightness) are at least PULSE_GAP_MS apart.
    const distinct = peaks.filter((p, i) => i === 0 || p - (peaks[i - 1] as number) > PULSE_GAP_MS - 1);
    expect(distinct.length).toBeGreaterThan(0);
    const starts: number[] = [];
    for (const p of peaks) if (starts.length === 0 || p - (starts.at(-1) as number) >= PULSE_GAP_MS - 20) starts.push(p);
    for (let i = 3; i < starts.length; i++) expect((starts[i] as number) - (starts[i - 3] as number)).toBeGreaterThanOrEqual(1000 - 60);
    expect(steps).toBe(10);
  });

  it('closes the seal over 0.8 s when the diagnosis arrives, and shows it done when first seen', () => {
    const a = run(running(5));
    for (let t = 0; t < 500; t += 16) a.step(16, t);
    a.setModel(scene(withHunt(huntOf({ status: 'succeeded', startedAt: NOW - 5000, finishedAt: NOW - 100, stepCount: 6 }))).model);
    let t = 500;
    const seals: number[] = [];
    while (t < 500 + SEAL_MS + 200) {
      seals.push(a.step(16, t).rooms.find((r) => r.name === 'payments')!.hunt.seal);
      t += 16;
    }
    expect(seals[0]).toBeLessThan(0.1);
    expect(seals.at(-1)).toBe(1);
    expect(seals).toEqual([...seals].sort((x, y) => x - y));
    const late = run(withHunt(huntOf({ status: 'succeeded', startedAt: NOW - 5000, finishedAt: NOW - 100, stepCount: 6 })));
    expect(late.step(16, 0).rooms.find((r) => r.name === 'payments')!.hunt.seal).toBe(1);
  });

  it('dims the lantern out and falls sparks on a failure, then shows no sparks', () => {
    const a = run(running(2));
    for (let t = 0; t < 300; t += 16) a.step(16, t);
    a.setModel(scene(withHunt(huntOf({ status: 'failed', reason: 'credit_cap', startedAt: NOW - 5000, finishedAt: NOW - 100, stepCount: 2 }))).model);
    let t = 300;
    const frames: Array<{ lantern: number; sparks: number; fizzle: number }> = [];
    for (let i = 0; i < 80; i++) {
      const f = a.step(16, t).rooms.find((r) => r.name === 'payments')!.hunt;
      frames.push({ lantern: f.lantern, sparks: f.sparks, fizzle: f.fizzle });
      t += 16;
    }
    expect(frames[2]!.sparks).toBeGreaterThan(0);
    expect(frames.at(-1)).toMatchObject({ lantern: 0, sparks: 0, fizzle: 1 });
    expect(Math.max(...frames.map((f) => f.lantern))).toBeLessThanOrEqual(1);
  });

  it('shows final states at once with reduced motion: no walk, no pulse, the seal done', () => {
    const a = run(withHunt(huntOf({ status: 'succeeded', startedAt: NOW - 5000, finishedAt: NOW - 100, stepCount: 6 })), REDUCED);
    const f = hunt(a);
    expect(f).toMatchObject({ walk: 1, seal: 1, marks: 6, result: 'sealed', figure: 1, sparks: 0 });
    const b = run(running(4), REDUCED);
    expect(hunt(b)).toMatchObject({ walk: 1, marks: 4, lantern: 0.6, seal: 0, fizzle: 0 });
    const c = run(withHunt(huntOf({ status: 'failed', startedAt: NOW - 5000, finishedAt: NOW - 100, stepCount: 2 })), REDUCED);
    expect(hunt(c)).toMatchObject({ fizzle: 1, sparks: 0, lantern: 0, result: 'failed' });
  });

  it('stops moving once everything has settled', () => {
    const a = run(withHunt(huntOf({ status: 'succeeded', startedAt: NOW - 50_000, finishedAt: NOW - 20_000, stepCount: 6 })), REDUCED);
    a.step(16, 0);
    expect(a.step(16, 16).moving).toBe(false);
  });

  it('has no figure in a room without a Hunt', () => {
    const a = run(house());
    for (const r of a.step(16, 0).rooms) expect(r.hunt).toMatchObject({ figure: 0, marks: 0, result: 'none' });
    expect(makeService('gate').hunt).toBeNull();
  });
});
