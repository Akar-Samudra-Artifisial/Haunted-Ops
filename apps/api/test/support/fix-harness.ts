import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { HuntDetail, ServiceName } from '@haunted-ops/shared';
import { createFakeKiroFixer, type FakeKiroFixer } from '../../../../tools/fake-kiro-cli/fixer-wrapper.mjs';
import { startFakeGithub, type FakeGithub } from '../../../../tools/fake-kiro-cli/fake-github.mjs';
import { EventBus, type BusEvent } from '../../src/events/event-bus.js';
import { HuntProcess } from '../../src/hunts/hunt-process.js';
import { JsonLogger } from '../../src/security/logger.js';
import type { LabAnswer, LabDeploy } from '../../src/hunts/lab-client.js';
import type { FixConfig } from '../../src/fix/fix-config.js';
import { FixerWorkdir } from '../../src/fix/fixer-workdir.js';
import { GitClient, defaultGitExec, type GitExec } from '../../src/fix/git-client.js';
import { GithubClient } from '../../src/fix/github-client.js';
import { PROPOSAL_LABELS } from '../../src/fix/fix-startup.js';
import type { DeployFixAnswer, FixLab } from '../../src/fix/lab-deploy-client.js';
import { ProposalRunner, type ProposalRunnerDeps } from '../../src/fix/proposal-runner.js';
import { DUMMY_GITHUB_TOKEN, MemoryProposalStore } from './fix.js';
import { deleteRefIn, gitIn, makeLabRepo, syncRefsFrom, type LabRepo } from './lab-repo.js';

export const REPO = 'Akar-Samudra-Artifisial/Haunted-Lab';
export const WEB_ORIGIN = 'http://localhost:5173';
export const NOW = new Date('2026-11-14T10:00:00.000Z');

const pad = (n: number): string => String(n).padStart(19, '0');

/** The lab, in memory: the Deploy Records the runner reads, and the chaos route it calls. */
export class MemoryFixLab implements FixLab {
  records: LabDeploy[] = [];
  mode: 'ok' | 'rejected' | 'unavailable' | 'never_record' = 'ok';
  calls: Array<{ service: ServiceName; huntId: string; sha: string }> = [];
  deploysDown = false;
  private n = 900;

  async deploys(): Promise<LabAnswer<LabDeploy[]>> {
    return this.deploysDown ? { kind: 'unavailable' } : { kind: 'ok', value: [...this.records] };
  }

  async deployFix(body: { service: ServiceName; huntId: string; sha: string }): Promise<DeployFixAnswer> {
    this.calls.push(body);
    if (this.mode === 'rejected') return { kind: 'rejected', status: 409 };
    if (this.mode === 'unavailable') return { kind: 'unavailable' };
    const record: LabDeploy = { id: `d-${++this.n}`, service: body.service, sha: body.sha, time: NOW.toISOString(), actor: 'exorcist' };
    if (this.mode === 'ok') this.records.push(record);
    return { kind: 'ok', deployId: record.id };
  }
}

export interface HuntOptions {
  service?: ServiceName;
  culpritService?: ServiceName;
  culpritSha?: string;
  deployId?: string;
  summary?: string;
}

export interface Harness {
  lab: LabRepo;
  fake: FakeGithub;
  github: GithubClient;
  git: GitClient;
  workdir: FixerWorkdir;
  store: MemoryProposalStore;
  bus: EventBus;
  events: BusEvent[];
  logs: string[];
  labApi: MemoryFixLab;
  runner: ProposalRunner;
  cfg: FixConfig;
  huntCfg: { dailyCreditCap: number; dailyMax: number; kiroCliPath: string };
  hunts: Map<string, HuntDetail>;
  tmp: string;
  gitCalls: Array<{ args: string[]; env: Record<string, string> }>;
  spawned: string[];
  state: { huntsEnabled: boolean; startsToday: number; creditsToday: number };
  /** Adds a succeeded Hunt with a diagnosis; its id is a valid CUID. */
  addHunt(o?: HuntOptions): HuntDetail;
  /** Points the fixer at a fixture of `tools/fake-kiro-cli/fixtures/fixer`. */
  useFixture(name: string): FakeKiroFixer;
  /** A person merges the pull request on GitHub: a merge commit on `incident/<huntId>` and the fake's merged state. */
  merge(prNumber: number, o?: { by?: string | null; beforeMerge?: () => void; afterMerge?: () => void }): { mergeSha: string; huntId: string };
  names(): string[];
  cleanup(): Promise<void>;
}

export interface HarnessOptions {
  cfg?: Partial<FixConfig>;
  huntCfg?: Partial<Harness['huntCfg']>;
  runner?: Partial<ProposalRunnerDeps>;
  fixture?: string;
  /** Wraps the git client the runner uses (the harness keeps the real one), to change what happens between steps. */
  gitWrap?: (git: GitClient) => ProposalRunnerDeps['git'];
}

/**
 * Everything the Proposal runner touches, with no network and no Credits: a local git "remote" (fixed authors and
 * dates), the fake GitHub on top of it, the real git and GitHub clients, the fake kiro-cli fixer, a lab in memory.
 */
export async function makeHarness(o: HarnessOptions = {}): Promise<Harness> {
  const lab = makeLabRepo();
  const tmp = mkdtempSync(join(tmpdir(), 'fix-harness-'));
  const fake = await startFakeGithub({ repo: REPO, token: DUMMY_GITHUB_TOKEN, syncRefs: syncRefsFrom(lab.remote), onDeleteRef: deleteRefIn(lab.remote) });
  const gitCalls: Harness['gitCalls'] = [];
  const exec: GitExec = (file, args, opts) => {
    gitCalls.push({ args: [...args], env: { ...opts.env } });
    return defaultGitExec(file, args, opts);
  };
  const git = new GitClient({ gitPath: '/usr/bin/git', repo: REPO, token: DUMMY_GITHUB_TOKEN, exec, remoteUrl: () => `file://${lab.remote}`, allowFileProtocol: true, home: tmp, commitDate: () => NOW });
  const github = new GithubClient({ token: DUMMY_GITHUB_TOKEN, repo: REPO, baseUrl: fake.url, sleep: async () => undefined });
  await github.ensureLabels(PROPOSAL_LABELS);
  const workdir = new FixerWorkdir(join(tmp, 'fix'));
  const hunts = new Map<string, HuntDetail>();
  const store = new MemoryProposalStore(() => NOW, (huntId) => hunts.get(huntId)?.service ?? 'payments');
  const bus = new EventBus();
  const events: BusEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const logs: string[] = [];
  const logger = new JsonLogger((line) => logs.push(line), () => NOW);
  const labApi = new MemoryFixLab();
  labApi.records.push({ id: 'd-7', service: 'payments', sha: lab.base, time: '2026-11-14T09:00:00.000Z' });
  const state = { huntsEnabled: true, startsToday: 0, creditsToday: 0 };
  const cfg: FixConfig = {
    enabled: true,
    githubToken: DUMMY_GITHUB_TOKEN,
    repo: REPO,
    chaosUrl: 'http://127.0.0.1:4100',
    chaosToken: 'chaos-token-0123456789-abcdefghij',
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
    // The harness clock stands still, so a missing Deploy Record ends the Proposal at once unless a test sets a window.
    deployConfirmMs: 0,
    workdir: join(tmp, 'fix'),
    ...o.cfg,
  };
  const huntCfg = { dailyCreditCap: 30, dailyMax: 40, kiroCliPath: '/nonexistent/kiro-cli', ...o.huntCfg };
  const fixers: FakeKiroFixer[] = [];
  const spawned: string[] = [];
  const huntsApi: ProposalRunnerDeps['hunts'] = {
    get: async (id) => hunts.get(id) ?? null,
    creditsToday: async () => state.creditsToday + store.rows.reduce((s, r) => s + r.credits, 0),
    startedToday: async () => state.startsToday,
  };
  const runner = new ProposalRunner({
    config: cfg,
    huntConfig: huntCfg,
    proposals: store,
    hunts: huntsApi,
    lab: labApi,
    github,
    git: o.gitWrap === undefined ? git : o.gitWrap(git),
    workdir,
    bus,
    logger,
    huntsEnabled: () => state.huntsEnabled,
    now: () => NOW,
    sleep: async () => undefined,
    parentEnv: { HOME: tmp, LANG: 'en_US.UTF-8', GITHUB_TOKEN: DUMMY_GITHUB_TOKEN },
    spawn: (opts) => {
      spawned.push(opts.executable);
      return new HuntProcess(opts);
    },
    reapOrphans: async () => 0,
    timings: { confirmMs: 60, confirmEveryMs: 5, deployRetries: 3, retryBackoffMs: 1 },
    poll: false,
    ...o.runner,
  });
  await workdir.prepareRoot();

  const h: Harness = {
    lab,
    fake,
    github,
    git,
    workdir,
    store,
    bus,
    events,
    logs,
    labApi,
    runner,
    cfg,
    huntCfg,
    hunts,
    tmp,
    gitCalls,
    spawned,
    state,
    addHunt(opts = {}) {
      const id = `cmhunt${pad(hunts.size + 1)}`;
      const service = opts.service ?? 'payments';
      const detail = {
        id,
        incidentId: `cminc${pad(hunts.size + 1)}`,
        service,
        trigger: 'auto',
        status: 'succeeded',
        reason: 'diagnosed',
        steps: [],
        stepCount: 4,
        evidenceCount: 3,
        diagnosis: { culpritDeploy: opts.deployId ?? 'd-7', culpritSha: opts.culpritSha ?? lab.culprit, culpritService: opts.culpritService ?? service, summary: opts.summary ?? 'The guard on a missing order was removed.' },
        credits: 0.9,
        queuedAt: NOW.toISOString(),
        startedAt: NOW.toISOString(),
        finishedAt: NOW.toISOString(),
        diagnosedBy: null,
        model: 'claude-sonnet-5.5',
        toolCalls: 12,
        durationMs: 5000,
        invalidCheck: null,
        stopDetail: null,
        creditsEstimated: false,
        linkedHuntId: null,
        allSteps: [],
        evidence: [
          { index: 1, kind: 'metric', ref: 'metric:payments/error_ratio/15m', detail: 'errors rose', cited: true },
          { index: 2, kind: 'deploy', ref: 'deploy:d-7', detail: 'deploy before the rise', cited: true },
          { index: 3, kind: 'log', ref: 'log:1', detail: 'not cited', cited: false },
        ],
        fixHint: 'Restore the guard on a missing order.',
        proposal: null,
      } as unknown as HuntDetail;
      hunts.set(id, detail);
      return detail;
    },
    useFixture(name) {
      const f = createFakeKiroFixer({ fixture: name, observe: true });
      fixers.push(f);
      huntCfg.kiroCliPath = f.path;
      return f;
    },
    merge: (prNumber, mo = {}) => humanMerge(lab, fake, prNumber, mo),
    names: () => events.map((e) => e.name),
    async cleanup() {
      await runner.stop().catch(() => undefined);
      for (const f of fixers) f.cleanup();
      await fake.close();
      await workdir.remove('cmprop0000000000000000001').catch(() => undefined);
      lab.cleanup();
      rmSync(tmp, { recursive: true, force: true });
    },
  };
  if (o.fixture !== undefined) h.useFixture(o.fixture);
  return h;
}

/**
 * A person merges the pull request on GitHub: a merge commit on `incident/<huntId>` (pushed to the local remote) and the
 * merged state in the fake GitHub. `beforeMerge` runs with the incident branch checked out, before the merge commit.
 */
export function humanMerge(
  lab: LabRepo,
  fake: FakeGithub,
  prNumber: number,
  mo: { by?: string | null; beforeMerge?: () => void; afterMerge?: () => void } = {},
): { mergeSha: string; huntId: string } {
  const pull = fake.pulls.find((p) => p.number === prNumber);
  if (pull === undefined) throw new Error('unknown pull request');
  const huntId = pull.head.replace('exorcist/', '');
  const incident = `incident/${huntId}`;
  const fix = `exorcist/${huntId}`;
  gitIn(lab.work, ['fetch', '--quiet', lab.remote, `+refs/heads/${incident}:refs/heads/${incident}`, `+refs/heads/${fix}:refs/heads/${fix}`]);
  gitIn(lab.work, ['checkout', '--quiet', incident]);
  mo.beforeMerge?.();
  gitIn(lab.work, ['merge', '--quiet', '--no-ff', '--no-edit', fix]);
  const mergeSha = gitIn(lab.work, ['rev-parse', 'HEAD']);
  gitIn(lab.work, ['push', '--quiet', lab.remote, `${incident}:refs/heads/${incident}`]);
  mo.afterMerge?.();
  fake.merge(prNumber, { mergeSha, by: mo.by === undefined ? 'octocat' : mo.by });
  return { mergeSha, huntId };
}

/** The first-parent chain from `head` down to `stop` (inclusive) with the files each commit touches, as the lab walks it. */
export function chainFrom(lab: LabRepo, head: string, stop: string): Array<{ sha: string; files: string[] }> {
  const shas = gitIn(lab.work, ['rev-list', '--first-parent', head]).split('\n');
  const out: Array<{ sha: string; files: string[] }> = [];
  for (const sha of shas) {
    const files = gitIn(lab.work, ['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', sha]).split('\n').filter((f) => f !== '');
    out.push({ sha, files });
    if (sha === stop) break;
  }
  return out;
}

/** A file written into the lab work repository on the current branch (for a merge that carries more than the fix). */
export function commitInLab(h: { lab: LabRepo }, rel: string, text: string, message = 'extra'): string {
  mkdirSync(dirname(join(h.lab.work, rel)), { recursive: true });
  writeFileSync(join(h.lab.work, rel), text);
  gitIn(h.lab.work, ['add', '-A']);
  gitIn(h.lab.work, ['commit', '--quiet', '-m', message]);
  return gitIn(h.lab.work, ['rev-parse', 'HEAD']);
}
