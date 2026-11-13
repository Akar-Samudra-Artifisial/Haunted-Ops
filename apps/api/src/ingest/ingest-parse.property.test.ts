// Feature: ingest-haunt-score, Property 11: the Prometheus parser is total
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { SERVICE_NAMES } from '@haunted-ops/shared';
import { parseVector } from './parse.js';

const jsonValue = fc.jsonValue({ maxDepth: 4 });
const serviceish = fc.oneof(fc.constantFrom(...SERVICE_NAMES), fc.string(), fc.constant(undefined), fc.integer());
const valueText = fc.oneof(
  fc.double({ noNaN: false }).map(String),
  fc.constantFrom('NaN', '+Inf', '-Inf', '', ' ', '0x1', '1e400', '--1'),
  fc.string(),
);
const entry = fc.oneof(
  fc.record({
    metric: fc.record({ service: serviceish }, { requiredKeys: [] }),
    value: fc.tuple(fc.integer(), valueText),
  }),
  jsonValue,
);
const vectorBody = fc.record({
  status: fc.constant('success'),
  data: fc.record({ resultType: fc.constant('vector'), result: fc.array(entry, { maxLength: 12 }) }),
});

describe('Property 11: the Prometheus parser is total', () => {
  it('never throws, for any JSON value', () => {
    fc.assert(
      fc.property(jsonValue, (body) => {
        expect(() => parseVector(body)).not.toThrow();
      }),
      { numRuns: 300 },
    );
  });

  it('returns only known services with finite numbers, and no duplicated service', () => {
    fc.assert(
      fc.property(vectorBody, (body) => {
        const out = parseVector(body);
        const counts = new Map<string, number>();
        for (const e of body.data.result) {
          const svc = (e as { metric?: { service?: unknown } } | null)?.metric?.service;
          if (typeof svc === 'string') counts.set(svc, (counts.get(svc) ?? 0) + 1);
        }
        for (const [service, value] of out) {
          expect((SERVICE_NAMES as readonly string[]).includes(service)).toBe(true);
          expect(Number.isFinite(value)).toBe(true);
          expect(counts.get(service)).toBe(1);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('accepts hostile objects without throwing', () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('boom');
        },
        getPrototypeOf() {
          throw new Error('boom');
        },
      },
    );
    expect(parseVector(hostile).size).toBe(0);
  });
});
