import { describe, expect, it } from 'vitest';
import { SAMPLE_SERVICES } from '../test/fakes.js';
import { applyLiveEvent, newerMetrics, type LiveState } from './live-state.js';

const T = (s: number): string => new Date(Date.parse('2026-11-12T10:00:00.000Z') + s * 1000).toISOString();
const start: LiveState = { services: SAMPLE_SERVICES, ingest: null };
const named = (state: LiveState, name: string) => state.services.find((s) => s.name === name);

describe('applyLiveEvent', () => {
  it('replaces a service on service.updated and keeps newer metrics', () => {
    const withMetrics = applyLiveEvent(start, 'ingest.polled', {
      at: T(10),
      samples: [{ service: 'gate', errorRate: 0.1, p95Ms: 200, up: 1 }],
    });
    const next = applyLiveEvent(withMetrics, 'service.updated', {
      service: { ...SAMPLE_SERVICES[0]!, hauntLevel: 2, reason: { kind: 'error_rate', value: 0.3 }, metrics: null, updatedAt: T(5) },
      previousLevel: 0,
    });
    const gate = named(next, 'gate');
    expect(gate?.hauntLevel).toBe(2);
    expect(gate?.reason).toEqual({ kind: 'error_rate', value: 0.3 });
    expect(gate?.metrics?.errorRate).toBe(0.1);
  });

  it('ignores a service.updated older than the stored one', () => {
    const newer = applyLiveEvent(start, 'service.updated', { service: { ...SAMPLE_SERVICES[0]!, hauntLevel: 3, updatedAt: T(20) }, previousLevel: 0 });
    const older = applyLiveEvent(newer, 'service.updated', { service: { ...SAMPLE_SERVICES[0]!, hauntLevel: 1, updatedAt: T(10) }, previousLevel: 0 });
    expect(older).toBe(newer);
  });

  it('sets metrics on ingest.polled and ignores an older poll', () => {
    const a = applyLiveEvent(start, 'ingest.polled', {
      at: T(10),
      samples: [
        { service: 'payments', errorRate: 0.22, p95Ms: null, up: 1 },
        { service: 'ledger', errorRate: null, p95Ms: null, up: 0 },
      ],
    });
    expect(named(a, 'payments')?.metrics).toEqual({ errorRate: 0.22, p95Ms: null, up: 1, at: T(10) });
    expect(named(a, 'gate')?.metrics).toBeNull();
    const b = applyLiveEvent(a, 'ingest.polled', { at: T(5), samples: [{ service: 'payments', errorRate: 0, p95Ms: 1, up: 1 }] });
    expect(named(b, 'payments')?.metrics?.errorRate).toBe(0.22);
  });

  it('opens and closes an incident by id', () => {
    const opened = applyLiveEvent(start, 'incident.opened', { incidentId: 'i1', service: 'payments', openedAt: T(1), level: 2, reason: null });
    // The peak is the level the Incident opened at, not the level the service has by now (4 here).
    expect(named(opened, 'payments')?.openIncident).toEqual({ id: 'i1', openedAt: T(1), peakLevel: 2 });
    expect(applyLiveEvent(opened, 'incident.opened', { incidentId: 'i1', service: 'payments', openedAt: T(1), level: 2, reason: null })).toBe(opened);
    expect(applyLiveEvent(opened, 'incident.closed', { incidentId: 'other', service: 'payments', closedAt: T(2), peakLevel: 4 })).toBe(opened);
    const closed = applyLiveEvent(opened, 'incident.closed', { incidentId: 'i1', service: 'payments', closedAt: T(2), peakLevel: 4 });
    expect(named(closed, 'payments')?.openIncident).toBeNull();
  });

  it('keeps the ingest status unless the event is older', () => {
    const a = applyLiveEvent(start, 'ingest.status', { state: 'stale', at: T(10), lastSuccessAt: T(5) });
    expect(a.ingest?.state).toBe('stale');
    const b = applyLiveEvent(a, 'ingest.status', { state: 'ok', at: T(1), lastSuccessAt: T(1) });
    expect(b).toBe(a);
    const c = applyLiveEvent(a, 'ingest.status', { state: 'ok', at: T(20), lastSuccessAt: T(20) });
    expect(c.ingest?.state).toBe('ok');
  });

  it('picks the newer metrics', () => {
    const a = { errorRate: 0, p95Ms: 1, up: 1, at: T(1) };
    const b = { ...a, at: T(2) };
    expect(newerMetrics(a, b)).toBe(b);
    expect(newerMetrics(b, a)).toBe(b);
    expect(newerMetrics(null, a)).toBe(a);
    expect(newerMetrics(a, null)).toBe(a);
  });
});
