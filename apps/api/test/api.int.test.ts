import type { Server } from 'node:http';
import { validateServiceStates } from '@haunted-ops/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HEADERS_TIMEOUT_MS, REQUEST_TIMEOUT_MS } from '../src/app.js';
import { EventBus } from '../src/events/event-bus.js';
import { SseService } from '../src/events/sse.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { seedServices } from '../src/prisma/seed.js';
import { describeDb, truncateAll } from './db.js';
import { OTHER_BOOT, publishN, seqsOf, wireId } from './support/events.js';
import { startServer, testConfig, type TestServer } from './support/http.js';
import { SseReader } from './support/sse-reader.js';

const signal = { service: 'payments', kind: 'error_rate', value: 0.5, at: '2026-11-12T10:00:00.000Z' } as const;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('GET /healthz without a database', () => {
  it('answers 503 degraded within about 2 s', async () => {
    const server = await startServer({ config: testConfig({ DATABASE_URL: 'postgresql://app@127.0.0.1:1/none' }) });
    try {
      const started = Date.now();
      const res = await fetch(`${server.url}/healthz`);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ status: 'degraded', db: 'down' });
      expect(Date.now() - started).toBeLessThan(3_000);
    } finally {
      await server.close();
    }
  });
});

describeDb('HTTP routes with the Test database', () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startServer();
    const prisma = server.app.get(PrismaService).client;
    await truncateAll(prisma);
    await seedServices(prisma);
  });
  afterAll(async () => {
    await server.close();
  });

  it('GET /healthz answers ok when the database is up', async () => {
    const res = await fetch(`${server.url}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', db: 'up' });
  });

  it('GET /api/services answers valid Service state in room order', async () => {
    const res = await fetch(`${server.url}/api/services`);
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    const result = validateServiceStates(body);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.map((s) => s.name)).toEqual(['gate', 'orders', 'payments', 'ledger']);
  });
});

describe('GET /api/events end to end', () => {
  let server: TestServer;
  let bus: EventBus;

  beforeAll(async () => {
    server = await startServer({ config: testConfig({ SSE_MAX_CLIENTS: '3', SSE_MAX_CLIENTS_PER_IP: '5' }) });
    bus = server.app.get(EventBus);
  });
  afterAll(async () => {
    await server.close();
  });

  it('streams with SSE headers and connected, survives a drop and resumes without gaps or repeats', async () => {
    const boot = bus.bootId;
    const first = await fetch(`${server.url}/api/events`);
    expect(first.status).toBe(200);
    expect(first.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(first.headers.get('cache-control')).toBe('no-cache');
    expect(first.headers.get('x-accel-buffering')).toBe('no');
    const a = new SseReader(first);
    expect(await a.take(1)).toEqual([{ event: 'connected', data: { bootId: boot } }]);
    const base = bus.buffer.latestId();

    bus.publish('signal.recorded', signal);
    bus.publish('signal.recorded', signal);
    const got = await a.take(2);
    expect(seqsOf(got, boot)).toEqual([base + 1, base + 2]);
    expect(got[0]).toMatchObject({ id: wireId(boot, base + 1), event: 'signal.recorded', data: signal });
    await a.cancel();

    // Events published while the client is away.
    await sleep(50);
    publishN(bus, 3);

    const resumed = await fetch(`${server.url}/api/events`, { headers: { 'Last-Event-ID': wireId(boot, base + 2) } });
    const b = new SseReader(resumed);
    const replay = await b.take(4);
    expect(replay[0]?.event).toBe('connected');
    expect(seqsOf(replay, boot)).toEqual([base + 3, base + 4, base + 5]);
    publishN(bus, 1);
    expect(seqsOf(await b.take(1), boot)).toEqual([base + 6]);
    await b.cancel();

    const viaQuery = await fetch(`${server.url}/api/events?lastEventId=${wireId(boot, base + 4)}`);
    const c = new SseReader(viaQuery);
    expect(seqsOf(await c.take(3), boot)).toEqual([base + 5, base + 6]);
    await c.cancel();
  });

  it('sends resync for an id the server cannot resume: ahead, malformed, another boot', async () => {
    const cases: [Record<string, string>, string, string][] = [
      [{ 'Last-Event-ID': wireId(bus.bootId, 999_999) }, '', 'ahead'],
      [{}, '?lastEventId=abc', 'malformed'],
      [{ 'Last-Event-ID': '7' }, '', 'malformed'],
      [{ 'Last-Event-ID': wireId(OTHER_BOOT, 1) }, '', 'restarted'],
    ];
    for (const [headers, query, reason] of cases) {
      const r = new SseReader(await fetch(`${server.url}/api/events${query}`, { headers }));
      expect(await r.take(2)).toEqual([
        { event: 'connected', data: { bootId: bus.bootId } },
        { event: 'resync', data: { reason } },
      ]);
      await r.cancel();
    }
  });

  it('answers 503 with Retry-After at SSE_MAX_CLIENTS and frees slots on disconnect', async () => {
    await sleep(100);
    const sse = server.app.get(SseService);
    expect(sse.openCount).toBe(0);
    const readers = [];
    for (let i = 0; i < 3; i++) readers.push(new SseReader(await fetch(`${server.url}/api/events`)));
    const over = await fetch(`${server.url}/api/events`);
    expect(over.status).toBe(503);
    expect(over.headers.get('retry-after')).toBe('5');
    expect(await over.json()).toMatchObject({ error: 'unavailable' });
    for (const r of readers) await r.cancel();
    await sleep(100);
    expect(sse.openCount).toBe(0);
  });
});

describe('per-IP cap and trust proxy', () => {
  it('without trusted proxies, X-Forwarded-For is ignored and one client IP gets at most SSE_MAX_CLIENTS_PER_IP streams', async () => {
    const server = await startServer({ config: testConfig({ SSE_MAX_CLIENTS_PER_IP: '2', TRUST_PROXY_HOPS: '0' }) });
    try {
      const readers = [];
      for (const xff of ['192.0.2.1', '192.0.2.2']) {
        const res = await fetch(`${server.url}/api/events`, { headers: { 'X-Forwarded-For': xff } });
        expect(res.status).toBe(200);
        readers.push(new SseReader(res));
      }
      const third = await fetch(`${server.url}/api/events`, { headers: { 'X-Forwarded-For': '192.0.2.3' } });
      expect(third.status).toBe(503);
      expect(third.headers.get('retry-after')).toBe('5');
      await third.arrayBuffer();
      // Closing one stream releases its slot.
      await readers[0]?.cancel();
      await sleep(100);
      const again = await fetch(`${server.url}/api/events`);
      expect(again.status).toBe(200);
      readers.push(new SseReader(again));
      for (const r of readers) await r.cancel();
    } finally {
      await server.close();
    }
  });

  it('with TRUST_PROXY_HOPS=1, the address from X-Forwarded-For is the client IP', async () => {
    const server = await startServer({ config: testConfig({ SSE_MAX_CLIENTS_PER_IP: '1', TRUST_PROXY_HOPS: '1' }) });
    try {
      const a = await fetch(`${server.url}/api/events`, { headers: { 'X-Forwarded-For': '192.0.2.10' } });
      const b = await fetch(`${server.url}/api/events`, { headers: { 'X-Forwarded-For': '192.0.2.11' } });
      const a2 = await fetch(`${server.url}/api/events`, { headers: { 'X-Forwarded-For': '192.0.2.10' } });
      expect([a.status, b.status, a2.status]).toEqual([200, 200, 503]);
      await a2.arrayBuffer();
      const sse = server.app.get(SseService);
      expect(sse.openCountFor('192.0.2.10')).toBe(1);
      expect(sse.openCountFor('192.0.2.11')).toBe(1);
      expect((server.app.getHttpAdapter().getInstance() as { get(k: string): unknown }).get('trust proxy')).toBe(1);
      await new SseReader(a).cancel();
      await new SseReader(b).cancel();
    } finally {
      await server.close();
    }
  });
});

describe('HTTP server timeouts', () => {
  it('sets request and headers timeouts explicitly by default', async () => {
    const server = await startServer();
    try {
      const http = server.app.getHttpServer() as Server;
      expect(http.requestTimeout).toBe(REQUEST_TIMEOUT_MS);
      expect(http.headersTimeout).toBe(HEADERS_TIMEOUT_MS);
      expect(http.headersTimeout).toBeLessThanOrEqual(http.requestTimeout);
      expect(http.timeout).toBe(0);
    } finally {
      await server.close();
    }
  });

  it('an SSE stream outlives the request timeout', async () => {
    const server = await startServer({ timeouts: { requestTimeoutMs: 300, headersTimeoutMs: 200, keepAliveTimeoutMs: 100 } });
    try {
      const bus = server.app.get(EventBus);
      const r = new SseReader(await fetch(`${server.url}/api/events`));
      await r.take(1);
      await sleep(900);
      publishN(bus, 1);
      expect(seqsOf(await r.take(1), bus.bootId)).toEqual([1]);
      await r.cancel();
    } finally {
      await server.close();
    }
  });
});

describe('shutdown', () => {
  it('ends every open stream and closes the bus', async () => {
    const server = await startServer();
    const reader = new SseReader(await fetch(`${server.url}/api/events`));
    await sleep(50);
    const bus = server.app.get(EventBus);
    const closing = server.close();
    expect(await reader.waitForEnd()).toBe(true);
    await closing;
    expect(bus.isClosed).toBe(true);
  });
});
