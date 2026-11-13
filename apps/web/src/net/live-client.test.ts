import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IngestStatus, ServiceState } from '@haunted-ops/shared';
import { BOOT_A, OK_STATUS, SAMPLE_SERVICES, eventSourceRegistry, fakeFetch, flush } from '../test/fakes.js';
import type { FetchLike } from './api.js';
import { SseClient } from './sse-client.js';

const BASE = 'http://api.test';
const id = (n: number): string => `${BOOT_A}-${n}`;
const AT = '2026-11-12T10:00:10.000Z';

function setup(fetchImpl?: FetchLike) {
  const es = eventSourceRegistry();
  const http = fakeFetch();
  let services: ServiceState[] = [];
  const ingest: IngestStatus[] = [];
  const client = new SseClient({
    baseUrl: BASE,
    createEventSource: es.factory,
    fetchImpl: fetchImpl ?? http.impl,
    random: () => 0.5,
    onServices: (s) => {
      services = s;
    },
    onIngest: (s) => ingest.push(s),
    onConnection: () => undefined,
  });
  return { client, es, http, ingest, services: () => services };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-12T10:00:00.000Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('SseClient live events', () => {
  it('loads the services and the ingest status on connect and on resync', async () => {
    const t = setup();
    t.client.start();
    t.es.latest().connect();
    await flush();
    expect(t.http.urls).toEqual([`${BASE}/api/services`]);
    expect(t.http.statusUrls).toEqual([`${BASE}/api/ingest/status`]);
    expect(t.ingest).toEqual([OK_STATUS]);
    t.es.latest().emit('resync', { reason: 'too_old' });
    await flush();
    expect(t.http.urls).toHaveLength(2);
    expect(t.http.statusUrls).toHaveLength(2);
    t.client.stop();
  });

  it('applies ingest.polled, incident.opened, incident.closed and ingest.status without a reload', async () => {
    const t = setup();
    t.client.start();
    t.es.latest().connect();
    await flush();
    const es = t.es.latest();
    es.emit(
      'ingest.polled',
      { at: AT, samples: [{ service: 'payments', errorRate: 0.22, p95Ms: null, up: 1 }] },
      id(1),
    );
    expect(t.services().find((s) => s.name === 'payments')?.metrics).toEqual({ errorRate: 0.22, p95Ms: null, up: 1, at: AT });
    es.emit('incident.opened', { incidentId: 'i1', service: 'payments', openedAt: AT, level: 2, reason: null }, id(2));
    expect(t.services().find((s) => s.name === 'payments')?.openIncident).toEqual({ id: 'i1', openedAt: AT, peakLevel: 2 });
    es.emit('incident.closed', { incidentId: 'i1', service: 'payments', closedAt: AT, peakLevel: 4 }, id(3));
    expect(t.services().find((s) => s.name === 'payments')?.openIncident).toBeNull();
    es.emit('ingest.status', { state: 'stale', at: AT, lastSuccessAt: '2026-11-12T10:00:05.000Z' }, id(4));
    expect(t.ingest.at(-1)?.state).toBe('stale');
    expect(t.client.resumeId).toBe(id(4));
    expect(t.http.urls).toHaveLength(1);
    t.client.stop();
  });

  it('applies the same event twice as once and drops an invalid payload', async () => {
    const t = setup();
    t.client.start();
    t.es.latest().connect();
    await flush();
    const polled = { at: AT, samples: [{ service: 'gate', errorRate: 0, p95Ms: 100, up: 1 }] };
    t.es.latest().emit('ingest.polled', polled, id(1));
    const once = t.services();
    t.es.latest().emit('ingest.polled', polled, id(1));
    expect(t.services()).toEqual(once);
    t.es.latest().emit('ingest.polled', { at: 'nope', samples: [] }, id(2));
    t.es.latest().emit('ingest.status', { state: 'maybe' }, id(3));
    expect(t.services()).toEqual(once);
    expect(t.ingest).toEqual([OK_STATUS]);
    t.client.stop();
  });

  it('keeps the previous status when the status request fails', async () => {
    const http = fakeFetch();
    const failing: FetchLike = (url) =>
      url.endsWith('/api/ingest/status') ? Promise.reject(new Error('down')) : http.impl(url);
    const t = setup(failing);
    t.client.start();
    t.es.latest().connect();
    await flush();
    expect(t.services()).toEqual(SAMPLE_SERVICES);
    expect(t.ingest).toEqual([]);
    t.client.stop();
  });
});
