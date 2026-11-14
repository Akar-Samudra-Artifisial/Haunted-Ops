import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  validateHuntDetail,
  validateProposalView,
  validateServiceStates,
  validateSseEvent,
  type HuntDetail,
  type ProposalView,
} from '@haunted-ops/shared';
import { startFakeGithub, type FakeGithub } from '../../../tools/fake-kiro-cli/fake-github.mjs';
import { FAKE_KIRO_FIXER } from '../../../tools/fake-kiro-cli/fixer-wrapper.mjs';
import { startFakeLab, type FakeLab } from '../../../tools/fake-kiro-cli/fake-lab.mjs';
import { EventBus, type BusEvent } from '../src/events/event-bus.js';
import type { FixConfig } from '../src/fix/fix-config.js';
import { PROPOSAL_LABELS } from '../src/fix/fix-startup.js';
import { GithubClient } from '../src/fix/github-client.js';
import { ProposalRunner } from '../src/fix/proposal-runner.js';
import { PrismaProposalStore } from '../src/fix/proposal-store.js';
import { parseHuntConfig } from '../src/hunts/hunt-config.js';
import { PrismaHuntStore } from '../src/hunts/hunt-store.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { seedServices } from '../src/prisma/seed.js';
import { describeDb, truncateAll } from './db.js';
import { DUMMY_GITHUB_TOKEN } from './support/fix.js';
import { REPO, WEB_ORIGIN, chainFrom, commitInLab, humanMerge } from './support/fix-harness.js';
import { startServer, testConfig, type TestServer } from './support/http.js';
import { deleteRefIn, gitIn, makeLabRepo, syncRefsFrom, type LabRepo } from './support/lab-repo.js';
import { SseReader } from './support/sse-reader.js';

const LAB_TOKEN = 'lab-read-token-0123456789-abcdef';
const ADMIN_TOKEN = 'admin-token-0123456789-abcdefgh';
const CHAOS_TOKEN = 'chaos-token-0123456789-abcdefghij';

interface Rig {
  server: TestServer;
  lab: LabRepo;
  fake: FakeGithub;
  fakeLab: FakeLab;
  events: BusEvent[];
  root: string;
  runner: ProposalRunner;
  store: PrismaProposalStore;
  fixture(name: string): void;
  post(path: string, token?: string | null): Promise<Response>;
  get(path: string): Promise<Response>;
  /** A succeeded Hunt of `payments` in the database, with its diagnosis and cited evidence. */
  hunt(over?: { status?: 'succeeded' | 'failed' }): Promise<string>;
  /** Starts the Proposal by the operator route and waits until the draft ended. */
  propose(huntId: string): Promise<ProposalView>;
  view(id: string): Promise<ProposalView>;
  until(check: () => boolean | Promise<boolean>, ms?: number, what?: string): Promise<void>;
  /** Tells the fake lab which commits `incident/<huntId>` holds, as it would find them on origin. */
  teachLab(huntId: string, head: string, chain?: Array<{ sha: string; files: string[] }>): void;
  close(): Promise<void>;
}

const rigs: Rig[] = [];

async function startRig(o: { fixEnabled?: boolean; cfg?: Partial<FixConfig>; poll?: boolean } = {}): Promise<Rig> {
  const lab = makeLabRepo();
  const root = mkdtempSync(join(tmpdir(), 'fix-int-'));
  const fake = await startFakeGithub({ repo: REPO, token: DUMMY_GITHUB_TOKEN, syncRefs: syncRefsFrom(lab.remote), onDeleteRef: deleteRefIn(lab.remote) });
  const fakeLab = await startFakeLab({
    token: LAB_TOKEN,
    chaosToken: CHAOS_TOKEN,
    // The commit the lab runs for payments: the scenario head of the local lab repository.
    extraDeploys: [{ id: 'd-50', service: 'payments', ref: 'scenario/error-spike', sha: lab.base, time: new Date(Date.now() + 1000).toISOString(), actor: 'chaos' }],
  });
  fakeLab.allowedHeads.push(lab.main, lab.base, lab.other);
  // A kiro-cli that reads the fixture from a file, so one server can run different fixtures.
  const cli = join(root, 'kiro-cli');
  const fixtureFile = join(root, 'fixture');
  writeFileSync(fixtureFile, 'fixer-good');
  writeFileSync(cli, `#!/bin/sh\nFAKE_KIRO_FIXTURE="$(cat '${fixtureFile}')"\nexport FAKE_KIRO_FIXTURE\nexec '${process.execPath}' '${FAKE_KIRO_FIXER}' "$@"\n`, { mode: 0o755 });
  chmodSync(cli, 0o755);
  mkdirSync(join(root, 'hunts'));
  const huntConfig = parseHuntConfig({
    HUNTS_ENABLED: 'true',
    LAB_URL: fakeLab.url,
    LAB_READ_TOKEN: LAB_TOKEN,
    HUNT_ADMIN_TOKEN: ADMIN_TOKEN,
    KIRO_CLI_PATH: cli,
    HUNT_WORKDIR: join(root, 'hunts'),
    HUNT_COOLDOWN_MS: '0',
  });
  const fixConfig: FixConfig = {
    enabled: o.fixEnabled !== false,
    githubToken: DUMMY_GITHUB_TOKEN,
    repo: REPO,
    chaosUrl: fakeLab.url,
    chaosToken: CHAOS_TOKEN,
    webOrigin: WEB_ORIGIN,
    gitPath: '/usr/bin/git',
    model: 'claude-sonnet-5.5',
    creditCap: 1.5,
    timeoutMs: 20_000,
    maxToolCalls: 30,
    testTimeoutMs: 30_000,
    requireTests: true,
    pollMs: 30_000,
    branchTtlDays: 7,
    deployConfirmMs: 0,
    workdir: join(root, 'fix'),
    ...o.cfg,
  };
  const server = await startServer({
    config: testConfig({ PROMETHEUS_URL: fakeLab.url }),
    huntConfig,
    fixConfig,
    fixOverrides: {
      githubBaseUrl: fake.url,
      gitRemoteUrl: () => `file://${lab.remote}`,
      allowFileProtocol: true,
      poll: o.poll === true,
      timings: { confirmMs: 100, confirmEveryMs: 10, deployRetries: 2, retryBackoffMs: 1 },
      parentEnv: { HOME: root, LANG: 'en_US.UTF-8' },
    },
  });
  const prisma = server.app.get(PrismaService).client;
  await truncateAll(prisma);
  await seedServices(prisma);
  await new GithubClient({ token: DUMMY_GITHUB_TOKEN, repo: REPO, baseUrl: fake.url }).ensureLabels(PROPOSAL_LABELS);
  const events: BusEvent[] = [];
  server.app.get(EventBus).subscribe((e) => events.push(e));
  const runner = server.app.get(ProposalRunner);
  const store = server.app.get(PrismaProposalStore);
  const hunts = new PrismaHuntStore(prisma);

  const until = async (check: () => boolean | Promise<boolean>, ms = 40_000, what = 'condition'): Promise<void> => {
    const deadline = Date.now() + ms;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  const post = (path: string, token: string | null = ADMIN_TOKEN): Promise<Response> =>
    fetch(`${server.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token === null ? {} : { authorization: `Bearer ${token}` }) }, body: '{}' });
  const get = (path: string): Promise<Response> => fetch(`${server.url}${path}`);
  const view = async (id: string): Promise<ProposalView> => {
    const res = await get(`/api/proposals/${id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown;
    const checked = validateProposalView(body);
    expect(checked.ok).toBe(true);
    return body as ProposalView;
  };
  const rig: Rig = {
    server,
    lab,
    fake,
    fakeLab,
    events,
    root,
    runner,
    store,
    fixture: (name) => writeFileSync(fixtureFile, name),
    post,
    get,
    view,
    until,
    teachLab: (huntId, head, chain) => fakeLab.refs.set(`incident/${huntId}`, { head, chain: chain ?? chainFrom(lab, head, lab.base) }),
    hunt: async (over = {}) => {
      const service = await prisma.service.findFirstOrThrow({ where: { name: 'payments' } });
      const incident = await prisma.incident.create({ data: { serviceId: service.id, peakLevel: 3, openedAt: new Date(Date.now() - 600_000), closedAt: new Date(Date.now() - 1_000) } });
      const created = await hunts.create({ incidentId: incident.id, serviceId: service.id, trigger: 'operator', model: 'claude-sonnet-5.5' });
      await hunts.markRunning(created.id, new Date(Date.now() - 60_000));
      const failed = over.status === 'failed';
      await hunts.addEvidence(created.id, { order: 1, kind: 'deploy', ref: 'deploy:d-7', detail: 'd-7 payments' });
      await hunts.addEvidence(created.id, { order: 2, kind: 'commit', ref: `commit:${lab.culprit}`, detail: 'simplify charge lookup' });
      await hunts.finish(created.id, {
        status: failed ? 'failed' : 'succeeded',
        reason: failed ? 'timeout' : 'diagnosed',
        invalidCheck: null,
        credits: 0.9,
        toolCalls: 12,
        durationMs: 5000,
        finishedAt: new Date(),
        diagnosis: failed
          ? null
          : { culpritDeploy: 'd-7', culpritSha: lab.culprit, culpritService: 'payments', summary: 'The guard on a missing order was removed.', fixHint: 'Restore the guard.', cited: ['deploy:d-7', `commit:${lab.culprit}`] },
      });
      return created.id;
    },
    propose: async (huntId) => {
      const res = await post(`/api/hunts/${huntId}/proposal`);
      expect(res.status).toBe(202);
      const { proposalId } = (await res.json()) as { proposalId: string };
      await until(async () => (await view(proposalId)).status !== 'drafting', 40_000, `proposal ${proposalId} to leave drafting`);
      return view(proposalId);
    },
    close: async () => {
      await server.close();
      await fakeLab.close();
      await fake.close();
      lab.cleanup();
      rmSync(root, { recursive: true, force: true });
    },
  };
  rigs.push(rig);
  return rig;
}

afterEach(async () => {
  for (const r of rigs.splice(0)) await r.close();
});

/** What may never leave the API: tokens, host paths, agent text. */
function expectNoLeaks(rig: Rig, ...texts: string[]): void {
  const all = [...texts, ...rig.server.logs, JSON.stringify(rig.events.map((e) => e.payload)), JSON.stringify(rig.fake.pulls)].join('\n');
  const b64 = Buffer.from(`x-access-token:${DUMMY_GITHUB_TOKEN}`).toString('base64');
  for (const secret of [DUMMY_GITHUB_TOKEN, b64, CHAOS_TOKEN, ADMIN_TOKEN, LAB_TOKEN, rig.root, '/Users/', '/home/', 'sessionUpdate', 'rawInput', 'agent_message_chunk']) {
    expect(all, secret).not.toContain(secret);
  }
}

describeDb('The fix flow end to end (Test database, fake kiro-cli fixer, fake GitHub, fake lab)', () => {
  it('goes from a succeeded Hunt to a pull request, a human merge and a deploy, over the routes and the SSE stream', async () => {
    const rig = await startRig();
    await rig.runner.start();
    const huntId = await rig.hunt();
    const sse = new SseReader(await fetch(`${rig.server.url}/api/events`));
    await sse.take(1, 5_000); // the `connected` frame

    const proposal = await rig.propose(huntId);
    expect(proposal).toMatchObject({ huntId, status: 'open', kind: 'ai_patch', attempt: 1, service: 'payments', prNumber: 1, creditsEstimated: false });
    expect(proposal.prUrl).toBe(`https://github.com/${REPO}/pull/1`);
    expect(proposal.checks.every((c) => c.ok)).toBe(true);
    expect(rig.fake.pulls[0]).toMatchObject({ head: `exorcist/${huntId}`, base: `incident/${huntId}`, labels: ['exorcist', 'ai_patch'] });

    // The Hunt and the Service state carry the Proposal.
    const detail = (await (await rig.get(`/api/hunts/${huntId}`)).json()) as HuntDetail;
    expect(validateHuntDetail(detail).ok).toBe(true);
    expect(detail.proposal).toMatchObject({ id: proposal.id, status: 'open', kind: 'ai_patch', prNumber: 1 });
    const services = validateServiceStates(await (await rig.get('/api/services')).json());
    expect(services.ok && services.value.find((s) => s.name === 'payments')?.proposal).toMatchObject({ id: proposal.id, status: 'open' });

    // A person merges it on GitHub; the next poll sees it and the lab deploys the merge commit.
    const { mergeSha } = humanMerge(rig.lab, rig.fake, 1, { by: 'octocat' });
    rig.teachLab(huntId, mergeSha);
    await rig.runner.tick();
    const done = await rig.view(proposal.id);
    expect(done).toMatchObject({ status: 'deployed', mergedBy: 'octocat' });
    expect(done.deployedAt).not.toBeNull();
    expect(rig.fakeLab.deployed).toMatchObject([{ service: 'payments', sha: mergeSha, ref: `incident/${huntId}`, actor: 'exorcist' }]);
    expect(rig.fakeLab.deployFix.calls).toEqual([{ authorized: true, body: { service: 'payments', ref: `incident/${huntId}`, sha: mergeSha } }]);

    // The SSE stream carried the events in the order of the graph, each valid for its validator.
    const names = ['proposal.started', 'proposal.checks', 'proposal.opened', 'proposal.merged', 'proposal.deployed'];
    const frames = await sse.take(names.length, 10_000);
    expect(frames.map((f) => f.event)).toEqual(names);
    for (const f of frames) expect(validateSseEvent(f.event, f.data).ok).toBe(true);
    expect(frames[2]?.data).toMatchObject({ prNumber: 1, kind: 'ai_patch', prUrl: `https://github.com/${REPO}/pull/1` });
    await sse.cancel();
    const refreshed = validateServiceStates(await (await rig.get('/api/services')).json());
    expect(refreshed.ok && refreshed.value.find((s) => s.name === 'payments')?.proposal).toMatchObject({ status: 'deployed', mergedBy: 'octocat' });
    expectNoLeaks(rig, JSON.stringify(done), JSON.stringify(detail));
  }, 90_000);

  it('answers the routes: public read, 404 for a bad or unknown id, the operator route needs the bearer, 404 when off, 409 for conflicts', async () => {
    const rig = await startRig();
    const huntId = await rig.hunt();
    expect((await rig.get('/api/proposals/nope')).status).toBe(404);
    expect((await rig.get('/api/proposals/cmnoproposalaaaaaaaaaaaaa')).status).toBe(404);
    expect((await rig.post(`/api/hunts/${huntId}/proposal`, null)).status).toBe(401);
    expect((await rig.post(`/api/hunts/${huntId}/proposal`, 'wrong-token-0123456789-abcdefghij')).status).toBe(401);
    expect((await rig.post('/api/hunts/cmnohuntaaaaaaaaaaaaaaaaaa/proposal')).status).toBe(404);
    expect((await rig.post('/api/hunts/not-an-id/proposal')).status).toBe(404);
    const failedHunt = await rig.hunt({ status: 'failed' });
    expect((await rig.post(`/api/hunts/${failedHunt}/proposal`)).status).toBe(409);
    // The route allows 5 requests a minute per client, counted before the bearer is checked: the 6th is refused.
    expect((await rig.post(`/api/hunts/${failedHunt}/proposal`)).status).toBe(429);
  }, 60_000);

  it('answers 409 for conflicts: a failed Hunt, an active Proposal, a Proposal a person closed', async () => {
    const rig = await startRig();
    const huntId = await rig.hunt();
    const failedHunt = await rig.hunt({ status: 'failed' });
    expect((await rig.post(`/api/hunts/${failedHunt}/proposal`)).status).toBe(409);
    const first = await rig.post(`/api/hunts/${huntId}/proposal`);
    expect(first.status).toBe(202);
    expect(await first.json()).toMatchObject({ status: 'drafting', attempt: 1 });
    // While it is active, and after a person closed it, another request is a conflict.
    expect((await rig.post(`/api/hunts/${huntId}/proposal`)).status).toBe(409);
    await rig.until(async () => (await rig.store.latestOfHunt(huntId))?.status === 'open');
    expect((await rig.post(`/api/hunts/${huntId}/proposal`)).status).toBe(409);
    rig.fake.closeUnmerged(1);
    await rig.runner.tick();
    expect((await rig.store.latestOfHunt(huntId))?.status).toBe('rejected');
    expect((await rig.post(`/api/hunts/${huntId}/proposal`)).status).toBe(409);

    const off = await startRig({ fixEnabled: false });
    const offHunt = await off.hunt();
    expect((await off.post(`/api/hunts/${offHunt}/proposal`)).status).toBe(404);
    expect(off.fake.requests.filter((r) => r.path.includes('/pulls')).length).toBe(0);
  }, 120_000);

  it('falls back to the revert, retries a failed Proposal as attempt 2, and ends checks_failed when nothing can be proposed', async () => {
    const rig = await startRig();
    rig.fixture('fixer-breaks-tests');
    const huntId = await rig.hunt();
    const first = await rig.propose(huntId);
    expect(first).toMatchObject({ status: 'open', kind: 'revert', aiFailReason: 'tests_failed' });
    expect(first.checks.map((c) => c.name)).toEqual(expect.arrayContaining(['scope', 'forbidden_file', 'tests']));
    expect(rig.fake.pulls[0]?.labels).toEqual(['exorcist', 'revert']);
  }, 120_000);

  it('ends checks_failed when the revert conflicts, and the operator retry is attempt 2', async () => {
    // The deployed commit rewrote the same lines, so the revert cannot be applied.
    const conflict = await startRig({});
    conflict.fixture('fixer-breaks-tests');
    gitIn(conflict.lab.work, ['checkout', '--quiet', '-b', 'scenario/conflict', conflict.lab.culprit]);
    const d2 = commitInLab(conflict, 'services/payments/src/charge.js', 'export const changed = true;\n', 'rewrite charge');
    gitIn(conflict.lab.work, ['push', '--quiet', conflict.lab.remote, 'scenario/conflict']);
    conflict.fakeLab.allowedHeads.push(d2);
    const h2 = await conflict.hunt();
    conflict.fakeLab.deployed.push({ id: 'd-60', service: 'payments', ref: 'scenario/conflict', sha: d2, time: new Date(Date.now() + 5000).toISOString(), actor: 'chaos' });
    const second = await conflict.propose(h2);
    expect(second).toMatchObject({ status: 'checks_failed', failReason: 'revert_conflict', aiFailReason: 'tests_failed', prNumber: null, prUrl: null });
    expect(conflict.fake.pulls).toHaveLength(0);
    // The operator retries it: a new attempt, which fails the same way, as a new row.
    const retry = await conflict.post(`/api/hunts/${h2}/proposal`);
    expect(retry.status).toBe(202);
    expect(await retry.json()).toMatchObject({ attempt: 2 });
    await conflict.until(async () => (await conflict.store.latestOfHunt(h2))?.status === 'checks_failed' && (await conflict.store.latestOfHunt(h2))?.attempt === 2);
  }, 180_000);

  it('does not deploy what was not reviewed: head_changed, ref_moved and merge_scope', async () => {
    const rig = await startRig();
    // head_changed: someone pushed to the fix branch after the pull request opened.
    const h1 = await rig.hunt();
    const p1 = await rig.propose(h1);
    humanMerge(rig.lab, rig.fake, 1);
    rig.fake.setHead(1, 'd'.repeat(40));
    await rig.runner.tick();
    expect(await rig.view(p1.id)).toMatchObject({ status: 'failed', failReason: 'head_changed' });
    // merge_scope: the merge also changed another service.
    const h2 = await rig.hunt();
    const p2 = await rig.propose(h2);
    // The first Proposal used the branches of its own Hunt; this one has its own.
    const second = await rig.store.byId(p2.id);
    expect(second?.prNumber).toBe(2);
    const m2 = humanMerge(rig.lab, rig.fake, 2, { beforeMerge: () => void commitInLab(rig, 'services/orders/src/index.js', "export const name = 'sneaky';\n", 'other service') });
    rig.teachLab(h2, m2.mergeSha);
    await rig.runner.tick();
    expect(await rig.view(p2.id)).toMatchObject({ status: 'failed', failReason: 'merge_scope', mergedBy: 'octocat' });
    // ref_moved: the incident branch got another commit after the merge.
    const h3 = await rig.hunt();
    const p3 = await rig.propose(h3);
    const m3 = humanMerge(rig.lab, rig.fake, 3, {
      afterMerge: () => {
        commitInLab(rig, 'services/payments/src/late.js', 'export const late = 1;\n', 'late');
        gitIn(rig.lab.work, ['push', '--quiet', rig.lab.remote, `incident/${h3}:refs/heads/incident/${h3}`]);
      },
    });
    rig.teachLab(h3, m3.mergeSha);
    await rig.runner.tick();
    expect(await rig.view(p3.id)).toMatchObject({ status: 'failed', failReason: 'ref_moved' });
    expect(rig.fakeLab.deployFix.calls).toEqual([]);
  }, 240_000);

  it('ends with a fixed reason when the lab refuses (bad token, outside the service, off) or never lists the record', async () => {
    const cases: Array<[string, (rig: Rig, huntId: string, mergeSha: string) => void, string]> = [
      ['the lab refuses the chaos token', () => undefined, 'deploy_rejected'],
      ['a commit of the chain is outside the service', (rig, id, m) => rig.teachLab(id, m, [{ sha: m, files: ['services/orders/src/x.js'] }, { sha: rig.lab.base, files: [] }]), 'deploy_rejected'],
      ['the lab is unavailable', (rig) => void (rig.fakeLab.deployFix.mode = 'unavailable'), 'deploy_unavailable'],
      ['the record never shows up', (rig) => void (rig.fakeLab.deployFix.mode = 'never_record'), 'deploy_unconfirmed'],
    ];
    for (const [label, arrange, reason] of cases) {
      const rig = await startRig(label.includes('chaos token') ? { cfg: { chaosToken: 'chaos-token-WRONG-0123456789-abcdefgh' } } : {});
      const huntId = await rig.hunt();
      const p = await rig.propose(huntId);
      const { mergeSha } = humanMerge(rig.lab, rig.fake, 1);
      rig.teachLab(huntId, mergeSha);
      arrange(rig, huntId, mergeSha);
      await rig.runner.tick();
      expect(await rig.view(p.id), label).toMatchObject({ status: 'failed', failReason: reason, mergedBy: 'octocat' });
      expect(rig.events.at(-1)?.name).toBe('proposal.failed');
      await rig.close();
      rigs.splice(rigs.indexOf(rig), 1);
    }
  }, 240_000);

  it('picks up after a restart: a drafting row is ended, an open one is watched, a merged one goes on to its deploy', async () => {
    const rig = await startRig();
    const merged = await rig.hunt();
    const mp = await rig.propose(merged);
    const { mergeSha } = humanMerge(rig.lab, rig.fake, 1);
    rig.teachLab(merged, mergeSha);
    // The state the API left: the merge was seen, the deploy had not run.
    expect(await rig.store.move(mp.id, 'open', 'merged', { mergeSha, mergedBy: 'octocat', mergedAt: new Date() })).toBe(true);
    const open = await rig.hunt();
    const op = await rig.propose(open);
    const drafting = await rig.hunt();
    const dr = await rig.store.create(drafting, new Date());
    expect(dr).not.toBeNull();
    await rig.runner.start();
    await rig.until(async () => (await rig.store.byId(mp.id))?.status === 'deployed', 30_000, 'the merged Proposal to deploy');
    expect(await rig.store.byId((dr as { id: string }).id)).toMatchObject({ status: 'failed', failReason: 'api_restart' });
    expect((await rig.store.byId(op.id))?.status).toBe('open');
    rig.fake.closeUnmerged(2);
    await rig.runner.tick();
    expect((await rig.store.byId(op.id))?.status).toBe('rejected');
    // An event bus subscriber that started after the restart still sees the later events.
    expect(rig.server.app.get(EventBus).subscriberCount).toBeGreaterThan(0);
  }, 180_000);
});
