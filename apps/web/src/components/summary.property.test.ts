import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { HauntLevel, ServiceName } from '@haunted-ops/shared';
import { makeService } from '../test/arbs.js';
import { summarize } from './summary.js';
const NAMES: ServiceName[] = ['gate', 'orders', 'payments', 'ledger'];
describe('Property 2: the summary counts add up and match the levels', () => {
  // Feature: visual-refresh, Property 2
  it('adds up to the number of services, matches each level, lists worst first and omits empty levels', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom<HauntLevel>(0, 1, 2, 3, 4), { maxLength: 12 }), (levels) => {
        const services = levels.map((hauntLevel, i) => makeService(NAMES[i % 4] as ServiceName, { hauntLevel }));
        const { counts } = summarize(services);
        expect(counts.reduce((n, c) => n + c.count, 0)).toBe(services.length);
        for (const c of counts) {
          expect(c.count).toBeGreaterThan(0);
          expect(c.count).toBe(levels.filter((l) => l === c.level).length);
        }
        const order = counts.map((c) => c.level);
        expect(order).toEqual([...order].sort((a, b) => b - a));
        expect(new Set(order).size).toBe(order.length);
      }),
      { numRuns: 100 },
    );
  });
});
