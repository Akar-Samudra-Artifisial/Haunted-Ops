import { describe, expect, it } from 'vitest';
import type { HauntReason, Sample } from '@haunted-ops/shared';
import { INCIDENT_CLOSE_AFTER_MS, INCIDENT_OPEN_AT_LEVEL, nextIncident, type IncidentState } from './incident-policy.js';
import { IngestService, POLLED_MIN_INTERVAL_MS } from './ingest.service.js';
import { signalRows } from './store.js';
import { CALM, FakeStore, LogCapture, NO_DATA, RecordingBus, T0, at, pollResult } from '../../test/support/ingest.js';

const ERRORS: Sample = { errorRate: 0.25, p95Ms: 120, up: 1 };
const SLOW: Sample = { errorRate: 0, p95Ms: 1500, up: 1 };
const DOWN: Sample = { errorRate: null, p95Ms: null, up: 0 };

async function setup(store = new FakeStore()) {
  const bus = new RecordingBus();
  const log = new LogCapture();
  const service = new IngestService({ store, bus, logger: log.logger, now: () => new Date(T0) });
  await service.init();
  return { store, bus, log, service };
}

const closedState: IncidentState = { open: null, calmMs: 0, lastCalmAt: null };
const openState = (peak: 2 | 3 | 4, calmMs = 0, lastCalmAt: number | null = null): IncidentState => ({
  open: { id: 'a', peakLevel: peak },
  calmMs,
  lastCalmAt,
});

describe('nextIncident', () => {
  it('opens at level 2 and not at level 1', () => {
    expect(INCIDENT_OPEN_AT_LEVEL).toBe(2);
    expect(nextIncident(closedState, 1, 0).action).toEqual({ kind: 'none' });
    expect(nextIncident(closedState, 2, 0).action).toEqual({ kind: 'open', peakLevel: 2 });
    expect(nextIncident(closedState, 4, 0).action).toEqual({ kind: 'open', peakLevel: 4 });
  });

  it('raises the peak and keeps the incident open at level 1', () => {
    expect(nextIncident(openState(2), 3, 0).action).toEqual({ kind: 'raise_peak', peakLevel: 3 });
    expect(nextIncident(openState(2), 2, 0).action).toEqual({ kind: 'none' });
    expect(nextIncident(openState(2), 1, 0).action).toEqual({ kind: 'none' });
  });

  it('counts calm time between consecutive level-0 polls and closes at exactly 30 s', () => {
    expect(INCIDENT_CLOSE_AFTER_MS).toBe(30_000);
    const first = nextIncident(openState(3), 0, 1000);
    expect(first).toEqual({ calmMs: 0, lastCalmAt: 1000, action: { kind: 'none' } });
    const mid = nextIncident(openState(3, 0, 1000), 0, 30_999);
    expect(mid.calmMs).toBe(29_999);
    expect(mid.action).toEqual({ kind: 'none' });
    expect(nextIncident(openState(3, 0, 1000), 0, 31_000).action).toEqual({ kind: 'close', peakLevel: 3 });
  });

  it('restarts the count on any level above 0', () => {
    expect(nextIncident(openState(3, 20_000, 5000), 1, 9000)).toEqual({ calmMs: 0, lastCalmAt: null, action: { kind: 'none' } });
  });

  it('does not count the time after a break (lastCalmAt null), but keeps what was counted', () => {
    // 20 s counted, a failed or empty Poll broke the stretch, then a 60 s gap passes before the next Poll.
    const after = nextIncident(openState(3, 20_000, null), 0, 100_000);
    expect(after).toEqual({ calmMs: 20_000, lastCalmAt: 100_000, action: { kind: 'none' } });
    expect(nextIncident(openState(3, 20_000, 100_000), 0, 110_000).action).toEqual({ kind: 'close', peakLevel: 3 });
  });

  it('ignores a clock that went backwards', () => {
    expect(nextIncident(openState(3, 5000, 10_000), 0, 8000).calmMs).toBe(5000);
  });
});

describe('signalRows', () => {
  it('makes one row per non-null value, with the poll time', () => {
    const when = at(0);
    expect(signalRows('gate', { errorRate: 0.1, p95Ms: null, up: 1 }, when)).toEqual([
      { service: 'gate', kind: 'error_rate', value: 0.1, at: when },
      { service: 'gate', kind: 'up', value: 1, at: when },
    ]);
    expect(signalRows('gate', NO_DATA, when)).toEqual([]);
  });
});

describe('IngestService', () => {
  it('stores the non-null values of each Service with the time of the Poll', async () => {
    const { store, service } = await setup();
    await service.applyPoll(at(0), pollResult({ ledger: DOWN }));
    expect(store.signals).toHaveLength(3 * 3 + 1);
    expect(store.signals.every((r) => r.at.getTime() === T0)).toBe(true);
    expect(store.signals.filter((r) => r.service === 'ledger')).toEqual([
      { service: 'ledger', kind: 'up', value: 0, at: at(0) },
    ]);
  });

  it('raises payments after 2 bad polls: service.updated with previousLevel, then incident.opened with level and reason', async () => {
    const { bus, service } = await setup();
    await service.applyPoll(at(0), pollResult({ payments: ERRORS }));
    expect(bus.named('service.updated')).toHaveLength(0);
    await service.applyPoll(at(5), pollResult({ payments: ERRORS }));
    const names = bus.events.map((e) => e.name);
    expect(names.filter((n) => n === 'service.updated')).toHaveLength(1);
    const updated = bus.named('service.updated', 'payments')[0]?.payload as {
      previousLevel: number;
      service: { hauntLevel: number; reason: HauntReason; openIncident: { peakLevel: number } | null };
    };
    expect(updated.previousLevel).toBe(0);
    expect(updated.service.hauntLevel).toBe(2);
    expect(updated.service.reason).toEqual({ kind: 'error_rate', value: 0.25 });
    expect(updated.service.openIncident?.peakLevel).toBe(2);
    const i = names.indexOf('service.updated');
    expect(names[i + 1]).toBe('incident.opened');
    const opened = bus.named('incident.opened', 'payments');
    expect(opened).toHaveLength(1);
    expect(opened[0]?.payload).toMatchObject({ level: 2, reason: { kind: 'error_rate', value: 0.25 } });
  });

  it('reports the level before the change as previousLevel, also for a later rise', async () => {
    const { bus, service } = await setup();
    const spike = pollResult({ payments: { errorRate: 0.6, p95Ms: 100, up: 1 } });
    await service.applyPoll(at(0), pollResult({ payments: ERRORS }));
    await service.applyPoll(at(5), pollResult({ payments: ERRORS }));
    await service.applyPoll(at(10), spike);
    await service.applyPoll(at(15), spike);
    const levels = bus.named('service.updated', 'payments').map((e) => {
      const p = e.payload as { previousLevel: number; service: { hauntLevel: number } };
      return [p.previousLevel, p.service.hauntLevel];
    });
    expect(levels).toEqual([
      [0, 2],
      [2, 3],
    ]);
  });

  it('publishes ingest.polled at most every 30 s, and when the ingest status changes, never signal.recorded', async () => {
    const { bus, service } = await setup();
    await service.applyPoll(at(0), pollResult());
    await service.applyPoll(at(5), pollResult());
    await service.applyPoll(at(25), pollResult());
    expect(bus.named('ingest.polled')).toHaveLength(1);
    expect((bus.named('ingest.polled')[0]?.payload as { samples: unknown[] }).samples).toHaveLength(4);
    expect(POLLED_MIN_INTERVAL_MS).toBe(30_000);
    await service.applyPoll(at(30), pollResult());
    expect(bus.named('ingest.polled')).toHaveLength(2);
    await service.applyPoll(at(35), pollResult());
    expect(bus.named('ingest.polled')).toHaveLength(2);
    // A recovery from stale is a change of status: the next Poll is sent at once.
    service.pollFailed(at(40), 'timeout');
    await service.applyPoll(at(45), pollResult());
    expect(bus.named('ingest.polled')).toHaveLength(3);
    expect(bus.named('signal.recorded')).toHaveLength(0);
  });

  it('publishes ingest.status ok once, on the first success', async () => {
    const { bus, service } = await setup();
    await service.applyPoll(at(0), pollResult());
    await service.applyPoll(at(5), pollResult());
    const statuses = bus.named('ingest.status');
    expect(statuses).toHaveLength(1);
    expect(statuses[0]?.payload).toEqual({ state: 'ok', at: at(0).toISOString(), lastSuccessAt: at(0).toISOString() });
    expect(service.status().lastSuccessAt).toBe(at(5).toISOString());
  });

  it('publishes nothing for a change of the reason value alone, and one event for a new reason kind', async () => {
    const { bus, service } = await setup();
    await service.applyPoll(at(0), pollResult({ payments: ERRORS }));
    await service.applyPoll(at(5), pollResult({ payments: ERRORS }));
    const before = bus.named('service.updated').length;
    await service.applyPoll(at(10), pollResult({ payments: { ...ERRORS, errorRate: 0.3 } }));
    expect(bus.named('service.updated')).toHaveLength(before);
    await service.applyPoll(at(15), pollResult({ payments: SLOW }));
    expect(bus.named('service.updated')).toHaveLength(before + 1);
    const last = bus.named('service.updated', 'payments').at(-1)?.payload as {
      previousLevel: number;
      service: { hauntLevel: number; reason: HauntReason };
    };
    expect(last.service.hauntLevel).toBe(2);
    expect(last.previousLevel).toBe(2);
    expect(last.service.reason.kind).toBe('p95');
  });

  it('leaves a Service with a No-data sample alone but keeps its metrics', async () => {
    const { bus, store, service } = await setup();
    await service.applyPoll(at(0), pollResult({ gate: NO_DATA }));
    expect(bus.named('service.updated')).toHaveLength(0);
    expect(store.applyCalls).toBe(0);
    const metrics = await service.metrics();
    expect(metrics.get('gate')).toEqual({ ...NO_DATA, at: at(0).toISOString() });
  });

  it('closes the Incident after the level fell to 0 and 30 s of level 0, and not before', async () => {
    const { bus, store, service } = await setup();
    const bad = pollResult({ payments: ERRORS });
    await service.applyPoll(at(0), bad);
    await service.applyPoll(at(5), bad);
    expect(store.openFor('payments')).toHaveLength(1);
    // 3 calm polls lower the level to 0 at t=20; level 0 begins at t=20.
    for (const t of [10, 15, 20]) await service.applyPoll(at(t), pollResult());
    expect(bus.named('incident.closed')).toHaveLength(0);
    for (const t of [25, 30, 35, 40, 45]) await service.applyPoll(at(t), pollResult());
    expect(bus.named('incident.closed')).toHaveLength(0);
    await service.applyPoll(at(50), pollResult());
    const closed = bus.named('incident.closed', 'payments');
    expect(closed).toHaveLength(1);
    expect((closed[0]?.payload as { peakLevel: number }).peakLevel).toBe(2);
    expect(store.openFor('payments')).toHaveLength(0);
  });

  it('does not count Polls without data toward closing an Incident', async () => {
    const store = new FakeStore();
    store.addOpenIncident('gate', 2);
    const { bus, service } = await setup(store);
    await service.applyPoll(at(100), pollResult());
    await service.applyPoll(at(105), pollResult({ gate: NO_DATA }));
    // 30 s have passed on the clock since t=100, but the stretch was broken at t=105.
    for (const t of [110, 115, 120, 125, 130, 135]) await service.applyPoll(at(t), pollResult());
    expect(bus.named('incident.closed')).toHaveLength(0);
    await service.applyPoll(at(140), pollResult());
    expect(bus.named('incident.closed', 'gate')).toHaveLength(1);
  });

  it('does not count a failed Poll toward closing an Incident', async () => {
    const store = new FakeStore();
    store.addOpenIncident('gate', 2);
    const { bus, service } = await setup(store);
    await service.applyPoll(at(100), pollResult());
    service.pollFailed(at(105), 'timeout');
    for (const t of [110, 115, 120, 125, 130, 135]) await service.applyPoll(at(t), pollResult());
    expect(bus.named('incident.closed')).toHaveLength(0);
    await service.applyPoll(at(140), pollResult());
    expect(bus.named('incident.closed', 'gate')).toHaveLength(1);
  });

  it('keeps the database level and publishes nothing when the write fails, and stays ok', async () => {
    const { bus, store, log, service } = await setup();
    await service.applyPoll(at(0), pollResult({ payments: ERRORS }));
    store.failApply = new Error('db down');
    await service.applyPoll(at(5), pollResult({ payments: ERRORS }));
    expect(bus.named('service.updated')).toHaveLength(0);
    expect(store.services.get('payments')?.level).toBe(0);
    expect(service.status().state).toBe('ok');
    expect(bus.named('ingest.status').map((e) => (e.payload as { state: string }).state)).toEqual(['ok']);
    expect(log.lines.join('')).toContain('service_write_failed');
    expect(log.lines.join('')).not.toContain('db down');
    store.failApply = null;
    await service.applyPoll(at(10), pollResult({ payments: ERRORS }));
    expect(bus.named('service.updated', 'payments')).toHaveLength(1);
    expect(store.services.get('payments')?.level).toBe(2);
  });

  it('keeps the hysteresis streak across a failed write: the retry needs no new streak', async () => {
    const { bus, store, service } = await setup();
    await service.applyPoll(at(0), pollResult({ payments: ERRORS }));
    store.failApply = new Error('db down');
    // The 2nd bad Poll completes the rise, but the write fails.
    await service.applyPoll(at(5), pollResult({ payments: ERRORS }));
    store.failApply = null;
    // One more Poll, even a calm one (a single lower Poll), writes the level that was reached.
    await service.applyPoll(at(10), pollResult());
    expect(store.services.get('payments')?.level).toBe(2);
    const updated = bus.named('service.updated', 'payments');
    expect(updated).toHaveLength(1);
    expect((updated[0]?.payload as { previousLevel: number }).previousLevel).toBe(0);
  });

  it('keeps a falling streak across a failed write', async () => {
    const store = new FakeStore({ payments: { level: 2, reason: { kind: 'error_rate', value: 0.25 } } });
    const { service } = await setup(store);
    await service.applyPoll(at(0), pollResult());
    await service.applyPoll(at(5), pollResult());
    store.failApply = new Error('db down');
    await service.applyPoll(at(10), pollResult());
    expect(store.services.get('payments')?.level).toBe(2);
    store.failApply = null;
    await service.applyPoll(at(15), pollResult());
    expect(store.services.get('payments')?.level).toBe(0);
  });

  it('keeps scoring when the Signal insert fails or a publish throws', async () => {
    const { bus, store, log, service } = await setup();
    store.failInsert = new Error('insert failed');
    await service.applyPoll(at(0), pollResult({ payments: ERRORS }));
    bus.failWith = new Error('bus closed');
    await service.applyPoll(at(5), pollResult({ payments: ERRORS }));
    expect(store.services.get('payments')?.level).toBe(2);
    expect(log.lines.join('')).toContain('signal_insert_failed');
    expect(log.lines.join('')).toContain('publish_failed');
  });

  it('loads level, reason and the open Incident after a restart, with empty streaks and no calm count', async () => {
    const reason: HauntReason = { kind: 'down', value: 0 };
    const store = new FakeStore({ ledger: { level: 4, reason } });
    store.addOpenIncident('ledger', 4);
    const { bus, service } = await setup(store);
    // One calm poll does not change a restored level of 4.
    await service.applyPoll(at(0), pollResult());
    expect(store.services.get('ledger')?.level).toBe(4);
    expect(bus.named('service.updated')).toHaveLength(0);
    // The Incident stays open while the level is above 0.
    expect(store.openFor('ledger')).toHaveLength(1);
  });

  it('starts the 30 s count at the first level-0 Poll after a restart', async () => {
    const store = new FakeStore();
    store.addOpenIncident('gate', 2);
    const { bus, service } = await setup(store);
    await service.applyPoll(at(100), pollResult());
    await service.applyPoll(at(120), pollResult());
    await service.applyPoll(at(129), pollResult());
    expect(bus.named('incident.closed')).toHaveLength(0);
    await service.applyPoll(at(130), pollResult());
    expect(bus.named('incident.closed', 'gate')).toHaveLength(1);
  });

  it('reports stale once per change and keeps levels, incidents and signals untouched', async () => {
    const { bus, store, log, service } = await setup();
    await service.applyPoll(at(0), pollResult({ payments: ERRORS }));
    await service.applyPoll(at(5), pollResult({ payments: ERRORS }));
    const signalsBefore = store.signals.length;
    const eventsBefore = bus.events.length;
    service.pollFailed(at(10), 'timeout');
    service.pollFailed(at(15), 'network');
    expect(bus.events.slice(eventsBefore).map((e) => e.name)).toEqual(['ingest.status']);
    expect(bus.events.at(-1)?.payload).toEqual({ state: 'stale', at: at(10).toISOString(), lastSuccessAt: at(5).toISOString() });
    expect(store.signals).toHaveLength(signalsBefore);
    expect(store.services.get('payments')?.level).toBe(2);
    expect(service.status()).toEqual({ state: 'stale', at: at(10).toISOString(), lastSuccessAt: at(5).toISOString() });
    expect(log.lines.filter((l) => l.includes('poll_failed'))).toHaveLength(2);
    await service.applyPoll(at(20), pollResult({ payments: ERRORS }));
    expect(bus.named('ingest.status').map((e) => (e.payload as { state: string }).state)).toEqual(['ok', 'stale', 'ok']);
  });

  it('reports stale if the very first Poll fails', async () => {
    const { bus, service } = await setup();
    expect(service.status()).toEqual({ state: 'stale', at: new Date(T0).toISOString(), lastSuccessAt: null });
    service.pollFailed(at(0), 'network');
    expect(bus.named('ingest.status')).toHaveLength(1);
  });

  it('falls back to Signals of the last 60 s for metrics before the first Poll', async () => {
    const { store, service } = await setup();
    store.recent.set('gate', { errorRate: 0, p95Ms: 100, up: 1, at: at(-10).toISOString() });
    const m = await service.metrics();
    expect(m.get('gate')?.p95Ms).toBe(100);
    expect(m.has('orders')).toBe(false);
    await service.applyPoll(at(0), pollResult({ gate: { ...CALM, p95Ms: null } }));
    expect((await service.metrics()).get('gate')?.p95Ms).toBeNull();
  });
});
