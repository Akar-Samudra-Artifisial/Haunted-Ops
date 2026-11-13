// Feature: ingest-haunt-score, Property 13: the live reducer is idempotent and keeps room order
import fc from 'fast-check';
import { SERVICE_NAMES, type HauntLevel, type ServiceName, type ServiceState, type SsePayloads } from '@haunted-ops/shared';
import { describe, expect, it } from 'vitest';
import { SAMPLE_SERVICES } from '../test/fakes.js';
import { applyLiveEvent, sortByRoom, type LiveEventName, type LiveState } from './live-state.js';

const BASE = Date.parse('2026-11-12T10:00:00.000Z');
const iso = (n: number): string => new Date(BASE + n * 1000).toISOString();
const timeArb = fc.integer({ min: 0, max: 20 }).map(iso);
const nameArb = fc.constantFrom<ServiceName>(...SERVICE_NAMES);
const levelArb = fc.constantFrom<HauntLevel>(0, 1, 2, 3, 4);
const numArb = fc.option(fc.double({ min: 0, max: 5000, noNaN: true }), { nil: null });
const metricsArb = fc.option(fc.record({ errorRate: numArb, p95Ms: numArb, up: numArb, at: timeArb }), { nil: null });

const stateFor = (name: ServiceName): fc.Arbitrary<ServiceState> =>
  fc.record({
    name: fc.constant(name),
    room: fc.constant(SAMPLE_SERVICES.find((s) => s.name === name)!.room),
    hauntLevel: levelArb,
    reason: fc.constantFrom(null, { kind: 'p95' as const, value: 1200 }),
    metrics: metricsArb,
    openIncident: fc.option(fc.record({ id: fc.constantFrom('i1', 'i2'), openedAt: timeArb, peakLevel: levelArb }), { nil: null }),
    updatedAt: timeArb,
    hunt: fc.constant(null),
  });

type Ev = { [K in LiveEventName]: { name: K; payload: SsePayloads[K] } }[LiveEventName];

const eventArb: fc.Arbitrary<Ev> = fc.oneof(
  fc
    .tuple(nameArb.chain((n) => stateFor(n)), levelArb)
    .map(([service, previousLevel]): Ev => ({ name: 'service.updated', payload: { service, previousLevel } })),
  fc
    .record({
      at: timeArb,
      samples: fc.array(fc.record({ service: nameArb, errorRate: numArb, p95Ms: numArb, up: numArb }), { maxLength: 4 }),
    })
    .map((payload): Ev => ({ name: 'ingest.polled', payload })),
  fc
    .record({ incidentId: fc.constantFrom('i1', 'i2'), service: nameArb, openedAt: timeArb, level: levelArb, reason: fc.constant(null) })
    .map((payload): Ev => ({ name: 'incident.opened', payload })),
  fc
    .record({ incidentId: fc.constantFrom('i1', 'i2'), service: nameArb, closedAt: timeArb, peakLevel: levelArb })
    .map((payload): Ev => ({ name: 'incident.closed', payload })),
  fc
    .record({ state: fc.constantFrom('ok' as const, 'stale' as const), at: timeArb, lastSuccessAt: fc.option(timeArb, { nil: null }) })
    .map((payload): Ev => ({ name: 'ingest.status', payload })),
);

const apply = (s: LiveState, e: Ev): LiveState => applyLiveEvent(s, e.name, e.payload as never);
const start: LiveState = { services: SAMPLE_SERVICES, ingest: null };

describe('Property 13: the live reducer is idempotent and keeps room order', () => {
  it('applying each event twice equals applying it once', () => {
    fc.assert(
      fc.property(fc.array(eventArb, { maxLength: 30 }), (events) => {
        let once = start;
        let twice = start;
        for (const e of events) {
          once = apply(once, e);
          twice = apply(apply(twice, e), e);
          expect(twice).toEqual(once);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('keeps the services in room order and never loses one', () => {
    fc.assert(
      fc.property(fc.array(eventArb, { maxLength: 30 }), (events) => {
        let state = start;
        for (const e of events) {
          state = apply(state, e);
          expect(state.services.map((s) => s.name)).toEqual(sortByRoom(state.services).map((s) => s.name));
          expect(state.services).toHaveLength(4);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('an older event never overwrites newer data', () => {
    fc.assert(
      fc.property(fc.array(eventArb, { maxLength: 20 }), eventArb, (events, extra) => {
        const state = events.reduce(apply, start);
        const next = apply(state, extra);
        if (extra.name === 'service.updated') {
          const cur = state.services.find((s) => s.name === extra.payload.service.name)!;
          if (Date.parse(cur.updatedAt) > Date.parse(extra.payload.service.updatedAt)) expect(next).toEqual(state);
        }
        if (extra.name === 'ingest.polled') {
          for (const s of state.services) {
            if (s.metrics !== null && Date.parse(s.metrics.at) > Date.parse(extra.payload.at)) {
              expect(next.services.find((x) => x.name === s.name)?.metrics).toEqual(s.metrics);
            }
          }
        }
        if (extra.name === 'ingest.status' && state.ingest && Date.parse(state.ingest.at) > Date.parse(extra.payload.at)) {
          expect(next.ingest).toEqual(state.ingest);
        }
      }),
      { numRuns: 200 },
    );
  });
});
