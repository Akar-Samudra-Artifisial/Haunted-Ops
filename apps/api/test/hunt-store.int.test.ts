import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { validateHuntDetail, validateHuntSummary, validateServiceStates, type HuntStepView } from '@haunted-ops/shared';
import type { PrismaClient } from '../src/prisma/client.js';
import { PrismaHuntStore, utcDayStart } from '../src/hunts/hunt-store.js';
import { toServiceStates } from '../src/services/services.service.js';
import { seedServices } from '../src/prisma/seed.js';
import { describeDb, testPrisma, truncateAll } from './db.js';

const SHA = '65c0fca31d0df62c4bab40d2d854c81b1044c650';
const at = (s: number): Date => new Date(Date.parse('2026-11-13T10:00:00.000Z') + s * 1000);

describeDb('hunt store (Test database)', () => {
  let prisma: PrismaClient;
  let store: PrismaHuntStore;
  let ids: Map<string, string>;
  let incident: { id: string; serviceId: string };

  beforeAll(() => {
    prisma = testPrisma();
    store = new PrismaHuntStore(prisma);
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await truncateAll(prisma);
    await seedServices(prisma);
    ids = new Map((await prisma.service.findMany()).map((s) => [s.name, s.id]));
    await prisma.service.update({ where: { id: ids.get('payments') as string }, data: { hauntLevel: 3, reasonKind: 'error_rate', reasonValue: 0.3 } });
    const row = await prisma.incident.create({ data: { serviceId: ids.get('payments') as string, peakLevel: 3, openedAt: at(0) } });
    incident = { id: row.id, serviceId: row.serviceId };
  });

  const create = (over: Partial<Parameters<PrismaHuntStore['create']>[0]> = {}) =>
    store.create({ incidentId: incident.id, serviceId: incident.serviceId, trigger: 'auto', model: 'claude-sonnet-5.5', ...over });
  const step = (index: number): HuntStepView => ({ index, tool: 'search_errors', summary: `errors payments since 10:0${index}:00`, at: at(index).toISOString() });
  const diagnosis = { culpritDeploy: 'd-7', culpritSha: SHA, culpritService: 'payments' as const, summary: 'The guard was removed.', fixHint: 'Restore it.', cited: ['deploy:d-7', `commit:${SHA}`] };

  it('runs one Hunt through its life and reads it back as valid shared types', async () => {
    const hunt = await create();
    expect(await store.markRunning(hunt.id, at(1))).toBe(true);
    expect(await store.markRunning(hunt.id, at(1))).toBe(false);
    for (let i = 1; i <= 10; i++) await store.addStep(hunt.id, step(i));
    await store.addStep(hunt.id, step(3)); // a repeated index is ignored
    await store.addEvidence(hunt.id, { order: 1, kind: 'deploy', ref: 'deploy:d-7', detail: 'd-7 payments' });
    await store.addEvidence(hunt.id, { order: 2, kind: 'commit', ref: `commit:${SHA}`, detail: 'commit 65c0fca' });
    await store.addEvidence(hunt.id, { order: 3, kind: 'log', ref: 'log:1', detail: 'a line' });
    await store.setProgress(hunt.id, { credits: 0.4, toolCalls: 7 });
    const running = await store.get(hunt.id);
    expect(running).toMatchObject({ status: 'running', reason: null, credits: 0.4, toolCalls: 7, stepCount: 10, evidenceCount: 3, diagnosis: null });
    expect(running?.steps.map((s) => s.index)).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
    expect(running?.allSteps).toHaveLength(10);
    expect(validateHuntDetail(running).ok).toBe(true);

    expect(await store.finish(hunt.id, { status: 'succeeded', reason: 'diagnosed', invalidCheck: null, credits: 0.92, toolCalls: 12, durationMs: 59_000, finishedAt: at(60), diagnosis })).toBe(true);
    expect(await store.finish(hunt.id, { status: 'failed', reason: 'timeout', invalidCheck: null, credits: 9, toolCalls: 99, durationMs: 1, finishedAt: at(61), diagnosis: null })).toBe(false);
    const done = await store.get(hunt.id);
    expect(done).toMatchObject({ status: 'succeeded', reason: 'diagnosed', credits: 0.92, toolCalls: 12, durationMs: 59_000, fixHint: 'Restore it.', diagnosis: { culpritDeploy: 'd-7', culpritService: 'payments', culpritSha: SHA } });
    expect(done?.evidence.map((e) => [e.ref, e.cited])).toEqual([['deploy:d-7', true], [`commit:${SHA}`, true], ['log:1', false]]);
    expect(validateHuntDetail(done).ok).toBe(true);
  });

  it('shows the latest Hunt per Service in the Service state, valid for the shared validator', async () => {
    const old = await create();
    await store.finish(old.id, { status: 'failed', reason: 'timeout', invalidCheck: null, credits: 0.1, toolCalls: 2, durationMs: 9, finishedAt: at(5), diagnosis: null });
    await new Promise((r) => setTimeout(r, 5));
    const latest = await create({ trigger: 'operator' });
    await store.markRunning(latest.id, at(10));
    await store.addStep(latest.id, step(1));
    const map = await store.latestPerService();
    expect([...map.keys()]).toEqual(['payments']);
    expect(map.get('payments')).toMatchObject({ id: latest.id, status: 'running', trigger: 'operator', stepCount: 1 });
    expect(validateHuntSummary(map.get('payments')).ok).toBe(true);
    const rows = await prisma.service.findMany({ include: { incidents: { where: { closedAt: null }, take: 1 } } });
    const states = toServiceStates(rows, new Map(), map);
    expect(validateServiceStates(states).ok).toBe(true);
    expect(states.find((s) => s.name === 'payments')?.hunt?.id).toBe(latest.id);
    expect(states.find((s) => s.name === 'gate')?.hunt).toBeNull();
  });

  it('refuses a false success at the database: a success needs the reason diagnosed and a full diagnosis, and only then', async () => {
    const base = { incidentId: incident.id, serviceId: incident.serviceId, trigger: 'auto' as const, model: 'm', finishedAt: at(1) };
    const full = { culpritDeploy: 'd-7', culpritSha: SHA, culpritService: 'payments', summary: 's' };
    await expect(prisma.hunt.create({ data: { ...base, status: 'succeeded', endReason: 'diagnosed' } })).rejects.toThrow(); // no diagnosis
    await expect(prisma.hunt.create({ data: { ...base, status: 'succeeded', endReason: 'diagnosed', culpritDeploy: 'd-7', culpritSha: SHA, summary: 's' } })).rejects.toThrow(); // no culprit service
    await expect(prisma.hunt.create({ data: { ...base, status: 'succeeded', endReason: 'diagnosed', ...full, culpritService: 'database' } })).rejects.toThrow(); // unknown service
    await expect(prisma.hunt.create({ data: { ...base, status: 'failed', endReason: 'timeout', culpritService: 'payments' } })).rejects.toThrow(); // a culprit service on a failure
    await expect(prisma.hunt.create({ data: { ...base, status: 'failed', endReason: 'foreign_tool', stopDetail: '' } })).rejects.toThrow(); // empty detail
    await expect(prisma.hunt.create({ data: { ...base, status: 'failed', endReason: 'foreign_tool', stopDetail: 'x'.repeat(201) } })).rejects.toThrow(); // long detail
    await expect(prisma.hunt.create({ data: { ...base, status: 'succeeded', ...full } })).rejects.toThrow(); // no reason
    await expect(prisma.hunt.create({ data: { ...base, status: 'succeeded', endReason: 'timeout', ...full } })).rejects.toThrow(); // wrong reason
    await expect(prisma.hunt.create({ data: { ...base, status: 'failed', endReason: 'diagnosed', ...full } })).rejects.toThrow(); // diagnosed but failed
    await expect(prisma.hunt.create({ data: { ...base, status: 'failed', endReason: 'invalid_diagnosis', ...full } })).rejects.toThrow(); // a diagnosis on a failure
    await expect(prisma.hunt.create({ data: { ...base, status: 'succeeded', endReason: 'diagnosed', ...full, culpritSha: 'abc123' } })).rejects.toThrow(); // short SHA
    await expect(prisma.hunt.create({ data: { ...base, status: 'succeeded', endReason: 'diagnosed', ...full, culpritSha: SHA.toUpperCase() } })).rejects.toThrow();
    await expect(prisma.hunt.create({ data: { ...base, status: 'failed', endReason: null } })).rejects.toThrow(); // ended without a reason
    await expect(prisma.hunt.create({ data: { ...base, status: 'running', endReason: 'timeout' } })).rejects.toThrow(); // running with a reason
    await expect(prisma.hunt.create({ data: { ...base, status: 'failed', endReason: 'timeout', credits: -0.1 } })).rejects.toThrow();
    await expect(prisma.huntStep.create({ data: { huntId: (await create()).id, index: 0, tool: 'x', summary: 's', at: at(1) } })).rejects.toThrow();
    await expect(prisma.evidence.create({ data: { huntId: (await create()).id, order: 1, kind: 'log', ref: 'x'.repeat(81), detail: '' } })).rejects.toThrow();
    // The same shapes are fine when they are consistent.
    await expect(prisma.hunt.create({ data: { ...base, status: 'succeeded', endReason: 'diagnosed', ...full } })).resolves.toBeTruthy();
    await expect(prisma.hunt.create({ data: { ...base, status: 'failed', endReason: 'invalid_diagnosis', invalidCheck: 'sha_mismatch' } })).resolves.toBeTruthy();
  });

  it('stores the Service of the culprit, the stop detail and the downstream reason, and reads them back', async () => {
    const h = await create();
    await store.markRunning(h.id, at(1));
    expect(await store.finish(h.id, { status: 'failed', reason: 'foreign_tool', invalidCheck: null, stopDetail: 'fs_read', credits: 0, toolCalls: 5, durationMs: 100, finishedAt: at(2), diagnosis: null })).toBe(true);
    expect(await store.get(h.id)).toMatchObject({ status: 'failed', reason: 'foreign_tool', stopDetail: 'fs_read', diagnosis: null });
    const d = await create();
    await store.markRunning(d.id, at(3));
    await store.finish(d.id, { status: 'succeeded', reason: 'diagnosed', invalidCheck: null, credits: 0.9, toolCalls: 12, durationMs: 100, finishedAt: at(4), diagnosis: { ...diagnosis, culpritService: 'ledger' } });
    const done = await store.get(d.id);
    expect(done).toMatchObject({ status: 'succeeded', stopDetail: null, diagnosis: { culpritService: 'ledger' } });
    expect(validateHuntDetail(done).ok).toBe(true);
    const w = await create();
    expect(await store.finish(w.id, { status: 'cancelled', reason: 'downstream', invalidCheck: null, credits: 0, toolCalls: 0, durationMs: null, finishedAt: at(5), diagnosis: null })).toBe(true);
    expect(await store.get(w.id)).toMatchObject({ status: 'cancelled', reason: 'downstream' });
  });

  it('stores a Hunt withdrawn as diagnosed_upstream with the Service and the id of the Hunt that diagnosed it', async () => {
    const first = await create();
    const h = await create({ cancelled: { reason: 'diagnosed_upstream', at: at(2), diagnosedBy: 'payments', linkedHuntId: first.id } });
    expect(await store.get(h.id)).toMatchObject({ status: 'cancelled', reason: 'diagnosed_upstream', diagnosedBy: 'payments', linkedHuntId: first.id });
    const q = await create();
    expect(await store.finish(q.id, { status: 'cancelled', reason: 'diagnosed_upstream', invalidCheck: null, diagnosedBy: 'orders', linkedHuntId: first.id, credits: 0, toolCalls: 0, durationMs: null, finishedAt: at(3), diagnosis: null })).toBe(true);
    const done = await store.get(q.id);
    expect(done).toMatchObject({ reason: 'diagnosed_upstream', diagnosedBy: 'orders' });
    expect(validateHuntDetail(done).ok).toBe(true);
    const plain = await store.get(first.id);
    expect(plain).toMatchObject({ diagnosedBy: null, linkedHuntId: null });
  });

  it('refuses at the database a withdrawal without the Service, a Service without the reason, and an unknown Service', async () => {
    const base = { incidentId: incident.id, serviceId: incident.serviceId, trigger: 'auto' as const, model: 'm', finishedAt: at(1), status: 'cancelled' as const };
    await expect(prisma.hunt.create({ data: { ...base, endReason: 'diagnosed_upstream' } })).rejects.toThrow();
    await expect(prisma.hunt.create({ data: { ...base, endReason: 'busy', diagnosedBy: 'payments' } })).rejects.toThrow();
    await expect(prisma.hunt.create({ data: { ...base, endReason: 'busy', linkedHuntId: 'cmx' } })).rejects.toThrow();
    await expect(prisma.hunt.create({ data: { ...base, endReason: 'diagnosed_upstream', diagnosedBy: 'database' } })).rejects.toThrow();
    await expect(prisma.hunt.create({ data: { ...base, endReason: 'diagnosed_upstream', diagnosedBy: 'payments' } })).resolves.toBeTruthy();
  });

  it('lists the open Incidents with their Services, oldest first', async () => {
    const orders = ids.get('orders') as string;
    await prisma.incident.create({ data: { serviceId: orders, peakLevel: 4, openedAt: at(-5) } });
    const closed = await prisma.incident.create({ data: { serviceId: ids.get('gate') as string, peakLevel: 2, openedAt: at(-9), closedAt: at(-8) } });
    const open = await store.openIncidents();
    expect(open.map((i) => i.service)).toEqual(['orders', 'payments']);
    expect(open.map((i) => i.level)).toEqual([4, 3]);
    expect(open.every((i) => i.closedAt === null && i.incidentId !== closed.id)).toBe(true);
  });

  it('records a request that is cancelled at once, with its reason and no start time', async () => {
    const h = await create({ cancelled: { reason: 'busy', at: at(2) } });
    expect(await store.get(h.id)).toMatchObject({ status: 'cancelled', reason: 'busy', startedAt: null, finishedAt: at(2).toISOString() });
    expect(await store.markRunning(h.id, at(3))).toBe(false);
  });

  it('adds the credits of the UTC day by their start time, and only those', async () => {
    const run = async (startedAt: Date, credits: number) => {
      const h = await create();
      await store.markRunning(h.id, startedAt);
      await store.finish(h.id, { status: 'failed', reason: 'timeout', invalidCheck: null, credits, toolCalls: 1, durationMs: 1, finishedAt: startedAt, diagnosis: null });
    };
    const now = new Date('2026-11-13T15:00:00.000Z');
    await run(new Date('2026-11-12T23:59:59.999Z'), 5);
    await run(new Date('2026-11-13T00:00:00.000Z'), 0.9);
    await run(new Date('2026-11-13T14:00:00.000Z'), 0.6);
    await run(new Date('2026-11-14T00:00:00.000Z'), 7);
    await create({ cancelled: { reason: 'busy', at: now } });
    expect(await store.creditsToday(now)).toBeCloseTo(1.5, 9);
    expect(await store.creditsToday(new Date('2026-11-14T03:00:00.000Z'))).toBeCloseTo(7, 9);
    expect(utcDayStart(now).toISOString()).toBe('2026-11-13T00:00:00.000Z');
  });

  it('counts the Hunts that started in the UTC day, and stores estimated credits and the daily_limit reason', async () => {
    const run = async (startedAt: Date, estimated: boolean) => {
      const h = await create();
      await store.markRunning(h.id, startedAt);
      await store.finish(h.id, { status: 'failed', reason: 'timeout', invalidCheck: null, credits: 1.5, creditsEstimated: estimated, toolCalls: 1, durationMs: 1, finishedAt: startedAt, diagnosis: null });
      return h.id;
    };
    const now = new Date('2026-11-13T15:00:00.000Z');
    await run(new Date('2026-11-12T23:59:59.999Z'), false);
    const est = await run(new Date('2026-11-13T00:00:00.000Z'), true);
    const exact = await run(new Date('2026-11-13T14:00:00.000Z'), false);
    await create({ cancelled: { reason: 'daily_limit', at: now } });
    expect(await store.startedToday(now)).toBe(2);
    expect(await store.startedToday(new Date('2026-11-14T01:00:00.000Z'))).toBe(0);
    expect(await store.creditsToday(now)).toBeCloseTo(3, 9);
    expect(await store.get(est)).toMatchObject({ credits: 1.5, creditsEstimated: true });
    expect(await store.get(exact)).toMatchObject({ creditsEstimated: false });
    const limited = await prisma.hunt.findFirst({ where: { endReason: 'daily_limit' } });
    expect(limited).toMatchObject({ status: 'cancelled', startedAt: null });
  });

  it('knows the last Hunt that really ran for a Service, and ignores one that never started', async () => {
    expect(await store.lastRunFinishedAt(incident.serviceId)).toBeNull();
    await create({ cancelled: { reason: 'cooldown', at: at(50) } });
    expect(await store.lastRunFinishedAt(incident.serviceId)).toBeNull();
    const h = await create();
    await store.markRunning(h.id, at(10));
    await store.finish(h.id, { status: 'failed', reason: 'timeout', invalidCheck: null, credits: 0, toolCalls: 0, durationMs: 1, finishedAt: at(20), diagnosis: null });
    expect(await store.lastRunFinishedAt(incident.serviceId)).toEqual(at(20));
  });

  it('sweeps queued and running Hunts to failed with api_restart and leaves ended ones', async () => {
    const queued = await create();
    const running = await create();
    await store.markRunning(running.id, at(1));
    const done = await create({ cancelled: { reason: 'disabled', at: at(2) } });
    expect(await store.sweepStale(at(100))).toBe(2);
    for (const h of [queued, running]) expect(await store.get(h.id)).toMatchObject({ status: 'failed', reason: 'api_restart', finishedAt: at(100).toISOString() });
    expect(await store.get(done.id)).toMatchObject({ status: 'cancelled', reason: 'disabled' });
    expect(await store.sweepStale(at(101))).toBe(0);
  });

  it('finds the facts of an Incident and the open Incident of a Service, and counts auto Hunts', async () => {
    expect(await store.incidentFacts(incident.id)).toMatchObject({ service: 'payments', level: 3, reasonKind: 'error_rate', closedAt: null });
    expect(await store.openIncidentOf('payments')).toMatchObject({ incidentId: incident.id });
    expect(await store.openIncidentOf('orders')).toBeNull();
    expect(await store.incidentFacts('cmnoincident00000000000000')).toBeNull();
    expect(await store.hasAutoHunt(incident.id)).toBe(false);
    await create({ trigger: 'operator' });
    expect(await store.hasAutoHunt(incident.id)).toBe(false);
    await create();
    expect(await store.hasAutoHunt(incident.id)).toBe(true);
    await prisma.incident.update({ where: { id: incident.id }, data: { closedAt: at(30) } });
    expect(await store.openIncidentOf('payments')).toBeNull();
    expect((await store.incidentFacts(incident.id))?.closedAt).toEqual(at(30));
  });

  it('removes Hunts, steps and evidence with their Incident', async () => {
    const h = await create();
    await store.addStep(h.id, step(1));
    await store.addEvidence(h.id, { order: 1, kind: 'log', ref: 'log:1', detail: 'x' });
    await prisma.incident.delete({ where: { id: incident.id } });
    expect(await prisma.hunt.count()).toBe(0);
    expect(await prisma.huntStep.count()).toBe(0);
    expect(await prisma.evidence.count()).toBe(0);
  });
});
