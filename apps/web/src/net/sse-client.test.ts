import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServiceState } from '@haunted-ops/shared';
import { BOOT_A, BOOT_B, SAMPLE_SERVICES, deferredFetch, eventSourceRegistry, fakeFetch, flush } from '../test/fakes.js';
import type { FetchLike } from './api.js';
import { SseClient, mergeByUpdatedAt, sortByRoom } from './sse-client.js';
import type { ConnectionStatus } from './status.js';

const BASE = 'http://api.test';
const id = (boot: string, n: number): string => `${boot}-${n}`;

function setup(opts: { random?: () => number; fetchImpl?: FetchLike } = {}) {
  const es = eventSourceRegistry();
  const http = fakeFetch();
  const statuses: ConnectionStatus[] = [];
  let services: ServiceState[] = [];
  const network = new EventTarget() as EventTarget & { navigator: { onLine: boolean } };
  network.navigator = { onLine: true };
  const client = new SseClient({
    baseUrl: BASE,
    createEventSource: es.factory,
    fetchImpl: opts.fetchImpl ?? http.impl,
    random: opts.random ?? (() => 0.5),
    network: network as never,
    onServices: (s) => {
      services = s;
    },
    onConnection: (c) => statuses.push(c.status),
  });
  return { client, es, http, statuses, network, services: () => services, status: () => client.connection.status };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-12T10:00:00.000Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('SseClient', () => {
  it('goes live on open and loads services on connected', async () => {
    const t = setup();
    t.client.start();
    expect(t.es.latest().url).toBe(`${BASE}/api/events`);
    expect(t.status()).toBe('reconnecting');
    t.es.latest().connect();
    await flush();
    expect(t.status()).toBe('live');
    expect(t.services()).toEqual(SAMPLE_SERVICES);
    t.client.stop();
  });

  it('reconnects with backoff and sends the last event id', async () => {
    const t = setup({ random: () => 0 });
    t.client.start();
    t.es.latest().connect();
    t.es.latest().emit('signal.recorded', { service: 'gate', kind: 'up', value: 1, at: '2026-11-12T10:00:00.000Z' }, id(BOOT_A, 41));
    t.es.latest().emit('heartbeat', { at: '2026-11-12T10:00:00.000Z' });
    t.es.latest().fail();
    expect(t.status()).toBe('reconnecting');
    expect(t.es.created[0]?.closed).toBe(true);
    vi.advanceTimersByTime(499);
    expect(t.es.created).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(t.es.latest().url).toBe(`${BASE}/api/events?lastEventId=${id(BOOT_A, 41)}`);
    t.client.stop();
  });

  it('honours Retry-After from a 503 when it is longer than the backoff', () => {
    const t = setup({ random: () => 0 });
    t.client.start();
    t.es.latest().fail({ status: 503, retryAfterMs: 5_000 });
    vi.advanceTimersByTime(4_999);
    expect(t.es.created).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(t.es.created).toHaveLength(2);
    // A shorter Retry-After never shortens the backoff (attempt 1: 1 s at random 0).
    t.es.latest().fail({ status: 503, retryAfterMs: 10 });
    vi.advanceTimersByTime(999);
    expect(t.es.created).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(t.es.created).toHaveLength(3);
    // An absurd Retry-After is capped at 5 minutes.
    t.es.latest().fail({ status: 503, retryAfterMs: 86_400_000 });
    vi.advanceTimersByTime(300_000);
    expect(t.es.created).toHaveLength(4);
    t.client.stop();
  });

  it('clears the resume id on resync and reloads services', async () => {
    const t = setup({ random: () => 0 });
    t.client.start();
    t.es.latest().connect();
    await flush();
    t.es.latest().emit('signal.recorded', { service: 'gate', kind: 'up', value: 1, at: '2026-11-12T10:00:00.000Z' }, id(BOOT_A, 9));
    expect(t.client.resumeId).toBe(id(BOOT_A, 9));
    t.es.latest().emit('resync', { reason: 'too_old' });
    await flush();
    expect(t.client.resumeId).toBeNull();
    expect(t.http.urls).toHaveLength(2);
    t.es.latest().fail();
    vi.advanceTimersByTime(1_000);
    expect(t.es.latest().url).toBe(`${BASE}/api/events`);
    t.client.stop();
  });

  it('on a new boot id, drops the old resume id and refetches the snapshot', async () => {
    const t = setup({ random: () => 0 });
    t.client.start();
    t.es.latest().connect(BOOT_A);
    await flush();
    t.es.latest().emit('signal.recorded', { service: 'gate', kind: 'up', value: 1, at: '2026-11-12T10:00:00.000Z' }, id(BOOT_A, 3));
    t.es.latest().fail();
    vi.advanceTimersByTime(1_000);
    expect(t.es.latest().url).toContain(`lastEventId=${id(BOOT_A, 3)}`);
    const before = t.http.urls.length;
    t.es.latest().connect(BOOT_B);
    await flush();
    expect(t.client.resumeId).toBeNull();
    expect(t.http.urls.length).toBe(before + 1);
    t.client.stop();
  });

  it('a snapshot fetched before a newer service.updated does not overwrite it', async () => {
    const d = deferredFetch();
    const t = setup({ fetchImpl: d.impl });
    t.client.start();
    t.es.latest().connect();
    await flush();
    expect(d.pending).toHaveLength(1);
    // While the snapshot is in flight, payments goes dark.
    const dark: ServiceState = { name: 'payments', room: { x: 0, y: 1 }, hauntLevel: 4, reason: null, metrics: null, openIncident: null, updatedAt: '2026-11-12T10:00:05.000Z', hunt: null };
    t.es.latest().emit('service.updated', { service: dark, previousLevel: 0 }, id(BOOT_A, 1));
    // The snapshot was taken earlier and still says calm.
    const stale = SAMPLE_SERVICES.map((s) => (s.name === 'payments' ? { ...s, hauntLevel: 0 } : s));
    d.pending[0]?.resolve(stale);
    await flush();
    expect(t.services().find((s) => s.name === 'payments')).toEqual(dark);
    expect(t.services().map((s) => s.name)).toEqual(['gate', 'orders', 'payments', 'ledger']);
    t.client.stop();
  });

  it('coalesces concurrent snapshot loads into one follow-up', async () => {
    const d = deferredFetch();
    const t = setup({ fetchImpl: d.impl });
    t.client.start();
    t.es.latest().connect();
    t.es.latest().emit('resync', { reason: 'restarted' });
    t.es.latest().emit('resync', { reason: 'restarted' });
    await flush();
    expect(d.pending).toHaveLength(1);
    d.pending[0]?.resolve(SAMPLE_SERVICES);
    await flush();
    expect(d.pending).toHaveLength(2);
    d.pending[1]?.resolve(SAMPLE_SERVICES);
    await flush();
    expect(d.pending).toHaveLength(2);
    t.client.stop();
  });

  it('keeps services ordered by room (y, then x), also when a new one appears', async () => {
    const t = setup({ fetchImpl: fakeFetch(() => [SAMPLE_SERVICES[3], SAMPLE_SERVICES[0]]).impl });
    t.client.start();
    t.es.latest().connect();
    await flush();
    expect(t.services().map((s) => s.name)).toEqual(['gate', 'ledger']);
    t.es.latest().emit('service.updated', { service: SAMPLE_SERVICES[2], previousLevel: 0 }, id(BOOT_A, 1));
    t.es.latest().emit('service.updated', { service: SAMPLE_SERVICES[1], previousLevel: 0 }, id(BOOT_A, 2));
    expect(t.services().map((s) => s.name)).toEqual(['gate', 'orders', 'payments', 'ledger']);
    t.client.stop();
  });

  it('shows offline after 5 failed attempts and keeps retrying at the cap', () => {
    const t = setup({ random: () => 0.999 });
    t.client.start();
    for (let i = 0; i < 5; i++) {
      t.es.latest().fail();
      expect(t.status()).toBe(i < 4 ? 'reconnecting' : 'offline');
      vi.advanceTimersByTime(30_000);
    }
    for (let i = 0; i < 3; i++) {
      const before = t.es.created.length;
      t.es.latest().fail();
      vi.advanceTimersByTime(29_000);
      expect(t.es.created.length).toBe(before);
      vi.advanceTimersByTime(1_000);
      expect(t.es.created.length).toBe(before + 1);
    }
    t.es.latest().open();
    expect(t.status()).toBe('live');
    t.client.stop();
  });

  it('shows offline when the browser reports no network, and reconnects when it returns', () => {
    const t = setup();
    t.client.start();
    t.es.latest().open();
    t.network.dispatchEvent(new Event('offline'));
    expect(t.status()).toBe('offline');
    const before = t.es.created.length;
    t.network.dispatchEvent(new Event('online'));
    expect(t.es.created.length).toBe(before + 1);
    t.client.stop();
  });

  it('applies service.updated and ignores invalid payloads', async () => {
    const t = setup();
    t.client.start();
    t.es.latest().connect();
    await flush();
    const dark = { ...SAMPLE_SERVICES[0], hauntLevel: 4 } as ServiceState;
    t.es.latest().emit('service.updated', { service: dark, previousLevel: 0 }, id(BOOT_A, 7));
    expect(t.services().find((s) => s.name === 'gate')?.hauntLevel).toBe(4);
    t.es.latest().emit('service.updated', { service: { ...dark, hauntLevel: 9 }, previousLevel: 0 }, id(BOOT_A, 8));
    expect(t.services().find((s) => s.name === 'gate')?.hauntLevel).toBe(4);
    t.client.stop();
  });

  it('treats 45 s of silence as a drop', () => {
    const t = setup({ random: () => 0 });
    t.client.start();
    t.es.latest().open();
    vi.advanceTimersByTime(40_000);
    expect(t.status()).toBe('live');
    vi.advanceTimersByTime(10_000);
    expect(t.status()).toBe('reconnecting');
    expect(t.es.created[0]?.closed).toBe(true);
    t.client.stop();
  });

  it('calls only GET /api/services and GET /api/events', async () => {
    const t = setup({ random: () => 0 });
    t.client.start();
    t.es.latest().connect();
    t.es.latest().emit('service.updated', { service: SAMPLE_SERVICES[1], previousLevel: 0 }, id(BOOT_A, 3));
    t.es.latest().fail();
    vi.advanceTimersByTime(1_000);
    t.es.latest().connect();
    t.es.latest().emit('resync', { reason: 'too_old' });
    await flush();
    const paths = [...t.http.urls, ...t.es.created.map((e) => e.url)].map((u) => new URL(u).pathname);
    expect(new Set(paths)).toEqual(new Set(['/api/services', '/api/events']));
    for (const u of t.http.urls) expect(u.startsWith(BASE)).toBe(true);
    t.client.stop();
  });

  it('stop() closes the stream and cancels timers', () => {
    const t = setup();
    t.client.start();
    t.es.latest().fail();
    t.client.stop();
    vi.advanceTimersByTime(60_000);
    expect(t.es.created).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('helpers', () => {
  it('sortByRoom orders by y, then x', () => {
    const shuffled = [SAMPLE_SERVICES[3], SAMPLE_SERVICES[1], SAMPLE_SERVICES[2], SAMPLE_SERVICES[0]] as ServiceState[];
    expect(sortByRoom(shuffled).map((s) => s.name)).toEqual(['gate', 'orders', 'payments', 'ledger']);
  });

  it('mergeByUpdatedAt keeps the newer entry per service', () => {
    const newer = { ...SAMPLE_SERVICES[0], hauntLevel: 3, updatedAt: '2026-11-12T11:00:00.000Z' } as ServiceState;
    const merged = mergeByUpdatedAt([newer], SAMPLE_SERVICES);
    expect(merged.find((s) => s.name === 'gate')).toEqual(newer);
    expect(merged).toHaveLength(4);
    const older = { ...newer, updatedAt: '2026-11-12T09:00:00.000Z' };
    expect(mergeByUpdatedAt([older], SAMPLE_SERVICES).find((s) => s.name === 'gate')).toEqual(SAMPLE_SERVICES[0]);
  });
});
