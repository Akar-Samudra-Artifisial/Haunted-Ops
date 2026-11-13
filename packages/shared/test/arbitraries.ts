import fc from 'fast-check';
import {
  DOMAIN_EVENT_NAMES,
  HAUNT_LEVELS,
  HAUNT_REASON_KINDS,
  RESYNC_REASONS,
  SERVICE_NAMES,
  SIGNAL_KINDS,
  formatEventId,
  type HauntLevel,
  type HauntReason,
  type Sample,
  type ServiceState,
  type SseEventName,
  type SsePayloads,
} from '../src/index.js';

export const isoArb = fc
  .date({ min: new Date('2000-01-01T00:00:00.000Z'), max: new Date('2099-12-31T23:59:59.999Z'), noInvalidDate: true })
  .map((d) => d.toISOString());

export const bootIdArb = fc.stringMatching(/^[0-9a-f]{12}$/);
export const serviceNameArb = fc.constantFrom(...SERVICE_NAMES);
export const hauntLevelArb = fc.constantFrom(...HAUNT_LEVELS);
export const signalKindArb = fc.constantFrom(...SIGNAL_KINDS);
/** Finite doubles without -0, which JSON cannot carry. */
export const finiteArb = fc.double({ noNaN: true, noDefaultInfinity: true }).map((v) => (v === 0 ? 0 : v));

export const nullableNumberArb = fc.option(finiteArb, { nil: null });
export const sampleArb: fc.Arbitrary<Sample> = fc.record({
  errorRate: nullableNumberArb,
  p95Ms: nullableNumberArb,
  up: nullableNumberArb,
});
export const hauntReasonArb: fc.Arbitrary<HauntReason> = fc.record({
  kind: fc.constantFrom(...HAUNT_REASON_KINDS),
  value: finiteArb,
});

export const serviceStateArb: fc.Arbitrary<ServiceState> = fc.record({
  name: serviceNameArb,
  room: fc.record({ x: fc.integer(), y: fc.integer() }),
  hauntLevel: hauntLevelArb,
  reason: fc.option(hauntReasonArb, { nil: null }),
  metrics: fc.option(fc.record({ errorRate: nullableNumberArb, p95Ms: nullableNumberArb, up: nullableNumberArb, at: isoArb }), {
    nil: null,
  }),
  openIncident: fc.option(
    fc.record({ id: fc.string({ minLength: 1 }), openedAt: isoArb, peakLevel: hauntLevelArb }),
    { nil: null },
  ),
  updatedAt: isoArb,
});

export const payloadArbs: { [K in SseEventName]: fc.Arbitrary<SsePayloads[K]> } = {
  'service.updated': fc.record({ service: serviceStateArb, previousLevel: hauntLevelArb }),
  'signal.recorded': fc.record({ service: serviceNameArb, kind: signalKindArb, value: finiteArb, at: isoArb }),
  'incident.opened': fc.record({
    incidentId: fc.string({ minLength: 1 }),
    service: serviceNameArb,
    openedAt: isoArb,
    level: hauntLevelArb,
    reason: fc.option(hauntReasonArb, { nil: null }),
  }),
  'incident.closed': fc.record({
    incidentId: fc.string({ minLength: 1 }),
    service: serviceNameArb,
    closedAt: isoArb,
    peakLevel: hauntLevelArb,
  }),
  'ingest.polled': fc.record({
    at: isoArb,
    samples: fc.array(fc.record({ service: serviceNameArb, errorRate: nullableNumberArb, p95Ms: nullableNumberArb, up: nullableNumberArb }), {
      maxLength: 4,
    }),
  }),
  'ingest.status': fc.record({
    state: fc.constantFrom('ok', 'stale' as const),
    at: isoArb,
    lastSuccessAt: fc.option(isoArb, { nil: null }),
  }),
  connected: fc.record({ bootId: bootIdArb }),
  heartbeat: fc.record({ at: isoArb }),
  resync: fc.record({ reason: fc.constantFrom(...RESYNC_REASONS) }),
};

/** Any valid named event, with an id only for domain events. */
export const namedEventArb = fc.oneof(
  ...(Object.keys(payloadArbs) as SseEventName[]).map((name) =>
    fc.record({
      name: fc.constant(name),
      payload: payloadArbs[name] as fc.Arbitrary<unknown>,
      id: (DOMAIN_EVENT_NAMES as readonly string[]).includes(name)
        ? fc
            .tuple(bootIdArb, fc.integer({ min: 1, max: 999_999_999_999_999 }))
            .map(([boot, n]): string | undefined => formatEventId(boot, n))
        : fc.constant<string | undefined>(undefined),
    }),
  ),
);

/** A Sample whose raw haunt level is exactly `level`. */
export function sampleForLevel(level: HauntLevel): Sample {
  const calm: Sample = { errorRate: 0, p95Ms: 100, up: 1 };
  switch (level) {
    case 0:
      return calm;
    case 1:
      return { ...calm, errorRate: 0.06 };
    case 2:
      return { ...calm, errorRate: 0.25 };
    case 3:
      return { ...calm, errorRate: 0.6 };
    case 4:
      return { ...calm, up: 0 };
  }
}
