import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  HAUNT_LEVELS,
  SERVICE_NAMES,
  hauntChanged,
  initialHauntState,
  isNoData,
  stepHaunt,
  type HauntLevel,
  type HauntState,
  type Sample,
  type ServiceName,
} from '@haunted-ops/shared';
import { INCIDENT_CLOSE_AFTER_MS, nextIncident, type IncidentState } from './incident-policy.js';
import { IngestService, POLLED_MIN_INTERVAL_MS } from './ingest.service.js';
import type { PollResult } from './prometheus-client.js';
import { FakeStore, LogCapture, RecordingBus, T0 } from '../../test/support/ingest.js';

const levelArb = fc.constantFrom<HauntLevel>(...HAUNT_LEVELS);
const RUNS = { numRuns: 150 };

/** (level, seconds since the previous poll) pairs. */
const stepsArb = fc.array(fc.tuple(levelArb, fc.integer({ min: 1, max: 20_000 })), { minLength: 1, maxLength: 60 });

const fresh: IncidentState = { open: null, calmMs: 0, lastCalmAt: null };

/** Applies one policy result to the state the way the service does after a successful write. */
function applyAction(state: IncidentState, res: ReturnType<typeof nextIncident>, id: string): IncidentState {
  const timing = { calmMs: res.calmMs, lastCalmAt: res.lastCalmAt };
  switch (res.action.kind) {
    case 'open':
      return { open: { id, peakLevel: res.action.peakLevel }, ...timing };
    case 'raise_peak':
      return { open: { id: (state.open as { id: string }).id, peakLevel: res.action.peakLevel }, ...timing };
    case 'close':
      return { ...fresh };
    case 'none':
      return { open: state.open, ...timing };
  }
}

// Feature: ingest-haunt-score, Property 5
describe('Property 5: at most one Open Incident per Service, and the peak is the maximum', () => {
  it('holds for any sequence of levels', () => {
    fc.assert(
      fc.property(stepsArb, (steps) => {
        let state: IncidentState = { ...fresh };
        let now = 0;
        let openCount = 0;
        let maxSinceOpen: HauntLevel = 0;
        let seq = 0;
        for (const [level, dt] of steps) {
          now += dt;
          const res = nextIncident(state, level, now);
          const { action } = res;
          switch (action.kind) {
            case 'open':
              expect(state.open).toBeNull();
              expect(level).toBeGreaterThanOrEqual(2);
              openCount += 1;
              maxSinceOpen = level;
              break;
            case 'raise_peak':
              expect(state.open).not.toBeNull();
              expect(action.peakLevel).toBe(level);
              maxSinceOpen = Math.max(maxSinceOpen, level) as HauntLevel;
              break;
            case 'close':
              expect(action.peakLevel).toBe(maxSinceOpen);
              openCount -= 1;
              break;
            case 'none':
              if (state.open) maxSinceOpen = Math.max(maxSinceOpen, level) as HauntLevel;
              break;
          }
          state = applyAction(state, res, `i${++seq}`);
          expect(openCount).toBeLessThanOrEqual(1);
          expect(openCount).toBe(state.open ? 1 : 0);
          if (state.open) expect(state.open.peakLevel).toBe(maxSinceOpen);
          if (level === 1 && action.kind !== 'none') throw new Error('level 1 must not open, raise or close');
        }
      }),
      RUNS,
    );
  });
});

type Op = { poll: [HauntLevel, number] } | { gap: number };
const opsArb = fc.array(
  fc.oneof(
    { weight: 4, arbitrary: fc.tuple(levelArb, fc.integer({ min: 1, max: 20_000 })).map((poll): Op => ({ poll })) },
    { weight: 1, arbitrary: fc.integer({ min: 1, max: 120_000 }).map((gap): Op => ({ gap })) },
  ),
  { minLength: 1, maxLength: 60 },
);

// Feature: ingest-haunt-score, Property 6
describe('Property 6: an Incident closes only after 30 s at level 0', () => {
  it('closes at the first Poll where 30 s of calm between consecutive Polls with data are counted, and never earlier', () => {
    fc.assert(
      fc.property(opsArb, (ops) => {
        let state: IncidentState = { ...fresh };
        let now = 0;
        // Model: calm time is the sum of gaps between consecutive level-0 Polls with data that nothing broke.
        let modelCalm = 0;
        let prevCalmAt: number | null = null;
        for (const op of ops) {
          if ('gap' in op) {
            // A failed Poll or a Poll without data: time passes, nothing counts, the stretch is broken.
            now += op.gap;
            prevCalmAt = null;
            state = { ...state, lastCalmAt: null };
            continue;
          }
          const [level, dt] = op.poll;
          now += dt;
          if (level === 0) {
            if (prevCalmAt !== null) modelCalm += now - prevCalmAt;
            prevCalmAt = now;
          } else {
            modelCalm = 0;
            prevCalmAt = null;
          }
          const wasOpen = state.open !== null;
          const res = nextIncident(state, level, now);
          if (wasOpen && level === 0) {
            expect(res.action.kind === 'close').toBe(modelCalm >= INCIDENT_CLOSE_AFTER_MS);
            expect(res.calmMs).toBe(modelCalm);
          } else {
            expect(res.action.kind).not.toBe('close');
          }
          if (level > 0) expect(res.calmMs).toBe(0);
          state = applyAction(state, res, 'i');
          if (!state.open) {
            // Without an open Incident there is nothing to close: the model restarts too.
            modelCalm = 0;
            prevCalmAt = null;
          }
        }
      }),
      RUNS,
    );
  });
});

/** A palette of Samples that covers every level and reason kind. */
const PALETTE: Sample[] = [
  { errorRate: 0, p95Ms: 100, up: 1 },
  { errorRate: 0.06, p95Ms: 100, up: 1 },
  { errorRate: 0.25, p95Ms: 100, up: 1 },
  { errorRate: 0.7, p95Ms: 100, up: 1 },
  { errorRate: 0, p95Ms: 700, up: 1 },
  { errorRate: 0, p95Ms: 1500, up: 1 },
  { errorRate: 0, p95Ms: 4000, up: 1 },
  { errorRate: null, p95Ms: null, up: 0 },
  { errorRate: null, p95Ms: null, up: null },
];
const sampleArb = fc.constantFrom(...PALETTE);
const pollArb: fc.Arbitrary<PollResult> = fc
  .tuple(sampleArb, sampleArb, sampleArb, sampleArb)
  .map(([gate, orders, payments, ledger]) => ({ gate, orders, payments, ledger }));
const pollsArb = fc.array(pollArb, { minLength: 1, maxLength: 30 });

async function build() {
  const store = new FakeStore();
  const bus = new RecordingBus();
  const log = new LogCapture();
  const service = new IngestService({ store, bus, logger: log.logger, now: () => new Date(T0) });
  await service.init();
  return { store, bus, service };
}

const kindOf = (s: HauntState): string | null => s.reason?.kind ?? null;

// Feature: ingest-haunt-score, Property 7
describe('Property 7: events are published exactly when the level or the reason kind changes', () => {
  it('matches a model of stepHaunt, and the last event matches the stored row', async () => {
    await fc.assert(
      fc.asyncProperty(pollsArb, async (polls) => {
        const { store, bus, service } = await build();
        const model = new Map<ServiceName, HauntState>(SERVICE_NAMES.map((n) => [n, initialHauntState(0, null)]));
        const expected = new Map<ServiceName, number>(SERVICE_NAMES.map((n) => [n, 0]));
        let t = 0;
        for (const poll of polls) {
          await service.applyPoll(new Date(T0 + t * 5000), poll);
          t += 1;
          for (const name of SERVICE_NAMES) {
            const prev = model.get(name) as HauntState;
            const next = stepHaunt(prev, poll[name]);
            if (!isNoData(poll[name]) && hauntChanged(prev, next)) expected.set(name, (expected.get(name) ?? 0) + 1);
            model.set(name, next);
          }
        }
        for (const name of SERVICE_NAMES) {
          const events = bus.named('service.updated', name);
          expect(events).toHaveLength(expected.get(name) as number);
          const m = model.get(name) as HauntState;
          const row = store.services.get(name);
          expect(row?.level).toBe(m.level);
          expect(row?.reason?.kind ?? null).toBe(kindOf(m));
          const last = events.at(-1)?.payload as { service: { hauntLevel: number; reason: { kind: string } | null } } | undefined;
          if (last) {
            expect(last.service.hauntLevel).toBe(row?.level);
            expect(last.service.reason?.kind ?? null).toBe(row?.reason?.kind ?? null);
          }
        }
        // ingest.polled is sent for the first Poll and then at most every 30 s (the status stays ok).
        let sent = 0;
        let last: number | null = null;
        polls.forEach((_, i) => {
          const when = i * 5000;
          if (last === null || when - last >= POLLED_MIN_INTERVAL_MS) {
            sent += 1;
            last = when;
          }
        });
        expect(bus.named('ingest.polled')).toHaveLength(sent);
      }),
      { numRuns: 60 },
    );
  });
});

type Item = { ok: PollResult } | { fail: true };
const itemsArb = fc.array(
  fc.oneof({ weight: 3, arbitrary: pollArb.map((ok): Item => ({ ok })) }, { weight: 2, arbitrary: fc.constant<Item>({ fail: true }) }),
  { minLength: 1, maxLength: 40 },
);

// Feature: ingest-haunt-score, Property 9
describe('Property 9: a Prometheus failure never changes levels', () => {
  it('gives the same levels and level-change events as the same successes without the failures', async () => {
    await fc.assert(
      fc.asyncProperty(itemsArb, async (items) => {
        const withFailures = await build();
        const plain = await build();
        let success = 0;
        let clock = 0;
        const transitions: string[] = [];
        let state: 'unknown' | 'ok' | 'stale' = 'unknown';
        for (const item of items) {
          clock += 1;
          if ('ok' in item) {
            const when = new Date(T0 + success * 5000);
            await withFailures.service.applyPoll(when, item.ok);
            await plain.service.applyPoll(when, item.ok);
            success += 1;
            if (state !== 'ok') transitions.push('ok');
            state = 'ok';
          } else {
            const signalsBefore = withFailures.store.signals.length;
            const applyBefore = withFailures.store.applyCalls;
            const eventsBefore = withFailures.bus.events.length;
            withFailures.service.pollFailed(new Date(T0 + clock * 1000), 'timeout');
            expect(withFailures.store.signals.length).toBe(signalsBefore);
            expect(withFailures.store.applyCalls).toBe(applyBefore);
            const added = withFailures.bus.events.slice(eventsBefore).map((e) => e.name);
            expect(added).toEqual(state === 'stale' ? [] : ['ingest.status']);
            if (state !== 'stale') transitions.push('stale');
            state = 'stale';
          }
        }
        for (const name of SERVICE_NAMES) {
          const a = withFailures.store.services.get(name);
          const b = plain.store.services.get(name);
          expect(a?.level).toBe(b?.level);
          expect(a?.reason?.kind ?? null).toBe(b?.reason?.kind ?? null);
        }
        // Failures only add ingest.status and move ingest.polled (a recovery is sent at once). A failed Poll also
        // breaks the calm count, so Incident closes may come later; levels and service.updated must match.
        const strip = (events: { name: string; payload: unknown }[]) =>
          events
            .filter((e) => e.name === 'service.updated')
            .map((e) => {
              const p = e.payload as { previousLevel: number; service: { name: string; hauntLevel: number; reason: { kind: string } | null } };
              return [p.service.name, p.previousLevel, p.service.hauntLevel, p.service.reason?.kind ?? null];
            });
        expect(strip(withFailures.bus.events)).toEqual(strip(plain.bus.events));
        expect(withFailures.bus.named('ingest.status').map((e) => (e.payload as { state: string }).state)).toEqual(transitions);
        expect(withFailures.store.signals).toEqual(plain.store.signals);
      }),
      { numRuns: 60 },
    );
  });
});
