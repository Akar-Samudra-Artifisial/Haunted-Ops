import fc from 'fast-check';
import { SERVICE_NAMES, type HauntLevel, type ServiceState } from '@haunted-ops/shared';

export const levelArb = fc.constantFrom<HauntLevel>(0, 1, 2, 3, 4);
export const nameArb = fc.constantFrom(...SERVICE_NAMES);

const nullable = (arb: fc.Arbitrary<number>): fc.Arbitrary<number | null> => fc.option(arb, { nil: null });

export const errorRateArb = nullable(fc.double({ min: 0, max: 2, noNaN: true }));
export const p95Arb = nullable(fc.double({ min: 0, max: 12_000, noNaN: true }));
export const upArb = nullable(fc.double({ min: 0, max: 1, noNaN: true }));

const iso = '2026-11-13T10:00:00.000Z';

export const reasonArb = fc.option(
  fc.record({
    kind: fc.constantFrom('error_rate' as const, 'p95' as const, 'down' as const),
    value: fc.double({ min: 0, max: 12_000, noNaN: true }),
  }),
  { nil: null },
);

/** Any valid ServiceState: any name, room in a 3 by 3 grid, level, reason, metrics and incident. */
export const serviceStateArb: fc.Arbitrary<ServiceState> = fc
  .record({
    name: nameArb,
    x: fc.integer({ min: 0, max: 2 }),
    y: fc.integer({ min: 0, max: 2 }),
    hauntLevel: levelArb,
    reason: reasonArb,
    metrics: fc.option(fc.record({ errorRate: errorRateArb, p95Ms: p95Arb, up: upArb, at: fc.constant(iso) }), { nil: null }),
    openIncident: fc.option(fc.record({ id: fc.constant('inc'), openedAt: fc.constant(iso), peakLevel: levelArb }), { nil: null }),
  })
  .map(({ x, y, ...rest }) => ({ ...rest, room: { x, y }, updatedAt: iso, hunt: null }));

export const servicesArb = (max: number): fc.Arbitrary<ServiceState[]> => fc.array(serviceStateArb, { maxLength: max });

/** A house like the real one: distinct names in the four standard rooms. */
export const ROOMS = { gate: { x: 0, y: 0 }, orders: { x: 1, y: 0 }, payments: { x: 0, y: 1 }, ledger: { x: 1, y: 1 } } as const;

export function makeService(name: ServiceState['name'], over: Partial<ServiceState> = {}): ServiceState {
  return {
    name,
    room: ROOMS[name],
    hauntLevel: 0,
    reason: null,
    metrics: null,
    openIncident: null,
    updatedAt: iso,
    hunt: null,
    ...over,
  };
}
