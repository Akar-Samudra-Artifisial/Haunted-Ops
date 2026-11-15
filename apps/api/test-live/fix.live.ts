import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROPOSAL_BRANCH_PATTERN, fixBranch, incidentBranch, validateProposalView } from '@haunted-ops/shared';
import type { FixConfig } from '../src/fix/fix-config.js';
import { FIXER_STREAM_SUFFIX } from '../src/fix/fixer-workdir.js';
import type { ProposalRunner } from '../src/fix/proposal-runner.js';
import { PrismaHuntStore } from '../src/hunts/hunt-store.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import type { TestServer } from '../test/support/http.js';
import { failureBlock, startLiveApp, waitForProposal } from './live-app.js';
/**
 * One real fixer and one real pull request on the Lab repo. It spends about 1 Credit and writes to GitHub, so it
 * runs only with FIX_LIVE=1 and never as part of `pnpm test`:
 *   FIX_LIVE=1 pnpm --filter @haunted-ops/api test:live
 * Needs, in the environment (names only): HUNTS_ENABLED is set by the test; FIX_ENABLED is set by the test; and
 *   GITHUB_TOKEN, LAB_GITHUB_REPO, CHAOS_URL, CHAOS_TOKEN, WEB_ORIGIN, LAB_URL, LAB_READ_TOKEN, HUNT_ADMIN_TOKEN,
 *   KIRO_CLI_PATH (the real kiro-cli), PROMETHEUS_URL, TEST_DATABASE_URL.
 * The app is built by `live-app.ts`, which the credit-free parity test uses too. Run `pnpm --filter
 * @haunted-ops/api preflight:live` first: it checks all of the above without calling the model.
 * The Lab supervisor must be running with the scenarios planted. The test applies `error-spike`, writes a succeeded
 * Hunt that names the planted commit (no Hunt runs), asks for a Proposal, waits for it to be `open`, and then, in a
 * `finally`, closes the pull request and deletes `incident/<huntId>` and `exorcist/<huntId>` through its own REST
 * helper below. That helper refuses every other branch name, so `main` and `scenario/*` can never be touched.
 * The pull request is never merged.
 */
const LIVE = process.env.FIX_LIVE === '1';
const PLANTED = '65c0fca31d0df62c4bab40d2d854c81b1044c650';
const GITHUB_API = 'https://api.github.com';
/** The test's own GitHub helper: closes a pull request and deletes the two branches of one Hunt. Nothing else. */
export class LiveCleanup {
  constructor(
    private readonly token: string,
    private readonly repo: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}
  private async call(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    const res = await this.fetchFn(`${GITHUB_API}/repos/${this.repo}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'haunted-ops-live-test',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    try {
      return { status: res.status, json: text === '' ? null : (JSON.parse(text) as unknown) };
    } catch {
      return { status: res.status, json: null };
    }
  }
  /** Closes every open pull request whose head is `exorcist/<huntId>`. Returns how many it closed. */
  async closePulls(huntId: string): Promise<number> {
    const head = fixBranch(huntId);
    const owner = this.repo.split('/')[0] ?? '';
    const list = await this.call('GET', `/pulls?state=open&head=${encodeURIComponent(`${owner}:${head}`)}&per_page=10`);
    if (list.status !== 200 || !Array.isArray(list.json)) return 0;
    let closed = 0;
    for (const pr of list.json as Array<{ number?: unknown }>) {
      if (typeof pr.number !== 'number') continue;
      const res = await this.call('PATCH', `/pulls/${pr.number}`, { state: 'closed' });
      if (res.status === 200) closed += 1;
    }
    return closed;
  }
  /** Deletes one branch. Only `incident/<cuid>` and `exorcist/<cuid>` are accepted. 404 and 422 mean it is gone. */
  async deleteBranch(name: string): Promise<boolean> {
    if (!PROPOSAL_BRANCH_PATTERN.test(name)) throw new Error('refused: not a proposal branch');
    const res = await this.call('DELETE', `/git/refs/heads/${name.split('/').map(encodeURIComponent).join('/')}`);
    return res.status === 204 || res.status === 404 || res.status === 422;
  }
  /** The whole cleanup of one Hunt: close first, then delete both branches. */
  async cleanHunt(huntId: string): Promise<{ closed: number; branches: boolean[] }> {
    const closed = await this.closePulls(huntId);
    const branches = [await this.deleteBranch(fixBranch(huntId)), await this.deleteBranch(incidentBranch(huntId))];
    return { closed, branches };
  }
}
describe.skipIf(!LIVE)('live fix proposal (real fixer, real pull request on the Lab repo)', () => {
  let server: TestServer;
  let fixCfg: FixConfig;
  let runner: ProposalRunner;
  let huntId: string | null = null;
  const say = (line: string): void => void process.stderr.write(`[fix-live] ${line}\n`);
  const chaosUrl = (process.env.CHAOS_URL ?? 'http://127.0.0.1:4100').replace(/\/+$/, '');
  const chaos = (path: string): Promise<Response> => fetch(`${chaosUrl}${path}`, { method: 'POST', headers: { authorization: `Bearer ${process.env.CHAOS_TOKEN ?? ''}` } });
  const admin = process.env.HUNT_ADMIN_TOKEN ?? '';
  beforeAll(async () => {
    // The kiro-cli version (it prints nothing else), so a run on another version is visible in the output.
    const version = execFileSync(process.env.KIRO_CLI_PATH ?? 'kiro-cli', ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim().slice(0, 80);
    say(`kiro-cli ${version}`);
    // One helper builds the app, for this test and for the parity test: `parentEnv` (HOME, LANG) is always set, as
    // the live test is the exception to the guard that refuses a missing `parentEnv` under Vitest.
    ({ server, fixCfg, runner } = await startLiveApp(process.env));
  });
  afterAll(async () => {
    try {
      // Stop the API first (it stops a fixer that still runs), so nothing can push after the cleanup.
      await server?.close();
    } finally {
      try {
        // Always: close the pull request and delete the two branches of this run, then reset the Lab.
        if (huntId !== null && fixCfg.githubToken !== null && fixCfg.repo !== null) {
          const cleanup = new LiveCleanup(fixCfg.githubToken, fixCfg.repo);
          const done = await cleanup.cleanHunt(huntId);
          process.stderr.write(`[fix.live] cleanup: closed ${done.closed} pull request(s), branches removed ${done.branches.every(Boolean)}\n`);
        }
      } finally {
        await chaos('/chaos/reset').catch(() => undefined);
      }
    }
  });
  it('opens a pull request from a real fixer run, then the test closes it and removes its branches', async () => {
    // The lab dependency tree and the test baseline are made at start; the clock of the proposal starts after them.
    say('waiting for the lab dependencies and the test baseline');
    await runner.idle();
    expect((await chaos('/chaos/scenarios/error-spike/apply')).status).toBe(200);
    // The deploy of the planted commit, as the Lab reports it.
    const labUrl = (process.env.LAB_URL ?? '').replace(/\/+$/, '');
    const since = new Date(Date.now() - 24 * 3600_000).toISOString();
    const deploys = await fetch(`${labUrl}/lab/deploys?since=${encodeURIComponent(since)}`, { headers: { authorization: `Bearer ${process.env.LAB_READ_TOKEN ?? ''}` } });
    expect(deploys.status).toBe(200);
    const items = ((await deploys.json()) as { items: Array<{ id: string; service: string; sha: string; time: string }> }).items;
    const culprit = items.filter((d) => d.service === 'payments' && d.sha === PLANTED).sort((a, b) => b.time.localeCompare(a.time))[0];
    expect(culprit, 'a payments deploy of the planted commit').toBeDefined();
    const prisma = server.app.get(PrismaService).client;
    const hunts = new PrismaHuntStore(prisma);
    const service = await prisma.service.findFirstOrThrow({ where: { name: 'payments' } });
    const incident = await prisma.incident.create({ data: { serviceId: service.id, peakLevel: 3, openedAt: new Date(Date.now() - 600_000), closedAt: new Date(Date.now() - 1_000) } });
    const created = await hunts.create({ incidentId: incident.id, serviceId: service.id, trigger: 'operator', model: fixCfg.model });
    huntId = created.id;
    await hunts.markRunning(created.id, new Date(Date.now() - 60_000));
    await hunts.addEvidence(created.id, { order: 1, kind: 'deploy', ref: `deploy:${culprit!.id}`, detail: 'payments deploy' });
    await hunts.addEvidence(created.id, { order: 2, kind: 'commit', ref: `commit:${PLANTED}`, detail: 'planted commit' });
    await hunts.finish(created.id, {
      status: 'succeeded',
      reason: 'diagnosed',
      invalidCheck: null,
      credits: 0,
      toolCalls: 0,
      durationMs: 1000,
      finishedAt: new Date(),
      diagnosis: {
        culpritDeploy: culprit!.id,
        culpritSha: PLANTED,
        culpritService: 'payments',
        summary: 'The planted commit made payments fail on a missing order.',
        fixHint: 'Restore the guard on a missing order.',
        cited: [`deploy:${culprit!.id}`, `commit:${PLANTED}`],
      },
    });
    const started = await fetch(`${server.url}/api/hunts/${created.id}/proposal`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${admin}` }, body: '{}' });
    expect(started.status).toBe(202);
    const { proposalId } = (await started.json()) as { proposalId: string };
    say(`proposal started, stream file ${proposalId}${FIXER_STREAM_SUFFIX} in the streams folder of FIX_WORKDIR`);
    // The deadline is the fixer's own timeout plus a minute for the checks and the push.
    const deadline = Date.now() + fixCfg.timeoutMs + 60_000;
    const view = await waitForProposal(server.url, proposalId, deadline, (status) => say(`status ${status}`));
    const ok = view?.status === 'open' && view.kind === 'ai_patch';
    // A failed run says why before the first assertion: the fields of the Proposal and the log lines about it.
    if (!ok || view === null) process.stderr.write(`${failureBlock(view, server.logs)}\n`);
    expect(view).not.toBeNull();
    expect(validateProposalView(view).ok).toBe(true);
    expect(view).toMatchObject({ status: 'open', kind: 'ai_patch' });
    expect(view?.prUrl).toMatch(/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/);
    expect(view?.checks.every((c) => c.ok || c.name === 'touches_culprit_files')).toBe(true);
  }, 1_000_000);
});
/** Runs always (no network, no Credits): the cleanup helper can reach nothing but the two branches of a Hunt. */
describe('live cleanup helper', () => {
  it('refuses main, scenario branches and any name that is not incident/<cuid> or exorcist/<cuid>', async () => {
    const calls: string[] = [];
    const fake = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${String(url)}`);
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const cleanup = new LiveCleanup('fake-token-not-real', 'owner/repo', fake);
    for (const name of ['main', 'scenario/error-spike', 'incident/short', 'exorcist/../main', 'incident/cmhunt0000000000000000001/x']) {
      await expect(cleanup.deleteBranch(name)).rejects.toThrow('refused');
    }
    expect(calls).toEqual([]);
    expect(await cleanup.deleteBranch('exorcist/cmhunt0000000000000000001')).toBe(true);
    expect(calls).toEqual(['DELETE https://api.github.com/repos/owner/repo/git/refs/heads/exorcist/cmhunt0000000000000000001']);
  });
});
