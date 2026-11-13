import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import type { PrismaClient } from '../src/prisma/client.js';
import { seedServices } from '../src/prisma/seed.js';
import { PrismaIngestStore, signalRows } from '../src/ingest/store.js';
import { describeDb, testPrisma, truncateAll } from './db.js';

const T = new Date('2026-11-13T10:00:00.000Z');
const later = (s: number): Date => new Date(T.getTime() + s * 1000);

describeDb('ingest store (Test database)', () => {
  let prisma: PrismaClient;
  let store: PrismaIngestStore;

  beforeAll(() => {
    prisma = testPrisma();
    store = new PrismaIngestStore(prisma);
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await truncateAll(prisma);
    await seedServices(prisma);
  });

  const openCount = (name: string): Promise<number> =>
    prisma.incident.count({ where: { service: { name }, closedAt: null } });

  it('inserts one Signal per non-null value with the poll time', async () => {
    const rows = [
      ...signalRows('payments', { errorRate: 0.22, p95Ms: null, up: 1 }, T),
      ...signalRows('ledger', { errorRate: null, p95Ms: null, up: 0 }, T),
    ];
    await store.insertSignals(rows);
    const stored = await prisma.signal.findMany({ include: { service: true }, orderBy: [{ serviceId: 'asc' }, { kind: 'asc' }] });
    expect(stored).toHaveLength(3);
    expect(stored.every((s) => s.at.getTime() === T.getTime())).toBe(true);
    const ledger = stored.filter((s) => s.service.name === 'ledger');
    expect(ledger.map((s) => [s.kind, s.value])).toEqual([['up', 0]]);
    expect(stored.some((s) => s.kind === 'p95_ms')).toBe(false);
  });

  it('writes level and reason, and clears both together', async () => {
    await store.applyChange({
      name: 'payments',
      haunt: { level: 2, reason: { kind: 'error_rate', value: 0.25 } },
      incident: { kind: 'none' },
      incidentId: null,
      at: T,
    });
    let row = await prisma.service.findUniqueOrThrow({ where: { name: 'payments' } });
    expect([row.hauntLevel, row.reasonKind, row.reasonValue]).toEqual([2, 'error_rate', 0.25]);
    await store.applyChange({ name: 'payments', haunt: { level: 0, reason: null }, incident: { kind: 'none' }, incidentId: null, at: T });
    row = await prisma.service.findUniqueOrThrow({ where: { name: 'payments' } });
    expect([row.hauntLevel, row.reasonKind, row.reasonValue]).toEqual([0, null, null]);
  });

  it('opens, raises and closes an Incident, and loads the open one', async () => {
    const opened = await store.applyChange({
      name: 'ledger',
      haunt: { level: 4, reason: { kind: 'down', value: 0 } },
      incident: { kind: 'open', peakLevel: 2 },
      incidentId: null,
      at: T,
    });
    expect(opened.created).toBe(true);
    expect(opened.incident?.peakLevel).toBe(2);
    expect(opened.incident?.openedAt.getTime()).toBe(T.getTime());
    const loaded = (await store.loadServices()).find((s) => s.name === 'ledger');
    expect(loaded?.level).toBe(4);
    expect(loaded?.reason).toEqual({ kind: 'down', value: 0 });
    expect(loaded?.openIncident?.id).toBe(opened.incident?.id);

    const id = opened.incident?.id as string;
    const raised = await store.applyChange({ name: 'ledger', haunt: null, incident: { kind: 'raise_peak', peakLevel: 4 }, incidentId: id, at: later(5) });
    expect(raised.incident?.peakLevel).toBe(4);
    expect(raised.updatedAt).toBeNull();

    const closed = await store.applyChange({ name: 'ledger', haunt: null, incident: { kind: 'close', peakLevel: 4 }, incidentId: id, at: later(60) });
    expect(closed.closedAt?.getTime()).toBe(later(60).getTime());
    expect(await openCount('ledger')).toBe(0);
    const row = await prisma.incident.findUniqueOrThrow({ where: { id } });
    expect([row.peakLevel, row.closedAt?.getTime()]).toEqual([4, later(60).getTime()]);

    // After a close, a new Incident may open.
    const again = await store.applyChange({ name: 'ledger', haunt: null, incident: { kind: 'open', peakLevel: 3 }, incidentId: null, at: later(120) });
    expect(again.created).toBe(true);
    expect(again.incident?.id).not.toBe(id);
  });

  it('rejects a second open Incident at the database and reuses the open one in the store', async () => {
    const first = await store.applyChange({ name: 'gate', haunt: null, incident: { kind: 'open', peakLevel: 2 }, incidentId: null, at: T });
    const service = await prisma.service.findUniqueOrThrow({ where: { name: 'gate' } });
    await expect(prisma.incident.create({ data: { serviceId: service.id, peakLevel: 2 } })).rejects.toThrow();

    const second = await store.applyChange({ name: 'gate', haunt: null, incident: { kind: 'open', peakLevel: 3 }, incidentId: null, at: later(5) });
    expect(second.created).toBe(false);
    expect(second.incident?.id).toBe(first.incident?.id);
    expect(second.incident?.peakLevel).toBe(3);
    expect(await openCount('gate')).toBe(1);
  });

  it('rolls the Service write back when the Incident write fails', async () => {
    await expect(
      store.applyChange({
        name: 'orders',
        haunt: { level: 3, reason: { kind: 'p95', value: 3500 } },
        incident: { kind: 'raise_peak', peakLevel: 3 },
        incidentId: 'does-not-exist',
        at: T,
      }),
    ).rejects.toThrow();
    const row = await prisma.service.findUniqueOrThrow({ where: { name: 'orders' } });
    expect([row.hauntLevel, row.reasonKind]).toEqual([0, null]);
  });

  it('reads the latest Signal of each kind from the recent window', async () => {
    await store.insertSignals([
      ...signalRows('orders', { errorRate: 0.01, p95Ms: 300, up: 1 }, T),
      ...signalRows('orders', { errorRate: 0.02, p95Ms: null, up: 1 }, later(5)),
      ...signalRows('gate', { errorRate: 0, p95Ms: 90, up: 1 }, later(-300)),
    ]);
    const recent = await store.recentMetrics(later(-60));
    expect(recent.get('orders')).toEqual({ errorRate: 0.02, p95Ms: 300, up: 1, at: later(5).toISOString() });
    expect(recent.has('gate')).toBe(false);
  });
});
