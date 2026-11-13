// Feature: scene-engine, Property 12: the demo timeline is valid and deterministic
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { SERVICE_NAMES, initialHauntState, stepHaunt, validateServiceStates, type HauntState } from '@haunted-ops/shared';
import { DEMO_DURATION_MS, demoServices, demoTime, scenarioServices } from './demo.js';
import { DEMO_SCENARIOS } from './params.js';

const RUNS = { numRuns: 100 };

describe('Property 12: the demo timeline is valid and deterministic', () => {
  it('is a valid array of four states in room order, equal for equal times', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 * DEMO_DURATION_MS }), (t) => {
        const a = demoServices(t);
        expect(validateServiceStates(a).ok).toBe(true);
        expect(a.map((s) => s.name)).toEqual([...SERVICE_NAMES]);
        expect(demoServices(t)).toEqual(a);
        // Same second, same state.
        expect(demoServices(Math.floor(t / 1000) * 1000)).toEqual(a);
      }),
      RUNS,
    );
  });

  it('has levels that follow stepHaunt over the metrics it shows', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 95 }), (second) => {
        const shown = demoServices(second * 1000);
        for (const service of shown) {
          let state: HauntState = initialHauntState(0, null);
          for (let s = 0; s <= second; s++) {
            const m = demoServices(s * 1000).find((x) => x.name === service.name)!.metrics!;
            state = stepHaunt(state, { errorRate: m.errorRate, p95Ms: m.p95Ms, up: m.up });
          }
          expect(service.hauntLevel).toBe(state.level);
          expect(service.reason?.kind ?? null).toBe(state.reason?.kind ?? null);
        }
      }),
      { numRuns: 60 },
    );
  });

  it('wraps with loop: the state at t equals the state at t modulo the duration', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 5 * DEMO_DURATION_MS }), (elapsed) => {
        const t = demoTime(elapsed, true);
        expect(t).toBeGreaterThanOrEqual(0);
        expect(t).toBeLessThan(DEMO_DURATION_MS);
        expect(demoServices(t)).toEqual(demoServices(elapsed % DEMO_DURATION_MS));
        expect(demoTime(elapsed, false)).toBeLessThan(DEMO_DURATION_MS);
      }),
      RUNS,
    );
  });

  it('gives a valid, fixed array for every scenario name', () => {
    for (const name of DEMO_SCENARIOS) {
      const a = scenarioServices(name);
      expect(validateServiceStates(a).ok).toBe(true);
      expect(scenarioServices(name)).toEqual(a);
    }
  });
});
