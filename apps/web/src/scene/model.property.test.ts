import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { HauntLevel, ServiceState } from '@haunted-ops/shared';
import { levelArb, nameArb, p95Arb, reasonArb, serviceStateArb, servicesArb, errorRateArb, upArb } from '../test/arbs.js';
import { approach } from './math.js';
import {
  FOG_BANK_MAX,
  FOG_MAX,
  FOG_WISP_MAX,
  GHOST_BACK_LIMIT,
  GHOST_MAX,
  MOTE_MAX,
  PARTICLE_CAP,
  allocateParticles,
  fogBankSpec,
  fogSpec,
  ghostSpec,
  splitFog,
  type RoomCounts,
} from './particles.js';
import { isDark, toSceneModel, type ModelOptions, type RoomVisual } from './model.js';

const RUNS = { numRuns: 150 };
const NOW = Date.parse('2026-11-13T15:30:00.000Z');
const optionsArb: fc.Arbitrary<ModelOptions> = fc.record({
  reducedMotion: fc.boolean(),
  quality: fc.constantFrom('full' as const, 'low' as const),
});
const FULL: ModelOptions = { reducedMotion: false, quality: 'full' };
const one = (s: ServiceState, o: ModelOptions = FULL): RoomVisual => toSceneModel([s], NOW, o).rooms[0]!;

/** A state plus a second one that is no better in level, error ratio and p95 (same reason and up). */
const worsePair = fc
  .tuple(serviceStateArb, levelArb, fc.double({ min: 0, max: 3, noNaN: true }), fc.double({ min: 0, max: 9000, noNaN: true }))
  .map(([a, level, dErr, dP95]): [ServiceState, ServiceState] => {
    const higher = Math.max(a.hauntLevel, level) as HauntLevel;
    const metrics = a.metrics
      ? {
          ...a.metrics,
          errorRate: a.metrics.errorRate === null ? null : a.metrics.errorRate + dErr,
          p95Ms: a.metrics.p95Ms === null ? null : a.metrics.p95Ms + dP95,
        }
      : null;
    return [a, { ...a, hauntLevel: higher, metrics }];
  });

// Feature: scene-engine, Property 1
describe('Property 1: the model is monotonic', () => {
  it('a higher level, error ratio or p95 never gives less of a ghost or fog, or more light', () => {
    fc.assert(
      fc.property(worsePair, optionsArb, ([a, b], options) => {
        const ra = one(a, options);
        const rb = one(b, options);
        expect(rb.ghostCount).toBeGreaterThanOrEqual(ra.ghostCount);
        expect(rb.ghostOpacity).toBeGreaterThanOrEqual(ra.ghostOpacity - 1e-12);
        expect(rb.fogDensity).toBeGreaterThanOrEqual(ra.fogDensity - 1e-12);
        expect(rb.fogCount).toBeGreaterThanOrEqual(ra.fogCount);
        expect(rb.light).toBeLessThanOrEqual(ra.light + 1e-12);
      }),
      RUNS,
    );
  });

  it('holds for one Room inside a house of up to 5 Rooms, where the total cap is never reached (5 x 32 = 160)', () => {
    fc.assert(
      fc.property(servicesArb(4), worsePair, (others, [a, b]) => {
        const before = toSceneModel([...others, a], NOW, FULL).rooms.at(-1)!;
        const after = toSceneModel([...others, b], NOW, FULL).rooms.at(-1)!;
        expect(after.ghostCount).toBeGreaterThanOrEqual(before.ghostCount);
        expect(after.fogCount).toBeGreaterThanOrEqual(before.fogCount);
        expect(after.light).toBeLessThanOrEqual(before.light + 1e-12);
      }),
      RUNS,
    );
  });
});

// Feature: scene-engine, Property 2
describe('Property 2: caps hold for any input', () => {
  it('keeps per-room caps and the total at 200', () => {
    fc.assert(
      fc.property(servicesArb(9), optionsArb, (services, options) => {
        const model = toSceneModel(services, NOW, options);
        let roomSum = 0;
        for (const r of model.rooms) {
          expect(r.ghostCount).toBeGreaterThanOrEqual(0);
          expect(r.ghostCount).toBeLessThanOrEqual(GHOST_MAX);
          expect(r.fogCount).toBeLessThanOrEqual(FOG_MAX);
          expect(r.moteCount).toBeLessThanOrEqual(MOTE_MAX);
          roomSum += r.ghostCount + r.fogCount + r.moteCount;
        }
        expect(model.particles.total).toBeLessThanOrEqual(PARTICLE_CAP);
        expect(model.particles.total).toBeLessThanOrEqual(model.particles.wanted);
        expect(model.particles.total).toBeGreaterThanOrEqual(roomSum);
        if (!model.particles.trimmed) expect(model.particles.total).toBe(model.particles.wanted);
      }),
      RUNS,
    );
  });

  const countsArb: fc.Arbitrary<RoomCounts[]> = fc.array(
    fc.record({
      level: levelArb,
      ghosts: fc.integer({ min: 0, max: GHOST_MAX }),
      fog: fc.integer({ min: 0, max: FOG_MAX }),
      motes: fc.integer({ min: 0, max: MOTE_MAX }),
    }),
    { maxLength: 9 },
  );

  it('the allocator never grows a count, fits the budget, and trims in the documented order', () => {
    fc.assert(
      fc.property(countsArb, fc.integer({ min: 0, max: 220 }), (wanted, budget) => {
        const out = allocateParticles(wanted, budget);
        const sum = (rs: RoomCounts[]): number => rs.reduce((n, r) => n + r.ghosts + r.fog + r.motes, 0);
        if (sum(wanted) <= budget) expect(out).toEqual(wanted);
        else expect(sum(out)).toBeLessThanOrEqual(budget);
        out.forEach((r, i) => {
          const w = wanted[i]!;
          expect(r.ghosts).toBeLessThanOrEqual(w.ghosts);
          expect(r.fog).toBeLessThanOrEqual(w.fog);
          expect(r.motes).toBeLessThanOrEqual(w.motes);
        });
        const lost = (key: 'ghosts' | 'fog' | 'motes'): boolean => out.some((r, i) => r[key] < wanted[i]![key]);
        if (lost('ghosts')) expect(out.every((r) => r.fog === 0 && r.motes === 0)).toBe(true);
        if (lost('fog')) expect(out.every((r) => r.motes === 0)).toBe(true);
        // Inside a class, a room only loses while every lower-level room has nothing of it left.
        for (const key of ['ghosts', 'fog', 'motes'] as const) {
          out.forEach((r, i) => {
            if (r[key] >= wanted[i]![key]) return;
            out.forEach((o, j) => {
              if (wanted[j]!.level < wanted[i]!.level) expect(o[key]).toBe(0);
            });
          });
        }
      }),
      RUNS,
    );
  });
});

// Feature: scene-engine, Property 3
describe('Property 3: the model is deterministic', () => {
  it('gives deeply equal results for equal arguments, and wisps are fixed by seed and index', () => {
    fc.assert(
      fc.property(servicesArb(9), fc.integer({ min: 0, max: 2 ** 41 }), optionsArb, (services, now, options) => {
        const a = toSceneModel(services, now, options);
        const b = toSceneModel(structuredClone(services), now, options);
        expect(b).toEqual(a);
      }),
      RUNS,
    );
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 ** 32 - 1 }), fc.integer({ min: 0, max: 40 }), (seed, i) => {
        for (const spec of [ghostSpec, fogSpec, fogBankSpec]) {
          const w = spec(seed, i);
          expect(spec(seed, i)).toEqual(w);
          expect(w.u - w.ampU).toBeGreaterThanOrEqual(0.05 - 1e-12);
          expect(w.u + w.ampU).toBeLessThanOrEqual(0.95 + 1e-12);
          expect(w.v - w.ampV).toBeGreaterThanOrEqual(0.05 - 1e-12);
          expect(w.v + w.ampV).toBeLessThanOrEqual(0.95 + 1e-12);
        }
        // Ghosts stay in the back part of the floor, away from the nameplate at the front corner.
        const g = ghostSpec(seed, i);
        expect(g.u + g.v + g.ampU + g.ampV).toBeLessThanOrEqual(GHOST_BACK_LIMIT + 1e-12);
      }),
      RUNS,
    );
  });

  it('splits the fog into a bank and wisps that add up, bank first', () => {
    fc.assert(
      fc.property(fc.integer({ min: -5, max: 40 }), (n) => {
        const { bank, wisps } = splitFog(n);
        expect(bank + wisps).toBe(Math.max(0, Math.min(FOG_MAX, n)));
        expect(bank).toBeLessThanOrEqual(FOG_BANK_MAX);
        expect(wisps).toBeLessThanOrEqual(FOG_WISP_MAX);
        expect(bank).toBeGreaterThanOrEqual(wisps);
      }),
      RUNS,
    );
  });
});

// Feature: scene-engine, Property 4
describe('Property 4: a dark room is dark', () => {
  it('is dark with no light exactly when the level is 4 or up is below 0.5', () => {
    fc.assert(
      fc.property(serviceStateArb, optionsArb, (s, options) => {
        const r = one(s, options);
        const expectDark = s.hauntLevel === 4 || (s.metrics?.up !== null && s.metrics?.up !== undefined && s.metrics.up < 0.5);
        expect(isDark(s)).toBe(expectDark);
        expect(r.dark).toBe(expectDark);
        if (expectDark) {
          expect(r.light).toBe(0);
          expect(r.moteCount).toBe(0);
        } else {
          expect(r.light).toBeGreaterThan(0);
        }
      }),
      RUNS,
    );
  });

  it('is dark for up equal to 0 at any level', () => {
    fc.assert(
      fc.property(serviceStateArb, (s) => {
        const down = { ...s, metrics: { errorRate: null, p95Ms: null, up: 0, at: 'x' } };
        const r = one(down);
        expect(r.dark).toBe(true);
        expect(r.light).toBe(0);
      }),
      RUNS,
    );
  });
});

// Feature: scene-engine, Property 5
describe('Property 5: reduced motion removes motion and keeps the information', () => {
  it('zeroes the amplitudes and the transition, and changes nothing else', () => {
    fc.assert(
      fc.property(servicesArb(9), fc.constantFrom('full' as const, 'low' as const), (services, quality) => {
        const still = toSceneModel(services, NOW, { reducedMotion: true, quality });
        const moving = toSceneModel(services, NOW, { reducedMotion: false, quality });
        expect(still.transitionMs).toBe(0);
        expect(still.rooms).toHaveLength(moving.rooms.length);
        still.rooms.forEach((r, i) => {
          const m = moving.rooms[i]!;
          expect(r.motion).toEqual({ drift: 0, flicker: 0, tremble: 0 });
          expect({ ...r, motion: m.motion }).toEqual(m);
        });
        expect(still.particles).toEqual(moving.particles);
        expect(still.summary).toBe(moving.summary);
      }),
      RUNS,
    );
  });
});

// Feature: scene-engine, Property 9
describe('Property 9: transitions never overshoot', () => {
  const val = fc.double({ min: -1000, max: 1000, noNaN: true });
  it('stays between the current value and the target, and moves closer as the step grows', () => {
    fc.assert(
      fc.property(val, val, fc.double({ min: 0, max: 5000, noNaN: true }), fc.double({ min: 1, max: 2000, noNaN: true }), (cur, target, dt, tau) => {
        const next = approach(cur, target, dt, tau);
        expect(next).toBeGreaterThanOrEqual(Math.min(cur, target));
        expect(next).toBeLessThanOrEqual(Math.max(cur, target));
        const later = approach(cur, target, dt + 100, tau);
        expect(Math.abs(target - later)).toBeLessThanOrEqual(Math.abs(target - next) + 1e-9);
        expect(approach(cur, target, dt, 0)).toBe(target);
        expect(approach(cur, target, 0, tau)).toBe(cur);
        if (dt >= 5 * tau) expect(Math.abs(target - next)).toBeLessThanOrEqual(0.01 * Math.abs(target - cur) + 1e-9);
      }),
      RUNS,
    );
  });
});

// Feature: scene-engine, Property 14
describe('Property 14: the model is total', () => {
  const finiteDeep = (v: unknown): boolean => {
    if (typeof v === 'number') return Number.isFinite(v);
    if (Array.isArray(v)) return v.every(finiteDeep);
    if (v !== null && typeof v === 'object') return Object.values(v).every(finiteDeep);
    return true;
  };
  it('does not throw, keeps order and gives finite numbers', () => {
    fc.assert(
      fc.property(servicesArb(9), optionsArb, fc.integer({ min: -(2 ** 40), max: 2 ** 41 }), (services, options, now) => {
        const model = toSceneModel(services, now, options);
        expect(model.rooms.map((r) => r.name)).toEqual(services.map((s) => s.name));
        expect(finiteDeep(model)).toBe(true);
      }),
      RUNS,
    );
  });

  it('copes with null metrics and any reason', () => {
    fc.assert(
      fc.property(nameArb, levelArb, reasonArb, errorRateArb, p95Arb, upArb, (name, hauntLevel, reason, errorRate, p95Ms, up) => {
        const s: ServiceState = {
          name,
          room: { x: 0, y: 0 },
          hauntLevel,
          reason,
          metrics: { errorRate, p95Ms, up, at: 'x' },
          openIncident: null,
          updatedAt: 'x',
        };
        expect(finiteDeep(toSceneModel([s], NOW, FULL))).toBe(true);
        expect(finiteDeep(toSceneModel([{ ...s, metrics: null }], NOW, FULL))).toBe(true);
      }),
      RUNS,
    );
  });
});
