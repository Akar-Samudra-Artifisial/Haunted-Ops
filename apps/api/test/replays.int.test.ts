import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasHostName, hasIpv6, initialHauntState, replayHash, replayReviewHash, stepHaunt, validateReplayFile, type ReplayFile } from '@haunted-ops/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildReplay, readIncidentRows, type BuildDeps } from '../../../tools/replay-build/build-replay.mjs';
import { sanitizePrText } from '../src/fix/pr-text.js';
import type { PrismaClient } from '../src/prisma/client.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { seedServices } from '../src/prisma/seed.js';
import { ReplaySeedError, seedReplays } from '../src/replays/replay-seed.js';
import { describeDb, truncateAll } from './db.js';
import { startServer, parsedLogs, type TestServer } from './support/http.js';
import { PLANTED, SYNTHETIC_SHA, insertSyntheticIncident } from './support/replay-rows.js';
const FIXTURE = fileURLToPath(new URL('./fixtures/replays/synthetic-error-spike.json', import.meta.url));
const REVIEW = { reviewedOn: '2026-11-15', by: 'TEST', note: 'Synthetic file for tests: nothing in it was recorded.' };
const deps = { validateReplayFile, initialHauntState, stepHaunt, sanitizePrText, hasHostName, hasIpv6 } as unknown as BuildDeps;
/** The file with its review bound to its content, as `review-replay.mjs --approve` writes it. */
const reviewed = (file: ReplayFile): ReplayFile => ({ ...file, review: { ...REVIEW, sha256: replayReviewHash(file) } });
const readFixture = (): ReplayFile => JSON.parse(readFileSync(FIXTURE, 'utf8')) as ReplayFile;
describeDb('replays (Test database)', () => {
  let server: TestServer;
  let prisma: PrismaClient;
  let built: ReplayFile;
  let ids: { incidentId: string; huntId: string; proposalId: string };
  let dir: string;
  beforeAll(async () => {
    server = await startServer();
    prisma = server.app.get(PrismaService).client;
    await truncateAll(prisma);
    await seedServices(prisma);
    ids = await insertSyntheticIncident(prisma);
    const rows = await readIncidentRows(prisma, ids.incidentId);
    built = buildReplay(rows, { id: 'synthetic-error-spike', title: 'Synthetic: payments error spike (test file, not recorded)', scenario: 'error-spike' }, deps);
    // `UPDATE_REPLAY_FIXTURE=1 pnpm --filter @haunted-ops/api test` rewrites the committed file from the rows above.
    if (process.env.UPDATE_REPLAY_FIXTURE === '1') {
      mkdirSync(join(FIXTURE, '..'), { recursive: true });
      writeFileSync(FIXTURE, `${JSON.stringify(reviewed(built), null, 2)}\n`);
    }
  });
  afterAll(async () => {
    await truncateAll(prisma);
    await server.close();
  });
  beforeEach(async () => {
    await prisma.replay.deleteMany();
    dir = mkdtempSync(join(tmpdir(), 'replays-'));
    cpSync(FIXTURE, join(dir, 'synthetic-error-spike.json'));
    return () => rmSync(dir, { recursive: true, force: true });
  });
  describe('the builder, on rows of the Test database', () => {
    it('makes the committed synthetic file (review aside) and a valid one', () => {
      expect(built.review).toBeNull();
      expect(validateReplayFile(built).ok).toBe(true);
      expect({ ...readFixture(), review: null }).toEqual(built);
      expect(readFixture().review).toEqual({ ...REVIEW, sha256: replayReviewHash(built) });
      expect(validateReplayFile(readFixture()).ok).toBe(true);
    });
    it('tells the story: calm first, a dark room, a hunt, a pull request, a deploy', () => {
      const first = built.frames[0];
      expect(first?.t).toBe(0);
      expect(first?.services?.every((s) => s.hauntLevel === 0)).toBe(true);
      expect(built.frames.some((f) => f.services?.some((s) => s.name === 'payments' && s.hauntLevel >= 2))).toBe(true);
      const statuses = [...new Set(built.frames.flatMap((f) => (f.hunt === undefined || f.hunt === null ? [] : [f.hunt.status])))];
      expect(statuses).toEqual(['queued', 'running', 'succeeded']);
      const proposals = [...new Set(built.frames.flatMap((f) => (f.proposal === undefined || f.proposal === null ? [] : [f.proposal.status])))];
      expect(proposals).toEqual(['drafting', 'open', 'merged', 'deployed']);
      const last = [...built.frames].reverse().find((f) => f.services !== undefined);
      expect(last?.services?.every((s) => s.hauntLevel === 0)).toBe(true);
      expect(built.frames.length).toBeLessThanOrEqual(400);
      expect(built.frames.map((f) => f.t)).toEqual([...built.frames.map((f) => f.t)].sort((a, b) => a - b));
    });
    it('keeps no real id, no login, no internal field and no planted text', async () => {
      const text = JSON.stringify(built);
      for (const real of [ids.incidentId, ids.huntId, ids.proposalId]) expect(text).not.toContain(real);
      for (const planted of Object.values(PLANTED)) expect(text).not.toContain(planted);
      expect(text).not.toContain('aiFailDetail":"');
      expect(text).toContain('[email]');
      expect(text).toContain(SYNTHETIC_SHA);
      const proposal = built.frames.flatMap((f) => (f.proposal ? [f.proposal] : [])).pop();
      expect(proposal?.mergedBy).toBe('reviewer');
      expect(proposal?.prUrl).toBe('https://github.com/Akar-Samudra-Artifisial/Haunted-Lab/pull/7');
      // The times are those of the recording date at midnight, not the hour of the incident.
      expect(text).not.toContain('2026-11-15T09:');
      expect(built.recordedOn).toBe('2026-11-15');
    });
    it('is read only: it changed no row', async () => {
      const before = await Promise.all([prisma.signal.count(), prisma.hunt.count(), prisma.proposal.count(), prisma.incident.count(), prisma.replay.count()]);
      await readIncidentRows(prisma, ids.incidentId);
      expect(await Promise.all([prisma.signal.count(), prisma.hunt.count(), prisma.proposal.count(), prisma.incident.count(), prisma.replay.count()])).toEqual(before);
    });
    it('says incident_not_found for an unknown incident', async () => {
      await expect(readIncidentRows(prisma, 'nope')).rejects.toMatchObject({ code: 'incident_not_found' });
    });
  });
  describe('seeding', () => {
    it('seeds the reviewed file, keeps an unchanged row and updates a changed one', async () => {
      const first = await seedReplays(prisma, dir);
      expect(first).toEqual({ seeded: ['synthetic-error-spike'], kept: [], skipped: [], removed: [] });
      const row = await prisma.replay.findUniqueOrThrow({ where: { id: 'synthetic-error-spike' } });
      expect(row.recordedOn.toISOString().slice(0, 10)).toBe('2026-11-15');
      expect(row.sha256).toBe(replayHash(readFixture()));
      const again = await seedReplays(prisma, dir);
      expect(again).toEqual({ seeded: [], kept: ['synthetic-error-spike'], skipped: [], removed: [] });
      expect((await prisma.replay.findUniqueOrThrow({ where: { id: 'synthetic-error-spike' } })).updatedAt).toEqual(row.updatedAt);
      writeFileSync(join(dir, 'synthetic-error-spike.json'), `${JSON.stringify(reviewed({ ...readFixture(), title: 'Synthetic: a new title' }), null, 2)}\n`);
      expect((await seedReplays(prisma, dir)).seeded).toEqual(['synthetic-error-spike']);
      expect((await prisma.replay.findUniqueOrThrow({ where: { id: 'synthetic-error-spike' } })).title).toBe('Synthetic: a new title');
    });
    it('rewrites a row whose body was changed by hand under the same sha256', async () => {
      await seedReplays(prisma, dir);
      await prisma.replay.update({ where: { id: 'synthetic-error-spike' }, data: { body: { ...readFixture(), title: 'Synthetic: edited by hand' } as never } });
      expect(await seedReplays(prisma, dir)).toEqual({ seeded: ['synthetic-error-spike'], kept: [], skipped: [], removed: [] });
      expect((await prisma.replay.findUniqueOrThrow({ where: { id: 'synthetic-error-spike' } })).body).toEqual(readFixture());
    });
    it('stops on a reviewed file whose review hash no longer matches its content, naming the path and writing nothing', async () => {
      writeFileSync(join(dir, 'synthetic-error-spike.json'), `${JSON.stringify({ ...readFixture(), title: 'Synthetic: edited after the review' })}\n`);
      await expect(seedReplays(prisma, dir)).rejects.toMatchObject({ file: 'synthetic-error-spike.json', paths: ['$.review.sha256'] });
      expect(await prisma.replay.count()).toBe(0);
    });
    it('seeds 0 replays from a folder that holds only README.md (how a release without replays ships)', async () => {
      rmSync(join(dir, 'synthetic-error-spike.json'));
      writeFileSync(join(dir, 'README.md'), '# Replays\n');
      expect(await seedReplays(prisma, dir)).toEqual({ seeded: [], kept: [], skipped: [], removed: [] });
      expect(await prisma.replay.count()).toBe(0);
    });
    it('skips a file with review null, naming it, and leaves no row for it', async () => {
      writeFileSync(join(dir, 'synthetic-unreviewed.json'), `${JSON.stringify({ ...readFixture(), id: 'synthetic-unreviewed', review: null })}\n`);
      const r = await seedReplays(prisma, dir);
      expect(r.skipped).toEqual(['synthetic-unreviewed.json']);
      expect(await prisma.replay.findUnique({ where: { id: 'synthetic-unreviewed' } })).toBeNull();
    });
    it('deletes the row of a file that is gone, or that lost its review', async () => {
      await seedReplays(prisma, dir);
      writeFileSync(join(dir, 'synthetic-error-spike.json'), `${JSON.stringify({ ...readFixture(), review: null })}\n`);
      expect((await seedReplays(prisma, dir)).removed).toEqual(['synthetic-error-spike']);
      expect(await prisma.replay.count()).toBe(0);
      cpSync(FIXTURE, join(dir, 'synthetic-error-spike.json'));
      await seedReplays(prisma, dir);
      rmSync(join(dir, 'synthetic-error-spike.json'));
      expect((await seedReplays(prisma, dir)).removed).toEqual(['synthetic-error-spike']);
    });
    it('stops on an invalid file, names the file and the paths and writes nothing', async () => {
      const bad = readFixture();
      (bad as unknown as { frames: unknown[] }).frames = [];
      writeFileSync(join(dir, 'broken.json'), JSON.stringify({ ...bad, id: 'broken' }));
      const err = await seedReplays(prisma, dir).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ReplaySeedError);
      expect((err as ReplaySeedError).file).toBe('broken.json');
      expect((err as Error).message).toContain('$.frames');
      expect(await prisma.replay.count()).toBe(0);
      writeFileSync(join(dir, 'broken.json'), '{ not json');
      await expect(seedReplays(prisma, dir)).rejects.toMatchObject({ file: 'broken.json', paths: ['json'] });
      writeFileSync(join(dir, 'broken.json'), JSON.stringify(readFixture()));
      await expect(seedReplays(prisma, dir)).rejects.toMatchObject({ file: 'broken.json', paths: ['$.id'] });
      rmSync(join(dir, 'broken.json'));
      // Only regular files count: a folder and a link named `.json` stop the seed with the file name.
      mkdirSync(join(dir, 'folder.json'));
      await expect(seedReplays(prisma, dir)).rejects.toMatchObject({ file: 'folder.json', paths: ['not_regular_file'] });
      rmSync(join(dir, 'folder.json'), { recursive: true });
      symlinkSync(join(dir, 'synthetic-error-spike.json'), join(dir, 'link.json'));
      await expect(seedReplays(prisma, dir)).rejects.toMatchObject({ file: 'link.json', paths: ['not_regular_file'] });
      rmSync(join(dir, 'link.json'));
      expect(await prisma.replay.count()).toBe(0);
      await expect(seedReplays(prisma, join(dir, 'missing'))).rejects.toBeInstanceOf(ReplaySeedError);
      expect(readdirSync(dir)).toEqual(['synthetic-error-spike.json']);
    });
  });
  describe('GET /api/replays', () => {
    beforeEach(async () => {
      await seedReplays(prisma, dir);
    });
    it('lists id, title, scenario, recordedOn and durationMs, newest first, cached for 5 minutes', async () => {
      const older = reviewed({ ...readFixture(), id: 'synthetic-older', recordedOn: '2026-10-01' });
      writeFileSync(join(dir, 'synthetic-older.json'), JSON.stringify(older));
      await seedReplays(prisma, dir);
      const res = await fetch(`${server.url}/api/replays`);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('public, max-age=300');
      const body = (await res.json()) as unknown[];
      expect(body).toEqual([
        { id: 'synthetic-error-spike', title: readFixture().title, scenario: 'error-spike', recordedOn: '2026-11-15', durationMs: readFixture().durationMs },
        { id: 'synthetic-older', title: readFixture().title, scenario: 'error-spike', recordedOn: '2026-10-01', durationMs: readFixture().durationMs },
      ]);
    });
    it('leaves out a row that no longer validates or whose sha256 is not the hash of its body, and logs the id only', async () => {
      const older = reviewed({ ...readFixture(), id: 'synthetic-older', recordedOn: '2026-10-01' });
      writeFileSync(join(dir, 'synthetic-older.json'), JSON.stringify(older));
      await seedReplays(prisma, dir);
      const ids = async (): Promise<string[]> => ((await (await fetch(`${server.url}/api/replays`)).json()) as Array<{ id: string }>).map((r) => r.id);
      expect(await ids()).toEqual(['synthetic-error-spike', 'synthetic-older']);
      const body = readFixture();
      const tampered: Array<[string, Record<string, unknown>]> = [
        ['the body fails the validator', { body: { ...body, title: `mail ${PLANTED.email}` } }],
        ['the body was edited after its review', { body: { ...body, title: 'Synthetic: edited by hand' } }],
        ['the review was dropped', { body: { ...body, review: null } }],
        ['the sha256 of the row is not the hash of its body', { sha256: 'a'.repeat(64) }],
        ['the id of the body is not the id of the row', { body: { ...body, id: 'another-id' } }],
        ['the duration of the body is not the column', { durationMs: body.durationMs + 1 }],
      ];
      for (const [label, data] of tampered) {
        await seedReplays(prisma, dir);
        await prisma.replay.update({ where: { id: 'synthetic-error-spike' }, data: data as never });
        server.logs.length = 0;
        const res = await fetch(`${server.url}/api/replays`);
        expect(res.status, label).toBe(200);
        expect(((await res.json()) as Array<{ id: string }>).map((r) => r.id), label).toEqual(['synthetic-older']);
        const logged = parsedLogs(server.logs).filter((l) => l.msg === 'replay row is not valid');
        expect(logged.length, label).toBe(1);
        expect(logged[0], label).toMatchObject({ replayId: 'synthetic-error-spike' });
        expect(Object.keys(logged[0] ?? {}).sort()).toEqual(['level', 'msg', 'replayId', 'ts']);
        expect(JSON.stringify(logged)).not.toContain(PLANTED.email);
        // The row is repaired by the next seed, because its file is the source.
        await prisma.replay.update({ where: { id: 'synthetic-error-spike' }, data: { body: body as never, sha256: 'b'.repeat(64), durationMs: body.durationMs } });
        await seedReplays(prisma, dir);
        expect(await ids(), label).toEqual(['synthetic-error-spike', 'synthetic-older']);
      }
    });
    it('answers an empty list when there is no replay', async () => {
      await prisma.replay.deleteMany();
      const res = await fetch(`${server.url}/api/replays`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
    });
  });
  describe('GET /api/replays/:id', () => {
    beforeEach(async () => {
      await seedReplays(prisma, dir);
    });
    it('answers the file, valid, cached for 5 minutes', async () => {
      const res = await fetch(`${server.url}/api/replays/synthetic-error-spike`);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('public, max-age=300');
      const body: unknown = await res.json();
      expect(body).toEqual(readFixture());
      expect(validateReplayFile(body).ok).toBe(true);
      // A row keeps the order of keys that jsonb chose; the hash does not depend on it.
      const row = await prisma.replay.findUniqueOrThrow({ where: { id: 'synthetic-error-spike' } });
      expect(row.sha256).toBe(replayHash(row.body));
    });
    it('answers 404 for an unknown id, an id that breaks the pattern and an unreviewed file', async () => {
      writeFileSync(join(dir, 'synthetic-unreviewed.json'), JSON.stringify({ ...readFixture(), id: 'synthetic-unreviewed', review: null }));
      await seedReplays(prisma, dir);
      for (const id of ['nothing-here', 'synthetic-unreviewed', 'A', 'ab', '-abc', 'a_b_c', 'x'.repeat(49), '..%2F..%2Fetc', 'a%20b']) {
        const res = await fetch(`${server.url}/api/replays/${id}`);
        expect(res.status, id).toBe(404);
        expect(res.headers.get('cache-control') ?? '').not.toContain('public');
      }
    });
    it('answers 500 with no content for a tampered row, and logs the id only', async () => {
      const body = readFixture() as unknown as { title: string };
      for (const tampered of [{ ...body, title: `mail ${PLANTED.email}` }, { ...body, extra: 1 }, { ...body, review: null }, { ...body, id: 'another-id' }]) {
        await prisma.replay.update({ where: { id: 'synthetic-error-spike' }, data: { body: tampered as never } });
        server.logs.length = 0;
        const res = await fetch(`${server.url}/api/replays/synthetic-error-spike`);
        expect(res.status).toBe(500);
        expect(await res.text()).toBe('');
        expect(res.headers.get('cache-control') ?? '').not.toContain('public');
        const logged = parsedLogs(server.logs).find((l) => l.msg === 'replay row is not valid');
        expect(logged).toMatchObject({ replayId: 'synthetic-error-spike' });
        expect(JSON.stringify(logged)).not.toContain(PLANTED.email);
        expect(Object.keys(logged ?? {}).sort()).toEqual(['level', 'msg', 'replayId', 'ts']);
      }
    });
    it('answers 500 for a row whose sha256 is not the hash of its body, or whose body was edited by hand', async () => {
      const body = readFixture();
      for (const data of [{ sha256: 'c'.repeat(64) }, { body: { ...body, title: 'Synthetic: edited by hand' } }, { body: reviewed({ ...body, title: 'Synthetic: edited and re-reviewed' }) }]) {
        await seedReplays(prisma, dir);
        await prisma.replay.update({ where: { id: 'synthetic-error-spike' }, data: data as never });
        const res = await fetch(`${server.url}/api/replays/synthetic-error-spike`);
        expect(res.status).toBe(500);
        expect(await res.text()).toBe('');
        await prisma.replay.update({ where: { id: 'synthetic-error-spike' }, data: { body: body as never, sha256: 'd'.repeat(64) } });
      }
    });
    it('has no route that writes: POST, PUT, PATCH and DELETE are not found', async () => {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        const res = await fetch(`${server.url}/api/replays/synthetic-error-spike`, { method, headers: { 'content-type': 'application/json' }, body: method === 'DELETE' ? undefined : '{}' });
        expect(res.status, method).toBe(404);
      }
      const post = await fetch(`${server.url}/api/replays`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      expect(post.status).toBe(404);
      expect(await prisma.replay.count()).toBe(1);
    });
  });
});
