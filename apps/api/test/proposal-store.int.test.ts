import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { PROPOSAL_STATUSES, canMove, validateProposalSummary, validateProposalView, type ProposalStatus } from '@haunted-ops/shared';
import type { PrismaClient } from '../src/prisma/client.js';
import { PrismaHuntStore } from '../src/hunts/hunt-store.js';
import { PrismaProposalStore, toProposalSummary, type ProposalPatch } from '../src/fix/proposal-store.js';
import { seedServices } from '../src/prisma/seed.js';
import { describeDb, testDatabaseUrl, testPrisma, truncateAll } from './db.js';

const migrationsDir = fileURLToPath(new URL('../prisma/migrations/', import.meta.url));
const at = (s: number): Date => new Date(Date.parse('2026-11-14T10:00:00.000Z') + s * 1000);
const SHA = 'a'.repeat(40);
const PR = 'https://github.com/Akar-Samudra-Artifisial/Haunted-Lab/pull/7';

const OPEN: ProposalPatch = { kind: 'ai_patch', prNumber: 7, prUrl: PR, branch: 'exorcist/x', baseBranch: 'incident/x', headSha: SHA, openedAt: at(1) };
const MERGED: ProposalPatch = { mergeSha: 'b'.repeat(40), mergedBy: 'octocat', mergedAt: at(2) };

describeDb('proposal store (Test database)', () => {
  let prisma: PrismaClient;
  let hunts: PrismaHuntStore;
  let store: PrismaProposalStore;
  let incident: { id: string; serviceId: string };

  beforeAll(() => {
    prisma = testPrisma();
    hunts = new PrismaHuntStore(prisma);
    store = new PrismaProposalStore(prisma);
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    await truncateAll(prisma);
    await seedServices(prisma);
    const ids = new Map((await prisma.service.findMany()).map((s) => [s.name, s.id]));
    const row = await prisma.incident.create({ data: { serviceId: ids.get('payments') as string, peakLevel: 3, openedAt: at(0) } });
    incident = { id: row.id, serviceId: row.serviceId };
  });

  const hunt = (serviceId = incident.serviceId, incidentId = incident.id) => hunts.create({ incidentId, serviceId, trigger: 'auto', model: 'claude-sonnet-5.5' });
  const create = async (huntId: string) => {
    const rec = await store.create(huntId, at(0));
    if (rec === null) throw new Error('no proposal');
    return rec;
  };

  it('creates a drafting Proposal, reads it back with the hunted Service, and numbers the attempts', async () => {
    const h = await hunt();
    const a = await create(h.id);
    expect(a).toMatchObject({ huntId: h.id, service: 'payments', attempt: 1, status: 'drafting', kind: null, checks: [], credits: 0, agentStarted: false });
    expect(await store.create(h.id, at(1))).toBeNull();
    expect(await store.move(a.id, 'drafting', 'failed', { failReason: 'github_unavailable', finishedAt: at(2) })).toBe(true);
    const b = await create(h.id);
    expect(b.attempt).toBe(2);
    expect((await store.latestOfHunt(h.id))?.id).toBe(b.id);
    expect([...(await store.latestOfHunts([h.id])).values()].map((r) => r.id)).toEqual([b.id]);
    expect(await store.byId('nope')).toBeNull();
  });

  it('moves along the graph with its data in one write, and refuses a stale or skipping move', async () => {
    const h = await hunt();
    const p = await create(h.id);
    expect(await store.move(p.id, 'drafting', 'merged', MERGED)).toBe(false);
    expect(await store.move(p.id, 'open', 'merged', MERGED)).toBe(false);
    expect(await store.move(p.id, 'drafting', 'open', { ...OPEN, checks: [{ name: 'scope', ok: true }, { name: 'tests', ok: true }], credits: 0.9, agentStarted: true })).toBe(true);
    expect(await store.move(p.id, 'drafting', 'open', OPEN)).toBe(false);
    expect(await store.patch(p.id, 'open', { etag: 'W/"abc"' })).toBe(true);
    expect(await store.patch(p.id, 'drafting', { etag: 'other' })).toBe(false);
    expect(await store.move(p.id, 'open', 'merged', MERGED)).toBe(true);
    expect(await store.move(p.id, 'merged', 'deployed', { deployedAt: at(3), finishedAt: at(3) })).toBe(true);
    for (const to of PROPOSAL_STATUSES) expect(await store.move(p.id, 'deployed', to)).toBe(false);
    const done = await store.byId(p.id);
    expect(done).toMatchObject({ status: 'deployed', kind: 'ai_patch', prNumber: 7, mergedBy: 'octocat', credits: 0.9, etag: 'W/"abc"', agentStarted: true });
    expect(done?.checks).toEqual([{ name: 'scope', ok: true }, { name: 'tests', ok: true }]);
    const view = await store.view(p.id);
    expect(validateProposalView(view).ok).toBe(true);
    expect(view).toMatchObject({ service: 'payments', status: 'deployed', deployedAt: at(3).toISOString() });
  });

  it('follows the graph for any request sequence (the database and the memory store agree)', async () => {
    const fc = (await import('fast-check')).default;
    const h = await hunt();
    await fc.assert(
      fc.asyncProperty(fc.array(fc.tuple(fc.constantFrom(...PROPOSAL_STATUSES), fc.constantFrom(...PROPOSAL_STATUSES)), { minLength: 1, maxLength: 8 }), async (requests) => {
        await prisma.proposal.deleteMany({ where: { huntId: h.id } });
        const p = await create(h.id);
        let current: ProposalStatus = 'drafting';
        const patchFor = (to: ProposalStatus): ProposalPatch =>
          to === 'open' ? OPEN : to === 'merged' ? MERGED : to === 'failed' || to === 'checks_failed' ? { failReason: 'internal' } : {};
        for (const [from, to] of requests) {
          const applied = await store.move(p.id, from, to, patchFor(to));
          // A database that would refuse the data of a status (a constraint) is a failed write, not a move.
          expect(applied).toBe(from === current && canMove(from, to));
          if (applied) current = to;
          expect((await store.byId(p.id))?.status).toBe(current);
        }
      }),
      { numRuns: 25 },
    );
  });

  it('refuses at the database what a status cannot have', async () => {
    const h = await hunt();
    const p = await create(h.id);
    const raw = (data: Record<string, unknown>) => prisma.proposal.update({ where: { id: p.id }, data: data as never });
    await expect(raw({ status: 'open' })).rejects.toThrow();
    await expect(raw({ status: 'open', ...OPEN, prUrl: 'https://evil.example/o/r/pull/7' })).rejects.toThrow();
    await expect(raw({ status: 'open', ...OPEN, prUrl: 'http://github.com/o/r/pull/7' })).rejects.toThrow();
    await expect(raw({ status: 'open', ...OPEN, headSha: null })).rejects.toThrow();
    await expect(raw({ status: 'failed' })).rejects.toThrow();
    await expect(raw({ failReason: 'internal' })).rejects.toThrow();
    await expect(raw({ status: 'merged', ...OPEN })).rejects.toThrow();
    await expect(raw({ credits: -1 })).rejects.toThrow();
    await expect(raw({ attempt: 0 })).rejects.toThrow();
    await expect(raw({ status: 'open', ...OPEN })).resolves.toBeDefined();
    await expect(raw({ status: 'merged', ...MERGED })).resolves.toBeDefined();
    // The row is unchanged by every refusal.
    expect(await store.byId(p.id)).toMatchObject({ status: 'merged', prNumber: 7 });
  });

  it('stores a merge GitHub names no one for (mergedBy null), and still needs the merge commit', async () => {
    const h = await hunt();
    const p = await create(h.id);
    expect(await store.move(p.id, 'drafting', 'open', OPEN)).toBe(true);
    // A merged row without the merge commit is still refused.
    await expect(prisma.proposal.update({ where: { id: p.id }, data: { status: 'merged', mergedBy: null } as never })).rejects.toThrow();
    expect(await store.move(p.id, 'open', 'merged', { mergeSha: 'b'.repeat(40), mergedBy: null, mergedAt: at(2) })).toBe(true);
    expect(await store.move(p.id, 'merged', 'deployed', { deployedAt: at(3), finishedAt: at(3) })).toBe(true);
    const done = await store.byId(p.id);
    expect(done).toMatchObject({ status: 'deployed', mergedBy: null, mergeSha: 'b'.repeat(40) });
    expect(validateProposalSummary(toProposalSummary(done as NonNullable<typeof done>)).ok).toBe(true);
  });

  it('allows one active Proposal per Hunt at the database, and a new attempt once it is final', async () => {
    const h = await hunt();
    const first = await create(h.id);
    await expect(prisma.proposal.create({ data: { huntId: h.id, attempt: 2 } })).rejects.toThrow();
    await expect(prisma.proposal.create({ data: { huntId: h.id, attempt: 1, status: 'failed', failReason: 'internal' } })).rejects.toThrow();
    await store.move(first.id, 'drafting', 'checks_failed', { failReason: 'revert_conflict', aiFailReason: 'size', finishedAt: at(1) });
    await expect(prisma.proposal.create({ data: { huntId: h.id, attempt: 2 } })).resolves.toBeDefined();
    expect(await store.create(h.id, at(2))).toBeNull();
  });

  it('answers a race for the same Hunt with exactly one Proposal', async () => {
    const h = await hunt();
    const results = await Promise.all([store.create(h.id, at(0)), store.create(h.id, at(0)), store.create(h.id, at(0))]);
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    expect(await prisma.proposal.count({ where: { huntId: h.id } })).toBe(1);
  });

  it('counts the fixer starts and the credits of the UTC day, in the Hunt budget too', async () => {
    const h = await hunt();
    const a = await create(h.id);
    await store.patch(a.id, 'drafting', { agentStarted: true, credits: 1.2, creditsEstimated: true });
    await store.move(a.id, 'drafting', 'failed', { failReason: 'internal' });
    const b = await create(h.id);
    await store.patch(b.id, 'drafting', { agentStarted: false, credits: 0 });
    const now = new Date();
    expect(await store.fixerStartsToday(now)).toBe(2 - 1);
    expect(await store.fixerStartsToday(new Date(now.getTime() + 3 * 86_400_000))).toBe(0);
    // The Hunt budget adds the fixer's Credits; Hunts that did not start add none.
    const run = await hunt();
    await hunts.markRunning(run.id, now);
    await hunts.finish(run.id, { status: 'failed', reason: 'timeout', invalidCheck: null, credits: 0.5, toolCalls: 1, durationMs: 1, finishedAt: now, diagnosis: null });
    expect(await hunts.creditsToday(now)).toBeCloseTo(1.7, 9);
    expect(await hunts.creditsToday(new Date(now.getTime() + 3 * 86_400_000))).toBe(0);
  });

  it('sweeps drafting rows to failed with api_restart and leaves the others', async () => {
    const h1 = await hunt();
    const h2 = await hunt();
    const h3 = await hunt();
    const drafting = await create(h1.id);
    const open = await create(h2.id);
    await store.move(open.id, 'drafting', 'open', OPEN);
    const done = await create(h3.id);
    await store.move(done.id, 'drafting', 'failed', { failReason: 'internal' });
    expect(await store.sweepDrafting(at(9))).toBe(1);
    expect(await store.byId(drafting.id)).toMatchObject({ status: 'failed', failReason: 'api_restart', finishedAt: at(9) });
    expect((await store.byId(open.id))?.status).toBe('open');
    expect((await store.listByStatus(['open'])).map((r) => r.id)).toEqual([open.id]);
  });

  it('shows the latest Proposal of the latest Hunt of each Service, valid for the shared validator', async () => {
    const h1 = await hunt();
    const p1 = await create(h1.id);
    await store.move(p1.id, 'drafting', 'open', OPEN);
    expect((await store.latestPerService()).get('payments')?.id).toBe(p1.id);
    // A newer Hunt without a Proposal hides the older one.
    await hunt();
    expect((await store.latestPerService()).has('payments')).toBe(false);
    const orders = (await prisma.service.findFirst({ where: { name: 'orders' } }))?.id as string;
    const inc = await prisma.incident.create({ data: { serviceId: orders, peakLevel: 2, openedAt: at(0) } });
    const h3 = await hunt(orders, inc.id);
    const p3 = await create(h3.id);
    const map = await store.latestPerService();
    expect([...map.keys()]).toEqual(['orders']);
    expect(validateProposalSummary(map.get('orders')).ok).toBe(true);
    expect(map.get('orders')?.id).toBe(p3.id);
  });

  it('removes Proposals with their Hunt', async () => {
    const h = await hunt();
    const p = await create(h.id);
    await prisma.hunt.delete({ where: { id: h.id } });
    expect(await store.byId(p.id)).toBeNull();
  });
});

// The migration: old rows keep their meaning, and old rows that cannot satisfy the new rules are ended.
describeDb('migration fix_proposal_flow (scratch schema of the Test database)', () => {
  const SCHEMA = 'mig_fix_proposal_flow';
  let client: pg.Client;

  const files = (): string[] => readdirSync(migrationsDir).filter((n) => /^\d{14}_/.test(n)).sort();
  const sql = (name: string): string => readFileSync(join(migrationsDir, name, 'migration.sql'), 'utf8');
  const BEFORE = '20261113200000_hunt_review_fixes';

  beforeAll(async () => {
    client = new pg.Client({ connectionString: testDatabaseUrl });
    await client.connect();
    await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await client.query(`CREATE SCHEMA ${SCHEMA}`);
    await client.query(`SET search_path TO ${SCHEMA}`);
    for (const name of files().filter((n) => n <= BEFORE)) await client.query(sql(name));
  });
  afterAll(async () => {
    await client.query('SET search_path TO public');
    await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await client.end();
  });

  it('maps draft, approved and the others, ends the rows that cannot be open, and drops approvedBy', async () => {
    // The old table had no link target to check: the foreign key is dropped so the rows need no Hunt.
    await client.query('ALTER TABLE "Proposal" DROP CONSTRAINT "Proposal_huntId_fkey"');
    const rows: Array<[string, string, string | null]> = [
      ['cmoldproposaldraft00000001', 'draft', null],
      ['cmoldproposalopen000000002', 'open', 'https://github.com/o/r/pull/1'],
      ['cmoldproposalapproved00003', 'approved', 'https://example.com/pull/2'],
      ['cmoldproposalmerged0000004', 'merged', 'https://github.com/o/r/pull/3'],
      ['cmoldproposalrejected00005', 'rejected', 'http://elsewhere.example/x'],
    ];
    for (const [id, status, url] of rows) {
      await client.query(
        'INSERT INTO "Proposal" ("id", "huntId", "prUrl", "status", "approvedBy", "updatedAt") VALUES ($1, $2, $3, $4::"ProposalStatus", $5, CURRENT_TIMESTAMP)',
        [id, `cmoldhunt${id.slice(-8)}aaaaaaaa`, url, status, status === 'approved' ? 'someone' : null],
      );
    }
    for (const name of files().filter((n) => n > BEFORE)) await client.query(sql(name));
    const { rows: out } = await client.query<{ id: string; status: string; failReason: string | null; prUrl: string | null; attempt: number; checks: unknown; credits: number }>(
      'SELECT "id", "status"::text AS "status", "failReason", "prUrl", "attempt", "checks", "credits" FROM "Proposal" ORDER BY "id"',
    );
    const by = new Map(out.map((r) => [r.id, r]));
    // draft -> drafting and approved -> open cannot stay as they are (no branch, no commit): ended, as a restart would.
    expect(by.get('cmoldproposaldraft00000001')).toMatchObject({ status: 'failed', failReason: 'api_restart', attempt: 1, checks: [], credits: 0 });
    expect(by.get('cmoldproposalopen000000002')).toMatchObject({ status: 'failed', failReason: 'api_restart', prUrl: 'https://github.com/o/r/pull/1' });
    expect(by.get('cmoldproposalapproved00003')).toMatchObject({ status: 'failed', failReason: 'api_restart', prUrl: null });
    expect(by.get('cmoldproposalmerged0000004')).toMatchObject({ status: 'failed', failReason: 'api_restart' });
    // `rejected` is final and stays; a link that is not GitHub is dropped.
    expect(by.get('cmoldproposalrejected00005')).toMatchObject({ status: 'rejected', failReason: null, prUrl: null });
    const cols = await client.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_schema = '${SCHEMA}' AND table_name = 'Proposal'`);
    expect(cols.rows.map((c) => c.column_name)).not.toContain('approvedBy');
    const types = await client.query<{ enumlabel: string }>(
      `SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid JOIN pg_namespace n ON n.oid = t.typnamespace WHERE t.typname = 'ProposalStatus' AND n.nspname = '${SCHEMA}' ORDER BY e.enumsortorder`,
    );
    expect(types.rows.map((r) => r.enumlabel)).toEqual(['drafting', 'checks_failed', 'open', 'merged', 'deployed', 'rejected', 'failed']);
  });
});
