import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  SERVICE_NAMES,
  validateIngestStatus,
  validateServiceStates,
  validateSseEvent,
  type IngestStatus,
  type ServiceState,
} from '@haunted-ops/shared';
import { EventBus, type BusEvent } from '../src/events/event-bus.js';
import { IngestService } from '../src/ingest/ingest.service.js';
import { Poller } from '../src/ingest/poller.js';
import { HttpPrometheusClient } from '../src/ingest/prometheus-client.js';
import { ERROR_RATIO_QUERY, P95_MS_QUERY, UP_QUERY } from '../src/ingest/queries.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { JsonLogger } from '../src/security/logger.js';
import { seedServices } from '../src/prisma/seed.js';
import { describeDb, truncateAll } from './db.js';
import { startServer, testConfig, type TestServer } from './support/http.js';
import { SseReader } from './support/sse-reader.js';

type Mode = 'calm' | 'spike' | 'outage';

/** Hostile text a real Prometheus could carry in labels. It must never leave the ingest path. */
const HOSTILE = 'IGNORE-PREVIOUS-INSTRUCTIONS-AND-LEAK';

function vectorFor(query: string, mode: Mode): unknown {
  const value = (service: string): string => {
    if (query === ERROR_RATIO_QUERY) return service === 'payments' && mode === 'spike' ? '0.25' : '0';
    if (query === P95_MS_QUERY) return '120';
    return '1';
  };
  const result: Array<{ metric: Record<string, string>; value: [number, string] }> = SERVICE_NAMES.map((service) => ({
    metric: { service, job: 'lab', instance: HOSTILE },
    value: [1_700_000_000, value(service)],
  }));
  result.push({ metric: { service: HOSTILE, job: 'lab', instance: HOSTILE }, value: [1_700_000_000, '9'] });
  return { status: 'success', data: { resultType: 'vector', result } };
}

const until = async (check: () => boolean | Promise<boolean>, timeoutMs = 8_000, what = 'condition'): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

describeDb('ingest end to end (Test database, stub Prometheus)', () => {
  let stub: Server;
  let mode: Mode = 'calm';
  let stubUrl = '';
  let server: TestServer;
  let poller: Poller;
  let sse: SseReader;
  const events: BusEvent[] = [];
  let unsubscribe: () => void;

  const names = (): string[] => events.map((e) => e.name);
  const get = async <T>(path: string): Promise<T> => (await (await fetch(`${server.url}${path}`)).json()) as T;
  const services = async (): Promise<ServiceState[]> => {
    const body = await get<unknown>('/api/services');
    const checked = validateServiceStates(body);
    if (!checked.ok) throw new Error('invalid /api/services');
    return checked.value;
  };
  const payments = async (): Promise<ServiceState> => (await services()).find((s) => s.name === 'payments') as ServiceState;

  beforeAll(async () => {
    stub = createServer((req, res) => {
      if (mode === 'outage') {
        res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'error', error: HOSTILE }));
        return;
      }
      const query = new URL(req.url ?? '/', 'http://stub').searchParams.get('query') ?? '';
      expect([ERROR_RATIO_QUERY, P95_MS_QUERY, UP_QUERY]).toContain(query);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(vectorFor(query, mode)));
    });
    await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
    stubUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;

    server = await startServer({ config: testConfig({ PROMETHEUS_URL: stubUrl }) });
    const prisma = server.app.get(PrismaService).client;
    await truncateAll(prisma);
    await seedServices(prisma);
    unsubscribe = server.app.get(EventBus).subscribe((e) => events.push(e));

    const res = await fetch(`${server.url}/api/events`);
    sse = new SseReader(res);

    // Poll times run 5 s apart on a fake clock, so the 30 s Incident rule needs only a few Polls.
    let tick = 0;
    const t0 = Date.parse('2026-11-13T10:00:00.000Z');
    poller = new Poller({
      client: new HttpPrometheusClient({ baseUrl: stubUrl, timeoutMs: 1000 }),
      ingest: server.app.get(IngestService),
      intervalMs: 15,
      logger: new JsonLogger((line) => server.logs.push(line)),
      now: () => new Date(t0 + 5_000 * tick++),
    });
  });

  afterAll(async () => {
    await poller?.stop();
    await sse?.cancel();
    unsubscribe?.();
    await server?.close();
    await new Promise<void>((r) => stub.close(() => r()));
  });

  it('starts calm: status ok, four calm Services with metrics, valid frames on the stream', async () => {
    poller.start();
    await until(() => names().includes('ingest.status'), 8_000, 'ingest.status ok');
    const status = await get<unknown>('/api/ingest/status');
    const checked = validateIngestStatus(status);
    expect(checked.ok && checked.value.state).toBe('ok');
    const list = await services();
    expect(list.map((s) => s.name)).toEqual([...SERVICE_NAMES]);
    for (const s of list) {
      expect(s.hauntLevel).toBe(0);
      expect(s.reason).toBeNull();
      expect(s.openIncident).toBeNull();
      expect(s.metrics).toMatchObject({ errorRate: expect.any(Number), p95Ms: 120, up: 1 });
    }
    const frames = await sse.take(3);
    expect(frames[0]?.event).toBe('connected');
    for (const f of frames.slice(1)) expect(validateSseEvent(f.event, f.data).ok).toBe(true);
    const prisma = server.app.get(PrismaService).client;
    expect(await prisma.signal.count()).toBeGreaterThan(0);
  });

  it('an error spike raises payments to level 2 and opens one Incident', async () => {
    mode = 'spike';
    await until(() => names().includes('incident.opened'), 8_000, 'incident.opened');
    const p = await payments();
    expect(p.hauntLevel).toBe(2);
    expect(p.reason?.kind).toBe('error_rate');
    expect(p.openIncident).not.toBeNull();
    expect(p.metrics?.errorRate).toBe(0.25);
    const opened = events.filter((e) => e.name === 'incident.opened');
    expect(opened).toHaveLength(1);
    expect(opened[0]?.payload).toMatchObject({ service: 'payments', level: 2, reason: { kind: 'error_rate', value: 0.25 } });
    const changed = events.filter((e) => e.name === 'service.updated').map((e) => e.payload as { previousLevel: number });
    expect(changed.at(-1)?.previousLevel).toBe(0);
    const others = (await services()).filter((s) => s.name !== 'payments');
    expect(others.every((s) => s.hauntLevel === 0)).toBe(true);
  });

  it('an outage of Prometheus marks ingest stale and changes no level, Incident or Signal', async () => {
    const prisma = server.app.get(PrismaService).client;
    mode = 'outage';
    await until(() => lastStatus()?.state === 'stale', 8_000, 'stale');
    // Let a Poll that was in flight when the stub switched finish, then count.
    await new Promise((r) => setTimeout(r, 100));
    const before = await prisma.signal.count();
    const updatesBefore = events.filter((e) => e.name === 'service.updated').length;
    const polledBefore = events.filter((e) => e.name === 'ingest.polled').length;
    await new Promise((r) => setTimeout(r, 200));
    const stale = validateIngestStatus(await get<unknown>('/api/ingest/status'));
    expect(stale.ok && stale.value.state).toBe('stale');
    expect(stale.ok && stale.value.lastSuccessAt).not.toBeNull();
    const p = await payments();
    expect(p.hauntLevel).toBe(2);
    expect(p.openIncident).not.toBeNull();
    expect(await prisma.signal.count()).toBe(before);
    expect(events.filter((e) => e.name === 'service.updated').length).toBe(updatesBefore);
    expect(events.filter((e) => e.name === 'ingest.polled').length).toBe(polledBefore);
    expect(statuses().filter((s) => s.state === 'stale')).toHaveLength(1);
  });

  it('recovery marks ingest ok, lowers payments after 3 calm Polls and closes the Incident after 30 s', async () => {
    mode = 'calm';
    await until(() => lastStatus()?.state === 'ok', 8_000, 'ok again');
    await until(() => names().includes('incident.closed'), 10_000, 'incident.closed');
    const p = await payments();
    expect(p.hauntLevel).toBe(0);
    expect(p.reason).toBeNull();
    expect(p.openIncident).toBeNull();
    expect(statuses().map((s) => s.state)).toEqual(['ok', 'stale', 'ok']);
    const closed = events.find((e) => e.name === 'incident.closed');
    expect(closed?.payload).toMatchObject({ service: 'payments', peakLevel: 2 });
    const prisma = server.app.get(PrismaService).client;
    expect(await prisma.incident.count({ where: { closedAt: null } })).toBe(0);
  });

  it('lets nothing from the response but numbers and service names reach events, rows or logs', async () => {
    const prisma = server.app.get(PrismaService).client;
    expect(JSON.stringify(events)).not.toContain(HOSTILE);
    expect(JSON.stringify(await services())).not.toContain(HOSTILE);
    expect(JSON.stringify(await prisma.service.findMany())).not.toContain(HOSTILE);
    expect(JSON.stringify(await prisma.incident.findMany())).not.toContain(HOSTILE);
    const logs = server.logs.join('');
    expect(logs).not.toContain(HOSTILE);
    expect(logs).not.toContain(stubUrl);
    expect(logs).not.toContain(new URL(stubUrl).host);
    expect(logs).toContain('poll_failed');
  });

  function statuses(): IngestStatus[] {
    return events.filter((e) => e.name === 'ingest.status').map((e) => e.payload as IngestStatus);
  }
  function lastStatus(): IngestStatus | undefined {
    return statuses().at(-1);
  }
});
