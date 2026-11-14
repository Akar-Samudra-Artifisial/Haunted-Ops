import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DUMMY_GITHUB_TOKEN } from '../../test/support/fix.js';
import { NOW, REPO, commitInLab, makeHarness, type Harness } from '../../test/support/fix-harness.js';
import { gitIn } from '../../test/support/lab-repo.js';
import { prTextProblems } from './pr-text.js';

const live: Harness[] = [];
const make = async (...args: Parameters<typeof makeHarness>): Promise<Harness> => {
  const h = await makeHarness(...args);
  live.push(h);
  return h;
};
afterEach(async () => {
  for (const h of live.splice(0)) await h.cleanup();
});

/** Asks for a Proposal and waits for the draft to end. */
async function propose(h: Harness, huntId: string): Promise<string> {
  const out = await h.runner.request(huntId, 'operator');
  if (out.kind !== 'started') throw new Error(`not started: ${out.kind}`);
  await h.runner.idle();
  return out.proposalId;
}

const GIT_ENV = { PATH: process.env.PATH ?? '/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/dev/null' };
const updateRef = (h: Harness, branch: string, sha: string): void => void execFileSync('git', ['-C', h.lab.remote, 'update-ref', `refs/heads/${branch}`, sha], { env: GIT_ENV });

const remoteRefs = (h: Harness): string[] =>
  execFileSync('git', ['-C', h.lab.remote, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads'], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/dev/null' } })
    .trim()
    .split('\n');

describe('ProposalRunner: from a succeeded Hunt to a pull request', () => {
  it('writes a good fix, passes the checks, pushes the two branches and opens the pull request', async () => {
    const h = await make({ fixture: 'fixer-good' });
    const hunt = h.addHunt();
    const id = await propose(h, hunt.id);
    const rec = await h.store.byId(id);
    expect(rec).toMatchObject({ status: 'open', kind: 'ai_patch', aiFailReason: null, prNumber: 1, attempt: 1, agentStarted: true, credits: 0.6, creditsEstimated: false, branch: `exorcist/${hunt.id}`, baseBranch: `incident/${hunt.id}`, baseSha: h.lab.base });
    expect(rec?.prUrl).toBe(`https://github.com/${REPO}/pull/1`);
    expect(rec?.checks.map((c) => c.name)).toEqual(['non_empty', 'scope', 'forbidden_file', 'size', 'syntax', 'tests', 'touches_culprit_files']);
    expect(rec?.checks.every((c) => c.ok)).toBe(true);
    expect(rec?.patchFiles).toBe(1);
    expect(rec?.patchLines).toBe(1);
    // The branches: the incident branch is at the deployed commit, the fix branch is one commit on top of it.
    const refs = remoteRefs(h);
    expect(refs).toContain(`refs/heads/incident/${hunt.id} ${h.lab.base}`);
    const fixLine = refs.find((r) => r.startsWith(`refs/heads/exorcist/${hunt.id} `)) as string;
    expect(fixLine.split(' ')[1]).toBe(rec?.headSha);
    expect(gitIn(h.lab.work, ['fetch', '--quiet', h.lab.remote, `+refs/heads/exorcist/${hunt.id}:refs/heads/exorcist/${hunt.id}`])).toBe('');
    expect(gitIn(h.lab.work, ['rev-list', '--count', `${h.lab.base}..exorcist/${hunt.id}`])).toBe('1');
    // Main and the scenario branches did not move.
    expect(refs).toContain(`refs/heads/main ${h.lab.main}`);
    expect(refs).toContain(`refs/heads/scenario/error-spike ${h.lab.culprit}`);
    // The pull request.
    const pull = h.fake.pulls[0];
    expect(pull).toMatchObject({ head: `exorcist/${hunt.id}`, base: `incident/${hunt.id}`, labels: ['exorcist', 'ai_patch'], state: 'open' });
    expect(pull?.title.startsWith('Exorcist: ')).toBe(true);
    expect(prTextProblems(pull?.title ?? '', pull?.body ?? '', { repo: REPO, webOrigin: 'http://localhost:5173' })).toEqual([]);
    expect(pull?.body).toContain(`http://localhost:5173/hunts/${hunt.id}`);
    expect(pull?.body).toContain('Patch kind: ai_patch');
    // The events follow the graph, and the summary is what the Service state shows.
    expect(h.names()).toEqual(['proposal.started', 'proposal.checks', 'proposal.opened']);
    expect(h.runner.latest('payments')).toMatchObject({ id, status: 'open', kind: 'ai_patch', prNumber: 1 });
    expect(h.store.moves.map((m) => `${m.from}>${m.to}`)).toEqual(['drafting>open']);
  }, 60_000);

  it('goes on to deployed when a person merges it: the merged commit is the one deployed', async () => {
    const h = await make({ fixture: 'fixer-good' });
    const hunt = h.addHunt();
    const id = await propose(h, hunt.id);
    await h.runner.tick();
    expect((await h.store.byId(id))?.status).toBe('open');
    expect(h.labApi.calls).toEqual([]);
    const { mergeSha } = h.merge(1, { by: 'octocat' });
    await h.runner.tick();
    const rec = await h.store.byId(id);
    expect(rec).toMatchObject({ status: 'deployed', mergeSha, mergedBy: 'octocat' });
    expect(h.labApi.calls).toEqual([{ service: 'payments', huntId: hunt.id, sha: mergeSha }]);
    expect(h.names()).toEqual(['proposal.started', 'proposal.checks', 'proposal.opened', 'proposal.merged', 'proposal.deployed']);
    expect(h.store.moves.map((m) => `${m.from}>${m.to}`)).toEqual(['drafting>open', 'open>merged', 'merged>deployed']);
    // The API never merged anything: GitHub saw no merge, review or comment request.
    expect(h.fake.requests.some((r) => /merge|reviews|comments|requested_reviewers/.test(r.path) || ['PUT', 'PATCH'].includes(r.method))).toBe(false);
    expect(h.runner.latest('payments')?.status).toBe('deployed');
  }, 60_000);

  it('ends a pull request that was closed without a merge as rejected, and deploys nothing', async () => {
    const h = await make({ fixture: 'fixer-good' });
    const id = await propose(h, h.addHunt().id);
    h.fake.closeUnmerged(1);
    await h.runner.tick();
    expect((await h.store.byId(id))?.status).toBe('rejected');
    expect(h.names().at(-1)).toBe('proposal.rejected');
    expect(h.labApi.calls).toEqual([]);
  }, 60_000);

  it('polls an open Proposal once per tick with its ETag, and changes nothing while GitHub says nothing changed', async () => {
    const h = await make({ fixture: 'fixer-good' });
    const id = await propose(h, h.addHunt().id);
    const before = JSON.stringify(await h.store.byId(id));
    await h.runner.tick();
    const etag = (await h.store.byId(id))?.etag;
    expect(etag).toMatch(/^W\//);
    await h.runner.tick();
    await h.runner.tick();
    const gets = h.fake.requests.filter((r) => r.method === 'GET' && r.path === `/repos/${REPO}/pulls/1`);
    expect(gets).toHaveLength(3);
    expect((await h.store.byId(id))?.etag).toBe(etag);
    expect(JSON.parse(before).status).toBe('open');
    expect(h.store.moves.map((m) => `${m.from}>${m.to}`)).toEqual(['drafting>open']);
  }, 60_000);
});

describe('ProposalRunner: when the patch cannot be used, the revert', () => {
  const cases: Array<[string, string]> = [
    ['fixer-big', 'size'],
    ['fixer-scope', 'scope'],
    ['fixer-forbidden', 'forbidden_file'],
    ['fixer-test-edit', 'forbidden_file'],
    ['fixer-delete-test', 'forbidden_file'],
    ['fixer-symlink', 'forbidden_file'],
    ['fixer-no-change', 'scope'],
    ['fixer-breaks-tests', 'tests_failed'],
    ['fixer-syntax', 'tests_failed'],
    ['fixer-foreign-tool', 'agent_failed'],
    ['fixer-path-escape', 'agent_failed'],
    ['fixer-reuse-id', 'agent_failed'],
    ['fixer-over-cap', 'agent_failed'],
    ['fixer-fail-exit', 'agent_failed'],
  ];

  it.each(cases)('%s: the patch is refused as %s and a revert of the culprit commit is proposed', async (fixture, reason) => {
    const h = await make({ fixture });
    const hunt = h.addHunt();
    const id = await propose(h, hunt.id);
    const rec = await h.store.byId(id);
    expect(rec).toMatchObject({ status: 'open', kind: 'revert', aiFailReason: reason });
    expect(rec?.checks.map((c) => c.name)).toEqual(['scope', 'forbidden_file', 'tests']);
    expect(h.fake.pulls[0]?.labels).toEqual(['exorcist', 'revert']);
    expect(h.fake.pulls[0]?.title).toBe(`Exorcist: Revert ${h.lab.culprit.slice(0, 7)} in payments`);
    // The fix commit is a revert of the culprit: the tree is the one before it.
    const fix = rec?.headSha as string;
    gitIn(h.lab.work, ['fetch', '--quiet', h.lab.remote, `+refs/heads/exorcist/${hunt.id}:refs/heads/exorcist/${hunt.id}`]);
    expect(gitIn(h.lab.work, ['rev-parse', `${fix}^{tree}`])).toBe(gitIn(h.lab.work, ['rev-parse', `${h.lab.main}^{tree}`]));
    expect(h.names()).toEqual(['proposal.started', 'proposal.checks', 'proposal.opened']);
  }, 60_000);

  it('ends a fixer that is too slow as a timeout, then proposes the revert, with the cap charged', async () => {
    const h = await make({ fixture: 'fixer-timeout', cfg: { timeoutMs: 1200 } });
    const id = await propose(h, h.addHunt().id);
    expect(await h.store.byId(id)).toMatchObject({ status: 'open', kind: 'revert', aiFailReason: 'timeout', credits: 1.5, creditsEstimated: true });
  }, 60_000);

  it('keeps the patch kind a function of the checks: a patch that passes is never replaced by the revert', async () => {
    const h = await make({ fixture: 'fixer-wrapped' });
    const id = await propose(h, h.addHunt().id);
    expect(await h.store.byId(id)).toMatchObject({ status: 'open', kind: 'ai_patch', aiFailReason: null });
  }, 60_000);
});

describe('ProposalRunner: when neither can be used', () => {
  it('ends checks_failed when the revert does not apply cleanly, and pushes nothing', async () => {
    const h = await make({ fixture: 'fixer-breaks-tests' });
    // The deployed commit changed the same lines after the culprit.
    gitIn(h.lab.work, ['checkout', '--quiet', '-b', 'scenario/conflict', h.lab.culprit]);
    const d = commitInLab(h, 'services/payments/src/charge.js', 'export const changed = true;\n', 'rewrite charge');
    execFileSync('git', ['-C', h.lab.work, 'push', '--quiet', h.lab.remote, 'scenario/conflict'], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/dev/null' } });
    h.labApi.records.push({ id: 'd-8', service: 'payments', sha: d, time: '2026-11-14T09:30:00.000Z' });
    const before = remoteRefs(h);
    const id = await propose(h, h.addHunt().id);
    expect(await h.store.byId(id)).toMatchObject({ status: 'checks_failed', failReason: 'revert_conflict', aiFailReason: 'tests_failed', kind: null, prNumber: null });
    expect(remoteRefs(h)).toEqual(before);
    expect(h.fake.pulls).toHaveLength(0);
    expect(h.names()).toEqual(['proposal.started', 'proposal.failed']);
    expect(h.events.at(-1)?.payload).toMatchObject({ status: 'checks_failed', failReason: 'revert_conflict' });
  }, 60_000);

  it('ends checks_failed with revert_unavailable when the culprit is not an ancestor of the deployed commit', async () => {
    const h = await make({ fixture: 'fixer-no-change' });
    const id = await propose(h, h.addHunt({ culpritSha: h.lab.other }).id);
    expect(await h.store.byId(id)).toMatchObject({ status: 'checks_failed', failReason: 'revert_unavailable', aiFailReason: 'scope' });
    expect(h.fake.pulls).toHaveLength(0);
  }, 60_000);

  it('ends checks_failed when the revert fails its checks: a service with no test cannot be verified', async () => {
    const h = await make({ fixture: 'fixer-no-change' });
    // The culprit service is orders: it has no test file, and tests are required.
    h.labApi.records.push({ id: 'd-9', service: 'orders', sha: h.lab.other, time: '2026-11-14T09:40:00.000Z' });
    const hunt = h.addHunt({ service: 'orders', culpritService: 'orders', culpritSha: h.lab.other });
    const id = await propose(h, hunt.id);
    expect(await h.store.byId(id)).toMatchObject({ status: 'checks_failed', failReason: 'checks_failed', kind: null });
    expect((await h.store.byId(id))?.checks).toEqual([{ name: 'scope', ok: true }, { name: 'forbidden_file', ok: true }, { name: 'tests', ok: false }]);
    expect(h.names()).toEqual(['proposal.started', 'proposal.checks', 'proposal.failed']);
    expect(h.fake.pulls).toHaveLength(0);
  }, 60_000);

  it('opens the revert with "no test ran" when tests are not required', async () => {
    const h = await make({ fixture: 'fixer-no-change', cfg: { requireTests: false } });
    h.labApi.records.push({ id: 'd-9', service: 'orders', sha: h.lab.other, time: '2026-11-14T09:40:00.000Z' });
    const hunt = h.addHunt({ service: 'orders', culpritService: 'orders', culpritSha: h.lab.other });
    const id = await propose(h, hunt.id);
    expect(await h.store.byId(id)).toMatchObject({ status: 'open', kind: 'revert' });
    expect(h.fake.pulls[0]?.body).toContain('- tests: no test ran');
  }, 60_000);

  it('fails with a fixed reason when the lab cannot say what is deployed, or has no deploy of the service', async () => {
    const h = await make({ fixture: 'fixer-good' });
    h.labApi.deploysDown = true;
    expect(await h.store.byId(await propose(h, h.addHunt().id))).toMatchObject({ status: 'failed', failReason: 'lab_unavailable' });
    h.labApi.deploysDown = false;
    h.labApi.records.length = 0;
    expect(await h.store.byId(await propose(h, h.addHunt().id))).toMatchObject({ status: 'failed', failReason: 'base_unknown' });
    expect(h.fake.pulls).toHaveLength(0);
  }, 60_000);

  it('retries after a partial push: a leftover branch with no open pull request is replaced, one already at D is kept', async () => {
    const h = await make({ fixture: 'fixer-good' });
    // An earlier attempt pushed `incident/<id>` somewhere else and stopped before the fix branch.
    const stale = h.addHunt();
    updateRef(h, `incident/${stale.id}`, h.lab.main);
    const first = await propose(h, stale.id);
    expect(await h.store.byId(first)).toMatchObject({ status: 'open', prNumber: 1 });
    expect(remoteRefs(h)).toContain(`refs/heads/incident/${stale.id} ${h.lab.base}`);
    // An earlier attempt pushed `incident/<id>` at D already: it is done, not refused and not pushed again.
    const done = h.addHunt();
    updateRef(h, `incident/${done.id}`, h.lab.base);
    const second = await propose(h, done.id);
    expect(await h.store.byId(second)).toMatchObject({ status: 'open', prNumber: 2 });
    const pushes = h.gitCalls.filter((c) => c.args.includes('push') && c.args.some((a) => a.endsWith(`incident/${done.id}`)));
    expect(pushes).toEqual([]);
    // main and the scenario branches never moved.
    expect(remoteRefs(h)).toContain(`refs/heads/main ${h.lab.main}`);
  }, 90_000);

  it('fails with branch_exists, and changes nothing, when an open pull request uses a branch of the Hunt', async () => {
    const h = await make({ fixture: 'fixer-good' });
    const hunt = h.addHunt();
    updateRef(h, `incident/${hunt.id}`, h.lab.main);
    updateRef(h, `exorcist/${hunt.id}`, h.lab.main);
    await h.github.createPull({ title: 'someone else', head: `exorcist/${hunt.id}`, base: `incident/${hunt.id}`, body: 'x' });
    const id = await propose(h, hunt.id);
    expect(await h.store.byId(id)).toMatchObject({ status: 'failed', failReason: 'branch_exists' });
    expect(remoteRefs(h)).toContain(`refs/heads/incident/${hunt.id} ${h.lab.main}`);
    expect(remoteRefs(h)).toContain(`refs/heads/exorcist/${hunt.id} ${h.lab.main}`);
  }, 60_000);

  it('fails with a GitHub code when opening the pull request is refused, never with its message', async () => {
    const h = await make({ fixture: 'fixer-good' });
    h.fake.failNext(401);
    // The first GitHub call of the flow is the branch check: a bad token is the code, not the answer.
    const id = await propose(h, h.addHunt().id);
    expect(await h.store.byId(id)).toMatchObject({ status: 'failed', failReason: 'github_unauthorized' });
    expect(h.logs.join('')).not.toContain('Bad credentials');
    expect(h.logs.join('')).not.toContain('forced');
  }, 60_000);
});

describe('ProposalRunner: what is merged must be what was pushed', () => {
  it('does not deploy when the head of the pull request changed (head_changed)', async () => {
    const h = await make({ fixture: 'fixer-good' });
    const id = await propose(h, h.addHunt().id);
    h.merge(1);
    h.fake.setHead(1, 'd'.repeat(40));
    await h.runner.tick();
    expect(await h.store.byId(id)).toMatchObject({ status: 'failed', failReason: 'head_changed' });
    expect(h.labApi.calls).toEqual([]);
    expect(h.names().at(-1)).toBe('proposal.failed');
  }, 60_000);

  it('does not deploy when the incident branch moved after the merge (ref_moved)', async () => {
    const h = await make({ fixture: 'fixer-good' });
    const hunt = h.addHunt();
    const id = await propose(h, hunt.id);
    h.merge(1, {
      afterMerge: () => {
        commitInLab(h, 'services/payments/src/late.js', 'export const late = 1;\n', 'late push');
        gitIn(h.lab.work, ['push', '--quiet', h.lab.remote, `incident/${hunt.id}:refs/heads/incident/${hunt.id}`]);
      },
    });
    await h.runner.tick();
    expect(await h.store.byId(id)).toMatchObject({ status: 'failed', failReason: 'ref_moved' });
    expect(h.labApi.calls).toEqual([]);
  }, 60_000);

  it('does not deploy when the merge changed files outside the service (merge_scope)', async () => {
    const h = await make({ fixture: 'fixer-good' });
    const id = await propose(h, h.addHunt().id);
    h.merge(1, { beforeMerge: () => void commitInLab(h, 'services/orders/src/index.js', "export const name = 'sneaky';\n", 'other service') });
    await h.runner.tick();
    expect(await h.store.byId(id)).toMatchObject({ status: 'failed', failReason: 'merge_scope', mergedBy: 'octocat' });
    expect(h.labApi.calls).toEqual([]);
  }, 60_000);

  it('does not deploy when an AI patch grew after it was reviewed beyond what was pushed (merge_scope)', async () => {
    const h = await make({ fixture: 'fixer-good' });
    const id = await propose(h, h.addHunt().id);
    h.merge(1, { beforeMerge: () => void commitInLab(h, 'services/payments/src/more.js', 'export const more = 1;\n', 'more') });
    await h.runner.tick();
    expect(await h.store.byId(id)).toMatchObject({ status: 'failed', failReason: 'merge_scope' });
  }, 60_000);
});

describe('ProposalRunner: the deploy', () => {
  it('ends with a fixed reason when the lab refuses, cannot be reached, or never lists the record', async () => {
    for (const [mode, reason, calls] of [['rejected', 'deploy_rejected', 1], ['unavailable', 'deploy_unavailable', 3], ['never_record', 'deploy_unconfirmed', 1]] as const) {
      const h = await make({ fixture: 'fixer-good' });
      h.labApi.mode = mode;
      const id = await propose(h, h.addHunt().id);
      h.merge(1);
      await h.runner.tick();
      expect(await h.store.byId(id), mode).toMatchObject({ status: 'failed', failReason: reason, mergedBy: 'octocat' });
      expect(h.labApi.calls, mode).toHaveLength(calls);
      expect(h.names().at(-1)).toBe('proposal.failed');
      await h.cleanup();
      live.splice(live.indexOf(h), 1);
    }
  }, 120_000);

  it('does not touch the Incident: it only asks the lab to deploy', async () => {
    const h = await make({ fixture: 'fixer-good' });
    const id = await propose(h, h.addHunt().id);
    h.merge(1);
    await h.runner.tick();
    expect((await h.store.byId(id))?.status).toBe('deployed');
    expect(h.names().filter((n) => n.startsWith('incident'))).toEqual([]);
  }, 60_000);
});

describe('ProposalRunner: limits', () => {
  it('uses the revert and starts no fixer when the day has no budget left', async () => {
    const h = await make({ fixture: 'fixer-good' });
    h.state.creditsToday = 29;
    const id = await propose(h, h.addHunt().id);
    expect(await h.store.byId(id)).toMatchObject({ status: 'open', kind: 'revert', aiFailReason: 'budget', agentStarted: false, credits: 0 });
    expect(h.spawned).toEqual([]);
  }, 60_000);

  it('uses the revert and starts no fixer when the day has no start left', async () => {
    const h = await make({ fixture: 'fixer-good', huntCfg: { dailyMax: 3 } });
    h.state.startsToday = 3;
    const id = await propose(h, h.addHunt().id);
    expect(await h.store.byId(id)).toMatchObject({ status: 'open', kind: 'revert', aiFailReason: 'daily_limit', agentStarted: false });
    expect(h.spawned).toEqual([]);
  }, 60_000);

  it('counts a fixer run once in the starts, and its credits in the day', async () => {
    const h = await make({ fixture: 'fixer-good', huntCfg: { dailyMax: 1 } });
    await propose(h, h.addHunt().id);
    expect(h.spawned).toHaveLength(1);
    expect(await h.store.fixerStartsToday(NOW)).toBe(1);
    // The next one in the same day has no start left.
    h.state.startsToday = 0;
    const second = await propose(h, h.addHunt().id);
    expect(await h.store.byId(second)).toMatchObject({ kind: 'revert', aiFailReason: 'daily_limit' });
    expect(h.spawned).toHaveLength(1);
  }, 90_000);

  it('stops a running fixer when the Kill switch goes off, proposes the revert, and starts no new Proposal while it is off', async () => {
    const h = await make({ fixture: 'fixer-timeout', cfg: { timeoutMs: 60_000 } });
    const hunt = h.addHunt();
    const out = await h.runner.request(hunt.id, 'operator');
    expect(out.kind).toBe('started');
    // Wait until the fixer process is running.
    for (let i = 0; i < 200 && h.spawned.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
    expect(h.spawned).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 300));
    h.state.huntsEnabled = false;
    h.runner.killSwitchChanged(false);
    await h.runner.idle();
    const rec = await h.store.byId((out as { proposalId: string }).proposalId);
    expect(rec).toMatchObject({ status: 'open', kind: 'revert', aiFailReason: 'agent_failed', creditsEstimated: true });
    expect(await h.runner.request(h.addHunt().id, 'operator')).toEqual({ kind: 'disabled' });
    // An open Proposal is still watched.
    h.fake.closeUnmerged(1);
    await h.runner.tick();
    expect((await h.store.byId(rec?.id as string))?.status).toBe('rejected');
  }, 60_000);
});

describe('ProposalRunner: requests', () => {
  it('answers each request with what it did: started, conflict, not_found, not_succeeded, disabled', async () => {
    const h = await make({ fixture: 'fixer-good' });
    const hunt = h.addHunt();
    const first = await h.runner.request(hunt.id, 'operator');
    expect(first).toMatchObject({ kind: 'started', attempt: 1 });
    expect(await h.runner.request(hunt.id, 'operator')).toEqual({ kind: 'conflict' });
    await h.runner.idle();
    expect(await h.runner.request(hunt.id, 'operator')).toEqual({ kind: 'conflict' });
    expect(await h.runner.request('cmnohuntaaaaaaaaaaaaaaaaaa', 'operator')).toEqual({ kind: 'not_found' });
    expect(await h.runner.request('../x', 'operator')).toEqual({ kind: 'not_found' });
    const failed = h.addHunt();
    (h.hunts.get(failed.id) as { status: string }).status = 'failed';
    expect(await h.runner.request(failed.id, 'operator')).toEqual({ kind: 'not_succeeded' });
    const off = await make({ fixture: 'fixer-good', cfg: { enabled: false } });
    const calls = off.fake.requests.length;
    expect(await off.runner.request(off.addHunt().id, 'operator')).toEqual({ kind: 'disabled' });
    expect(off.fake.requests).toHaveLength(calls);
    expect(off.store.rows).toHaveLength(0);
  }, 60_000);

  it('retries a failed Proposal as the next attempt, and does not ask again after a person closed or merged one', async () => {
    const h = await make({ fixture: 'fixer-good' });
    const hunt = h.addHunt();
    h.labApi.deploysDown = true;
    const first = await propose(h, hunt.id);
    expect(await h.store.byId(first)).toMatchObject({ status: 'failed', failReason: 'lab_unavailable', attempt: 1 });
    h.labApi.deploysDown = false;
    const retry = await h.runner.request(hunt.id, 'operator');
    expect(retry).toMatchObject({ kind: 'started', attempt: 2 });
    await h.runner.idle();
    expect(h.store.rows.map((r) => [r.attempt, r.status])).toEqual([[1, 'failed'], [2, 'open']]);
    // A second request while one is open is a conflict; a closed pull request is final and is not asked again.
    expect(await h.runner.request(hunt.id, 'operator')).toEqual({ kind: 'conflict' });
    h.fake.closeUnmerged(1);
    await h.runner.tick();
    expect(await h.runner.request(hunt.id, 'operator')).toEqual({ kind: 'conflict' });
    expect(h.store.rows).toHaveLength(2);
  }, 90_000);

  it('starts a Proposal by itself when a Hunt succeeds, and once per Hunt', async () => {
    const h = await make({ fixture: 'fixer-good' });
    await h.runner.start();
    const hunt = h.addHunt();
    const payload = { huntId: hunt.id, service: 'payments', status: 'succeeded', reason: 'diagnosed', invalidCheck: null, diagnosedBy: null, credits: 0.9, durationMs: 5000, toolCalls: 12, finishedAt: NOW.toISOString() };
    h.bus.publish('hunt.finished', payload as never);
    await new Promise((r) => setTimeout(r, 50));
    await h.runner.idle();
    expect((await h.store.latestOfHunt(hunt.id))?.status).toBe('open');
    // The same Hunt finishing again, or a failed Hunt, starts nothing.
    h.bus.publish('hunt.finished', payload as never);
    h.bus.publish('hunt.finished', { ...payload, status: 'failed', reason: 'timeout' } as never);
    await new Promise((r) => setTimeout(r, 50));
    await h.runner.idle();
    expect(h.store.rows).toHaveLength(1);
    await h.runner.stop();
  }, 90_000);
});

describe('ProposalRunner: a restart (Property 14)', () => {
  it('ends the drafting, keeps watching the open, continues the merged, and leaves the final ones, after it reaped leftovers', async () => {
    const order: string[] = [];
    const h = await make({ fixture: 'fixer-good', runner: { reapOrphans: async () => (order.push('reap'), 2) } });
    const hunt = h.addHunt();
    const openId = await propose(h, hunt.id);
    const merged = h.addHunt();
    const mergedId = await propose(h, merged.id);
    h.merge(2);
    // `merged` as the API left it: the tick had seen the merge, but the deploy had not run.
    await h.store.move(mergedId, 'open', 'merged', { mergeSha: h.fake.pulls[1]?.mergeSha ?? undefined, mergedBy: 'octocat', mergedAt: NOW });
    const drafting = await h.store.create(h.addHunt().id, NOW);
    const done = await h.store.create(h.addHunt().id, NOW);
    await h.store.move((done as { id: string }).id, 'drafting', 'failed', { failReason: 'internal' });
    const origSweep = h.store.sweepDrafting.bind(h.store);
    h.store.sweepDrafting = async (now) => (order.push('sweep'), origSweep(now));
    await h.runner.start();
    for (let i = 0; i < 200 && (await h.store.byId(mergedId))?.status !== 'deployed'; i++) await new Promise((r) => setTimeout(r, 50));
    expect(order.slice(0, 2)).toEqual(['reap', 'sweep']);
    expect(await h.store.byId((drafting as { id: string }).id)).toMatchObject({ status: 'failed', failReason: 'api_restart' });
    expect((await h.store.byId((done as { id: string }).id))?.failReason).toBe('internal');
    expect((await h.store.byId(mergedId))?.status).toBe('deployed');
    expect((await h.store.byId(openId))?.status).toBe('open');
    // The open one is watched again: a merge is seen after the restart.
    h.merge(1);
    await h.runner.tick();
    expect((await h.store.byId(openId))?.status).toBe('deployed');
    await h.runner.stop();
  }, 120_000);
});

// Feature: fix-proposal-flow, Property 3 (the whole flow)
describe('Property 3: the token is nowhere it must not be', () => {
  it('never appears in an argument, a log, an event, a pull request or the fixer environment, over a whole flow', async () => {
    const h = await make({ fixture: 'fixer-good' });
    const id = await propose(h, h.addHunt().id);
    h.merge(1);
    await h.runner.tick();
    expect((await h.store.byId(id))?.status).toBe('deployed');
    const b64 = Buffer.from(`x-access-token:${DUMMY_GITHUB_TOKEN}`).toString('base64');
    const texts: Array<[string, string]> = [
      ['logs', h.logs.join('')],
      ['events', JSON.stringify(h.events.map((e) => e.payload))],
      ['pulls', JSON.stringify(h.fake.pulls)],
      ['argv', h.gitCalls.map((c) => c.args.join(' ')).join('\n')],
      ['record', JSON.stringify(await h.store.byId(id))],
      ['view', JSON.stringify(await h.store.view(id))],
    ];
    for (const [name, text] of texts) {
      expect(text.includes(DUMMY_GITHUB_TOKEN), name).toBe(false);
      expect(text.includes(b64), name).toBe(false);
    }
    // Only fetch and push calls carry it in their environment.
    for (const c of h.gitCalls) {
      const carries = Object.values(c.env).some((v) => v.includes(b64));
      expect(carries, c.args.join(' ')).toBe(c.args.includes('push') || c.args.includes('fetch'));
    }
    expect(h.gitCalls.some((c) => c.args.includes('push'))).toBe(true);
    // The fixer got no token: its observed environment names are the whitelist.
    expect(h.spawned).toHaveLength(1);
    expect(REPO).toContain('/');
  }, 60_000);
});

// --- task 13: review fixes ---

/** A git client that behaves like the real one except for the methods given. */
function gitWith(over: Partial<Record<string, (...args: never[]) => unknown>>) {
  return (git: object) =>
    new Proxy(git, {
      get(target, key, receiver) {
        if (typeof key === 'string' && key in over) return over[key];
        const value = Reflect.get(target, key, receiver) as unknown;
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    }) as never;
}

describe('ProposalRunner: tested equals pushed (13.2)', () => {
  it('does not push an AI patch whose tree changed after its tests ran, and proposes the revert instead', async () => {
    let real: { stagedTree(dir: string): Promise<string> } | null = null;
    const h = await make({
      fixture: 'fixer-good',
      gitWrap: (git) => {
        real = git;
        return gitWith({
          // A file appears in the candidate clone between the test run and the commit.
          stagedTree: async (dir: string) => {
            if (dir.endsWith('-patch')) writeFileSync(join(dir, 'services/payments/src/late.js'), 'export const late = 1;\n');
            return (real as NonNullable<typeof real>).stagedTree(dir);
          },
        })(git);
      },
    });
    const hunt = h.addHunt();
    const id = await propose(h, hunt.id);
    expect(await h.store.byId(id)).toMatchObject({ status: 'open', kind: 'revert', aiFailReason: 'scope' });
    // What was pushed is the revert: the late file is not on the fix branch.
    const head = (await h.store.byId(id))?.headSha as string;
    gitIn(h.lab.work, ['fetch', '--quiet', h.lab.remote, `+refs/heads/exorcist/${hunt.id}:refs/heads/exorcist/${hunt.id}`]);
    expect(gitIn(h.lab.work, ['ls-tree', '-r', '--name-only', head])).not.toContain('late.js');
  }, 90_000);

  it('ends checks_failed (scope) when the revert clone changed after its tests ran', async () => {
    let real: { stagedTree(dir: string): Promise<string> } | null = null;
    const h = await make({
      fixture: 'fixer-breaks-tests',
      gitWrap: (git) => {
        real = git;
        return gitWith({
          stagedTree: async (dir: string) => {
            if (dir.endsWith('-revert')) writeFileSync(join(dir, 'services/payments/src/late.js'), 'export const late = 1;\n');
            return (real as NonNullable<typeof real>).stagedTree(dir);
          },
        })(git);
      },
    });
    const id = await propose(h, h.addHunt().id);
    const rec = await h.store.byId(id);
    expect(rec).toMatchObject({ status: 'checks_failed', failReason: 'checks_failed', prNumber: null });
    expect(rec?.checks).toContainEqual({ name: 'scope', ok: false });
    expect(h.fake.pulls).toHaveLength(0);
  }, 90_000);
});

describe('ProposalRunner: the ETag is stored with what it answered (13.3)', () => {
  it('still sees the merge on the next poll when storing the merge failed once', async () => {
    const h = await make({ fixture: 'fixer-good' });
    const id = await propose(h, h.addHunt().id);
    // A first poll while the pull request is open stores the ETag of that answer.
    await h.runner.tick();
    expect((await h.store.byId(id))?.etag).not.toBeNull();
    h.merge(1);
    const move = h.store.move.bind(h.store);
    let failures = 0;
    h.store.move = async (...args: Parameters<typeof move>) => {
      if (failures === 0 && args[1] === 'open' && args[2] === 'merged') {
        failures++;
        throw new Error('database unavailable');
      }
      return move(...args);
    };
    await h.runner.tick();
    expect((await h.store.byId(id))?.status).toBe('open');
    // The fake answers 304 to an ETag it has given for the current version: the next poll must not send that one.
    await h.runner.tick();
    expect(await h.store.byId(id)).toMatchObject({ status: 'deployed', mergedBy: 'octocat' });
    expect(failures).toBe(1);
  }, 60_000);
});

describe('ProposalRunner: what GitHub merged holds what was pushed (13.4)', () => {
  /** A person merges on GitHub and edits a file in the same merge commit. */
  function mergeWithEdit(h: Harness, huntId: string): string {
    const incident = `incident/${huntId}`;
    const fix = `exorcist/${huntId}`;
    gitIn(h.lab.work, ['fetch', '--quiet', h.lab.remote, `+refs/heads/${incident}:refs/heads/${incident}`, `+refs/heads/${fix}:refs/heads/${fix}`]);
    gitIn(h.lab.work, ['checkout', '--quiet', incident]);
    gitIn(h.lab.work, ['merge', '--quiet', '--no-ff', '--no-commit', fix]);
    const file = join(h.lab.work, 'services/payments/src/charge.js');
    writeFileSync(file, `${readFileSync(file, 'utf8')}// edited while merging\n`);
    gitIn(h.lab.work, ['add', '-A']);
    gitIn(h.lab.work, ['commit', '--quiet', '-m', 'Merge pull request #1 with an edit']);
    const mergeSha = gitIn(h.lab.work, ['rev-parse', 'HEAD']);
    gitIn(h.lab.work, ['push', '--quiet', h.lab.remote, `${incident}:refs/heads/${incident}`]);
    h.fake.merge(1, { mergeSha, by: 'octocat' });
    return mergeSha;
  }

  it('does not deploy a merge whose tree is not the pushed head (an edit made on GitHub): merge_content', async () => {
    const h = await make({ fixture: 'fixer-good' });
    const hunt = h.addHunt();
    const id = await propose(h, hunt.id);
    mergeWithEdit(h, hunt.id);
    await h.runner.tick();
    expect(await h.store.byId(id)).toMatchObject({ status: 'failed', failReason: 'merge_content', mergedBy: 'octocat' });
    expect(h.labApi.calls).toEqual([]);
    expect(h.names().at(-1)).toBe('proposal.failed');
  }, 60_000);

  it('deploys a squash merge whose tree is the pushed head', async () => {
    const h = await make({ fixture: 'fixer-good' });
    const hunt = h.addHunt();
    const id = await propose(h, hunt.id);
    const incident = `incident/${hunt.id}`;
    const fix = `exorcist/${hunt.id}`;
    gitIn(h.lab.work, ['fetch', '--quiet', h.lab.remote, `+refs/heads/${incident}:refs/heads/${incident}`, `+refs/heads/${fix}:refs/heads/${fix}`]);
    gitIn(h.lab.work, ['checkout', '--quiet', incident]);
    gitIn(h.lab.work, ['merge', '--quiet', '--squash', fix]);
    gitIn(h.lab.work, ['commit', '--quiet', '-m', 'Squashed (#1)']);
    const mergeSha = gitIn(h.lab.work, ['rev-parse', 'HEAD']);
    gitIn(h.lab.work, ['push', '--quiet', h.lab.remote, `${incident}:refs/heads/${incident}`]);
    h.fake.merge(1, { mergeSha, by: 'octocat' });
    await h.runner.tick();
    expect(await h.store.byId(id)).toMatchObject({ status: 'deployed' });
    expect(h.labApi.calls).toEqual([{ service: 'payments', huntId: hunt.id, sha: mergeSha }]);
  }, 60_000);
});

describe('ProposalRunner: the deploy after a restart, and its confirmation (13.5, 13.8)', () => {
  it('goes straight to deployed, with no second deploy call, when the lab already lists the deploy', async () => {
    const h = await make({ fixture: 'fixer-good' });
    const id = await propose(h, h.addHunt().id);
    const { mergeSha } = h.merge(1);
    // The API stopped after the deploy call: the row is merged and the lab has the Deploy Record.
    expect(await h.store.move(id, 'open', 'merged', { mergeSha, mergedBy: 'octocat', mergedAt: NOW })).toBe(true);
    h.labApi.records.push({ id: 'd-950', service: 'payments', sha: mergeSha, time: NOW.toISOString(), actor: 'exorcist' });
    await h.runner.start();
    for (let i = 0; i < 200 && (await h.store.byId(id))?.status !== 'deployed'; i++) await new Promise((r) => setTimeout(r, 25));
    expect(await h.store.byId(id)).toMatchObject({ status: 'deployed' });
    expect(h.labApi.calls).toEqual([]);
  }, 60_000);

  it('keeps a merged Proposal waiting while the Deploy Record is late, and does not deploy twice', async () => {
    const clock = { t: NOW.getTime() };
    const h = await make({ fixture: 'fixer-good', cfg: { deployConfirmMs: 60_000 }, runner: { now: () => new Date(clock.t) } });
    h.labApi.mode = 'never_record';
    const id = await propose(h, h.addHunt().id);
    const { mergeSha } = h.merge(1);
    await h.runner.tick();
    // The first look found no record: still merged, not failed.
    expect((await h.store.byId(id))?.status).toBe('merged');
    expect(h.labApi.calls).toHaveLength(1);
    clock.t += 20_000;
    h.labApi.records.push({ id: 'd-951', service: 'payments', sha: mergeSha, time: new Date(clock.t).toISOString(), actor: 'exorcist' });
    await h.runner.tick();
    expect((await h.store.byId(id))?.status).toBe('deployed');
    expect(h.labApi.calls).toHaveLength(1);
  }, 60_000);

  it('ends deploy_unconfirmed only after FIX_DEPLOY_CONFIRM_MS from the merge', async () => {
    const clock = { t: NOW.getTime() };
    const h = await make({ fixture: 'fixer-good', cfg: { deployConfirmMs: 60_000 }, runner: { now: () => new Date(clock.t) } });
    h.labApi.mode = 'never_record';
    const id = await propose(h, h.addHunt().id);
    h.merge(1);
    await h.runner.tick();
    clock.t += 30_000;
    await h.runner.tick();
    expect((await h.store.byId(id))?.status).toBe('merged');
    clock.t += 31_000;
    await h.runner.tick();
    expect(await h.store.byId(id)).toMatchObject({ status: 'failed', failReason: 'deploy_unconfirmed' });
    expect(h.labApi.calls).toHaveLength(1);
  }, 60_000);
});

describe('ProposalRunner: a merge GitHub names no one for (13.9)', () => {
  it('stores mergedBy null, says merged without a login, and deploys', async () => {
    const h = await make({ fixture: 'fixer-good' });
    const id = await propose(h, h.addHunt().id);
    h.merge(1, { by: null });
    await h.runner.tick();
    expect(await h.store.byId(id)).toMatchObject({ status: 'deployed', mergedBy: null });
    const merged = h.events.find((e) => e.name === 'proposal.merged');
    expect(merged?.payload).toMatchObject({ mergedBy: null });
  }, 60_000);
});
