import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { SERVICE_NAMES, type HauntLevel, type ServiceState } from '@haunted-ops/shared';
import { ROOMS, serviceStateArb } from '../test/arbs.js';
import { FULL, REDUCED, scene } from '../test/scene-fakes.js';
import { createAnimator } from './animator.js';
import { toSceneModel } from './model.js';

const RUNS = { numRuns: 100 };
const NOW = Date.parse('2026-11-13T15:30:00.000Z');
const LEVELS: HauntLevel[] = [0, 1, 2, 3, 4];

/** The same service at every level, with the same metrics and reason, and `up` healthy (a level 4 is the only dark one). */
const sameAtEveryLevel = (s: ServiceState): ServiceState[] =>
  LEVELS.map((hauntLevel) => ({ ...s, hauntLevel, metrics: s.metrics === null ? null : { ...s.metrics, up: 1 } }));

// Feature: visual-refresh, Property 5
describe('Property 5: the light follows the trouble', () => {
  it('is non-decreasing from calm to possessed, brightest when possessed, and zero for a dark room', () => {
    fc.assert(
      fc.property(serviceStateArb, fc.constantFrom('full' as const, 'low' as const), fc.boolean(), (s, quality, reducedMotion) => {
        const rooms = sameAtEveryLevel(s).map((x) => toSceneModel([x], NOW, { reducedMotion, quality }).rooms[0]!);
        for (let i = 1; i <= 3; i++) {
          expect(rooms[i]!.light).toBeGreaterThanOrEqual(rooms[i - 1]!.light);
          expect(rooms[i]!.look.danger).toBeGreaterThanOrEqual(rooms[i - 1]!.look.danger);
        }
        expect(rooms[0]!.light).toBeGreaterThan(0);
        expect(rooms[3]!.light).toBeGreaterThan(rooms[0]!.light);
        expect(rooms[4]!.dark).toBe(true);
        expect(rooms[4]!.light).toBe(0);
        expect(rooms[4]!.look.danger).toBe(0);
        // The room in trouble is the brightest: no calm or uneasy room outshines a haunted or possessed one.
        expect(Math.max(rooms[0]!.light, rooms[1]!.light)).toBeLessThan(Math.min(rooms[2]!.light, rooms[3]!.light));
      }),
      RUNS,
    );
  });

  it('shows the same order in the frame the Animator draws once it has settled', () => {
    fc.assert(
      fc.property(serviceStateArb, (s) => {
        const lights = sameAtEveryLevel(s).map((x) => {
          const sc = scene([{ ...x, name: 'payments', room: ROOMS.payments }], FULL);
          const a = createAnimator();
          a.setLayout(sc.layout);
          a.setModel(sc.model);
          let frame = a.step(16, 16);
          for (let t = 32; t < 5000; t += 100) frame = a.step(100, t);
          return frame.rooms[0]!.light;
        });
        for (let i = 1; i <= 3; i++) expect(lights[i]!).toBeGreaterThanOrEqual(lights[i - 1]! - 1e-9);
        expect(lights[4]!).toBeLessThan(1e-3);
      }),
      { numRuns: 40 },
    );
  }, 30_000);
});

// Feature: visual-refresh, Property 6
describe('Property 6: reduced motion freezes every animated offset', () => {
  const houseArb = fc
    .tuple(fc.subarray([...SERVICE_NAMES], { minLength: 1 }), fc.array(serviceStateArb, { minLength: 4, maxLength: 4 }))
    .map(([names, states]) => names.map((name, i) => ({ ...states[i]!, name, room: ROOMS[name] })));

  it('has zero sway, drift, parallax, dust and pulse for any time, and the same picture at any two times', () => {
    fc.assert(
      fc.property(houseArb, fc.array(fc.integer({ min: 1, max: 600_000 }), { minLength: 2, maxLength: 4 }), fc.option(fc.constantFrom(...SERVICE_NAMES), { nil: null }), (services, times, selected) => {
        const sc = scene(services, REDUCED);
        const a = createAnimator();
        a.setLayout(sc.layout);
        a.setModel(sc.model);
        a.select(selected);
        // Let the (instant) transitions land, then look at later times.
        for (let i = 0; i < 4; i++) a.step(100, 100 * (i + 1));
        const snapshot: number[][] = [];
        for (const t of times.map((n) => 1000 + n)) {
          const f = a.step(16, t);
          expect(f.parallax).toEqual({ x: 0, y: 0 });
          expect(f.motes.count).toBe(0);
          for (const r of f.rooms) {
            expect(r.pulse).toBe(0);
            expect(r.mistX).toBe(0);
            expect(r.mistY).toBe(0);
            expect(r.flicker).toBe(1);
            expect([r.shakeX, r.shakeY]).toEqual([0, 0]);
            for (const l of r.fogLayers) expect([l.x, l.y]).toEqual([0, 0]);
          }
          for (const buf of [f.ghosts, f.fog, f.fogBank]) for (let i = 0; i < buf.count; i++) expect(buf.rotation[i]).toBe(0);
          snapshot.push([f.roofAlpha, ...f.rooms.flatMap((r) => [r.tint, r.edge, r.alarm, r.mist, ...r.fogLayers.map((l) => l.alpha)]), ...Array.from(f.ghosts.x.slice(0, f.ghosts.count)), ...Array.from(f.ghosts.y.slice(0, f.ghosts.count))]);
        }
        for (const s of snapshot) expect(s).toEqual(snapshot[0]);
      }),
      RUNS,
    );
  }, 30_000);
});
