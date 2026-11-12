// Feature: foundation, Property 7: Validators are total and exact
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { SSE_EVENT_NAMES, validateHauntLevel, validateServiceState, validateSseEvent } from '../src/index.js';
import { payloadArbs, serviceStateArb } from './arbitraries.js';

const RUNS = { numRuns: 200 };

describe('Property 7: validators are total and exact', () => {
  it('never throws on any input', () => {
    fc.assert(
      fc.property(fc.anything({ withNullPrototype: true, withMap: true, withSet: true }), fc.constantFrom(...SSE_EVENT_NAMES), (input, name) => {
        expect(() => validateServiceState(input)).not.toThrow();
        expect(() => validateHauntLevel(input)).not.toThrow();
        expect(() => validateSseEvent(name, input)).not.toThrow();
      }),
      RUNS,
    );
  });

  it('accepts every valid Service state unchanged', () => {
    fc.assert(
      fc.property(serviceStateArb, (state) => {
        expect(validateServiceState(state)).toEqual({ ok: true, value: state });
      }),
      RUNS,
    );
  });

  it('rejects a Service state with any one field broken or an extra key', () => {
    const breakers = fc.oneof(
      fc.record({ key: fc.constant('name'), value: fc.string().filter((s) => !['gate', 'orders', 'payments', 'ledger'].includes(s)) }),
      fc.record({ key: fc.constant('hauntLevel'), value: fc.oneof(fc.integer({ min: 5 }), fc.integer({ max: -1 }), fc.double({ min: 0.01, max: 3.99 }).filter((v) => !Number.isInteger(v))) }),
      fc.record({ key: fc.constant('room'), value: fc.oneof(fc.constant(null), fc.record({ x: fc.string() }), fc.integer()) }),
      fc.record({ key: fc.constant('updatedAt'), value: fc.oneof(fc.integer(), fc.constant('not a date'), fc.constant('2026-11-12')) }),
      fc.record({ key: fc.string().filter((k) => !['name', 'room', 'hauntLevel', 'updatedAt', '__proto__'].includes(k)), value: fc.anything() }),
    );
    fc.assert(
      fc.property(serviceStateArb, breakers, (state, { key, value }) => {
        const broken: Record<string, unknown> = { ...state };
        Object.defineProperty(broken, key, { value, enumerable: true, writable: true, configurable: true });
        expect(validateServiceState(broken).ok).toBe(false);
      }),
      RUNS,
    );
  });

  it('accepts every valid event payload and rejects it with a missing key', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...SSE_EVENT_NAMES).chain((name) => fc.tuple(fc.constant(name), payloadArbs[name] as fc.Arbitrary<Record<string, unknown>>)),
        ([name, payload]) => {
          expect(validateSseEvent(name, payload)).toEqual({ ok: true, value: payload });
          const [first] = Object.keys(payload);
          if (first !== undefined) {
            const missing = { ...payload };
            delete missing[first];
            expect(validateSseEvent(name, missing).ok).toBe(false);
          }
        },
      ),
      RUNS,
    );
  });

  it('accepts exactly the integers 0 to 4 as Haunt level', () => {
    fc.assert(
      fc.property(fc.oneof(fc.integer({ min: -10, max: 10 }), fc.double(), fc.anything()), (v) => {
        const expected = typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 4;
        expect(validateHauntLevel(v).ok).toBe(expected);
      }),
      RUNS,
    );
  });
});
