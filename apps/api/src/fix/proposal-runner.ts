import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  type AiFailReason,
  type HuntDetail,
  type ProposalCheck,
  type ProposalEventPayloads,
  type ProposalFailReason,
  type ProposalKind,
  type ProposalSummary,
  type ServiceName,
  CUID_PATTERN,
  FULL_SHA_PATTERN,
  fixBranch,
  incidentBranch,
} from '@haunted-ops/shared';
import type { EventBus } from '../events/event-bus.js';
import { fitsDailyBudget } from '../hunts/guards.js';
import type { HuntStopReason } from '../hunts/hunt-process.js';
import type { HuntProcessLike } from '../hunts/hunt-runner.js';
import type { HuntProcessOptions } from '../hunts/hunt-process.js';
import type { HuntConfig } from '../hunts/hunt-config.js';
import type { HuntStore } from '../hunts/hunt-store.js';
import { HuntWorkdir } from '../hunts/hunt-workdir.js';
import type { JsonLogger } from '../security/logger.js';
import { BranchCleanup } from './branch-cleanup.js';
import { publishBranches } from './branch-publisher.js';
import { CHECK_TMP, checkSyntax, findTestFiles, runChecks } from './check-run.js';
import type { FixConfig } from './fix-config.js';
import { fixerPrompt, MAX_DIFF_BYTES } from './fix-env.js';
import { startFixer, type FixerHandle } from './fixer-process.js';
import { exportPathsOf, type FixerWorkdir } from './fixer-workdir.js';
import type { GitClient } from './git-client.js';
import type { GithubClient } from './github-client.js';
import type { FixLab } from './lab-deploy-client.js';
import { judgePatch, readPatch, type JudgeContext, type Patch } from './patch-checks.js';
import { ProposalError, errorCodeOf, failReasonOf } from './proposal-error.js';
import { toProposalSummary, type ProposalRecord, type ProposalStore } from './proposal-store.js';
import { openPullRequest } from './pull-request.js';
import { attemptRevert, judgeRevert, revertFileProblems } from './revert.js';
import { sanitizePrText } from './pr-text.js';

type Git = Pick<
  GitClient,
  | 'ensureMirror'
  | 'fetchIncidentBranch'
  | 'hasCommit'
  | 'descendsFromBase'
  | 'archive'
  | 'showDiff'
  | 'changedFiles'
  | 'cloneAt'
  | 'stageAndCount'
  | 'commit'
  | 'amendMessage'
  | 'revert'
  | 'parents'
  | 'isAncestor'
  | 'diffNames'
  | 'numstat'
  | 'push'
  | 'revParse'
  | 'stagedTree'
  | 'treeOf'
  | 'fetchFixBranch'
>;
type Github = Pick<GithubClient, 'branchExists' | 'branchHead' | 'createPull' | 'addLabels' | 'getPull' | 'listProposalBranches' | 'listOpenPullRefs' | 'commitDate' | 'deleteBranch'> & { rateLimitedUntil?: number };

export interface ProposalRunnerDeps {
  config: FixConfig;
  huntConfig: Pick<HuntConfig, 'dailyCreditCap' | 'dailyMax' | 'kiroCliPath'>;
  proposals: ProposalStore;
  hunts: Pick<HuntStore, 'get' | 'creditsToday' | 'startedToday'>;
  lab: FixLab;
  github: Github;
  git: Git;
  workdir: FixerWorkdir;
  bus: Pick<EventBus, 'publish' | 'subscribe'>;
  logger: JsonLogger;
  /** The Hunt Kill switch: false stops new Proposals. */
  huntsEnabled: () => boolean;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /** The environment of the API process: only `HOME` and `LANG` reach the fixer. */
  parentEnv?: Readonly<Record<string, string | undefined>>;
  /** Test seam: a fake process in place of `kiro-cli`. */
  spawn?: (opts: HuntProcessOptions) => HuntProcessLike;
  /** Kills the `kiro-cli` groups a crashed API left behind; default reads the pid notes of the fix folder. */
  reapOrphans?: () => Promise<number>;
  timings?: { confirmMs?: number; confirmEveryMs?: number; deployRetries?: number; retryBackoffMs?: number };
  /** Start the poll timer (default true). Tests call `tick()` by hand. */
  poll?: boolean;
}

export type ProposalRequestResult =
  | { kind: 'started'; proposalId: string; attempt: number }
  | { kind: 'disabled' }
  | { kind: 'not_found' }
  | { kind: 'not_succeeded' }
  /** A Proposal of this Hunt is still active, or (automatic trigger) this Hunt already has one. */
  | { kind: 'conflict' };

/**
 * Whether the fixer may not start: the day's Credits plus the per-run cap would go over the daily cap (`budget`), or
 * the day's starts (Hunts and fixer runs together) have reached `HUNT_DAILY_MAX` (`daily_limit`). Pure.
 */
export function aiDeniedReason(i: { spent: number; starts: number; creditCap: number; dailyCreditCap: number; dailyMax: number }): 'budget' | 'daily_limit' | null {
  if (!fitsDailyBudget(i.spent, i.creditCap, i.dailyCreditCap)) return 'budget';
  return i.starts >= i.dailyMax ? 'daily_limit' : null;
}

const DEPLOY_LOOKBACK_MS = 7 * 24 * 3_600_000;
const iso = (d: Date): string => d.toISOString();
const oneLine = (text: string, max: number): string => sanitizePrText(text.split(/(?<=[.!?])\s/)[0] ?? text, max).replaceAll('\u200b', '');

interface Candidate {
  kind: ProposalKind;
  dir: string;
  baseSha: string;
  fixSha: string;
  checks: ProposalCheck[];
  patchFiles: number | null;
  patchLines: number | null;
  testsRan: boolean;
}

/**
 * The flow of one Proposal for one succeeded Hunt. It finds the commit the lab runs for the culprit Service, runs the
 * fixer in a folder that holds only that service, judges the patch (and falls back to a revert of the culprit commit),
 * pushes `incident/<huntId>` and `exorcist/<huntId>`, opens the pull request, and then watches it. When a human merges
 * it, and what was merged is what was pushed, it asks the lab to deploy the merge commit. It never merges, never closes
 * a pull request and never touches `main` or a scenario branch.
 */
export class ProposalRunner {
  private readonly cfg: FixConfig;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private unsubscribe: (() => void) | null = null;
  private timer: NodeJS.Timeout | null = null;
  private branchCleanup: BranchCleanup | null = null;
  private chain: Promise<void> = Promise.resolve();
  private readonly busy = new Set<string>();
  /** Merged Proposals whose deploy was asked for in this process (a restart asks again only if the lab lists none). */
  private readonly deployAsked = new Set<string>();
  private current: { id: string; handle: FixerHandle | null } | null = null;
  private stopping = false;
  private readonly latestByService = new Map<ServiceName, ProposalSummary>();

  constructor(private readonly deps: ProposalRunnerDeps) {
    this.cfg = deps.config;
    this.now = deps.now ?? (() => new Date());
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  // --- life ---

  /** At start: reap fixer processes a crash left behind, end the Proposals that were drafting, load the latest ones, watch. */
  async start(): Promise<void> {
    if (!this.cfg.enabled) return;
    const reaped = await (this.deps.reapOrphans ?? (() => new HuntWorkdir(this.cfg.workdir).reapOrphans()))().catch(() => 0);
    if (reaped > 0) this.deps.logger.log('warn', 'fixer processes reaped', { count: reaped });
    await this.deps.workdir.prepareRoot();
    const swept = await this.deps.proposals.sweepDrafting(this.now());
    if (swept > 0) this.deps.logger.log('warn', 'proposals ended by a restart', { count: swept });
    const latest = await this.deps.proposals.latestPerService().catch(() => new Map<ServiceName, ProposalSummary>());
    for (const [name, summary] of latest) this.latestByService.set(name, summary);
    this.unsubscribe = this.deps.bus.subscribe((ev) => {
      if (ev.name !== 'hunt.finished') return;
      const p = ev.payload as { huntId?: unknown; status?: unknown };
      if (p.status === 'succeeded' && typeof p.huntId === 'string') void this.request(p.huntId, 'auto').catch(() => undefined);
    });
    // A Proposal that was merged when the API stopped goes on to its deploy.
    for (const rec of await this.deps.proposals.listByStatus(['merged'])) void this.continueMerged(rec);
    if (this.deps.poll !== false) {
      this.timer = setInterval(() => void this.tick().catch(() => undefined), this.cfg.pollMs);
      this.timer.unref();
      // Old proposal branches go at start and every hour (never `main`, a scenario branch or an open pull request).
      this.branchCleanup = new BranchCleanup({ github: this.deps.github, proposals: this.deps.proposals, ttlDays: this.cfg.branchTtlDays, logger: this.deps.logger, now: this.now });
      this.branchCleanup.start();
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    await this.branchCleanup?.stop();
    this.branchCleanup = null;
    this.current?.handle?.stop('shutdown');
    await this.chain.catch(() => undefined);
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  /** The Hunt Kill switch changed: turning it off stops a running fixer (an open Proposal keeps being watched). */
  killSwitchChanged(enabled: boolean): void {
    if (!enabled) this.current?.handle?.stop('disabled');
  }

  /** The latest Proposal of the latest Hunt of a Service, for `service.updated` and `GET /api/services`. */
  latest(service: ServiceName): ProposalSummary | null {
    return this.latestByService.get(service) ?? null;
  }

  // --- requests ---

  /** Starts a Proposal for a succeeded Hunt: automatically after the Hunt, or as a retry by the operator. */
  async request(huntId: string, trigger: 'auto' | 'operator'): Promise<ProposalRequestResult> {
    if (!this.cfg.enabled || this.stopping || !this.deps.huntsEnabled()) return { kind: 'disabled' };
    if (!CUID_PATTERN.test(huntId)) return { kind: 'not_found' };
    const hunt = await this.deps.hunts.get(huntId);
    if (hunt === null) return { kind: 'not_found' };
    if (hunt.status !== 'succeeded' || hunt.diagnosis === null) return { kind: 'not_succeeded' };
    const last = await this.deps.proposals.latestOfHunt(huntId);
    // One Proposal per succeeded Hunt by itself; the operator may retry only one that failed (a pull request that was
    // reviewed and closed, or merged, is the answer of a person and is not asked again).
    if (last !== null && (trigger === 'auto' || last.status === 'rejected' || last.status === 'deployed')) return { kind: 'conflict' };
    const rec = await this.deps.proposals.create(huntId, this.now());
    if (rec === null) return { kind: 'conflict' };
    await this.refresh(rec.id);
    this.chain = this.chain.then(() => this.draft(rec, hunt)).catch(() => undefined);
    return { kind: 'started', proposalId: rec.id, attempt: rec.attempt };
  }

  // --- events and records ---

  private publish<K extends keyof ProposalEventPayloads>(name: K, payload: ProposalEventPayloads[K]): void {
    try {
      this.deps.bus.publish(name, payload as never);
    } catch (err) {
      this.deps.logger.log('error', 'proposal event refused', { event: name, code: errorCodeOf(err) });
    }
  }

  private async refresh(id: string): Promise<ProposalRecord | null> {
    const rec = await this.deps.proposals.byId(id).catch(() => null);
    if (rec !== null) {
      this.latestByService.set(rec.service, toProposalSummary(rec));
      this.deps.logger.log('info', 'proposal', {
        proposalId: rec.id,
        huntId: rec.huntId,
        service: rec.service,
        status: rec.status,
        kind: rec.kind,
        failReason: rec.failReason,
        aiFailReason: rec.aiFailReason,
        credits: rec.credits,
      });
    }
    return rec;
  }

  private base(rec: ProposalRecord): { proposalId: string; huntId: string; service: ServiceName } {
    return { proposalId: rec.id, huntId: rec.huntId, service: rec.service };
  }

  /** Ends a Proposal that is `drafting` as `failed` or `checks_failed`, and says so. */
  private async endDrafting(rec: ProposalRecord, status: 'failed' | 'checks_failed', failReason: ProposalFailReason, extra: Parameters<ProposalStore['move']>[3] = {}): Promise<void> {
    const at = this.now();
    if (await this.deps.proposals.move(rec.id, 'drafting', status, { ...extra, failReason, finishedAt: at })) {
      this.publish('proposal.failed', { ...this.base(rec), status, failReason, at: iso(at) });
    }
    await this.refresh(rec.id);
  }

  // --- drafting ---

  private async aiDenied(): Promise<Extract<AiFailReason, 'budget' | 'daily_limit'> | null> {
    const now = this.now();
    return aiDeniedReason({
      spent: await this.deps.hunts.creditsToday(now),
      starts: (await this.deps.hunts.startedToday(now)) + (await this.deps.proposals.fixerStartsToday(now)),
      creditCap: this.cfg.creditCap,
      dailyCreditCap: this.deps.huntConfig.dailyCreditCap,
      dailyMax: this.deps.huntConfig.dailyMax,
    });
  }

  private async draft(rec: ProposalRecord, hunt: HuntDetail): Promise<void> {
    const diagnosis = hunt.diagnosis;
    if (diagnosis === null || this.stopping) return;
    this.current = { id: rec.id, handle: null };
    this.publish('proposal.started', { ...this.base(rec), attempt: rec.attempt, at: iso(this.now()) });
    try {
      const service = diagnosis.culpritService;
      const baseSha = await this.findBase(service);
      await this.deps.git.ensureMirror(this.deps.workdir.mirrorPath);
      const mirror = this.deps.workdir.mirrorPath;
      if (!(await this.deps.git.hasCommit(mirror, baseSha)) || !(await this.deps.git.descendsFromBase(mirror, baseSha))) throw new ProposalError('base_unknown');
      const culpritFiles = (await this.deps.git.hasCommit(mirror, diagnosis.culpritSha)) ? await this.deps.git.changedFiles(mirror, diagnosis.culpritSha).catch(() => []) : [];

      let aiFail: AiFailReason | null = await this.aiDenied();
      let candidate: Candidate | null = null;
      if (aiFail === null) {
        const tried = await this.tryAiPatch(rec, hunt, service, baseSha, culpritFiles);
        candidate = tried.candidate;
        aiFail = tried.aiFail;
      }
      if (candidate === null) {
        const reverted = await this.tryRevert(rec, hunt, service, baseSha, aiFail);
        if (reverted.kind === 'ended') return;
        candidate = reverted.candidate;
      }
      await this.publishCandidate(rec, hunt, candidate, aiFail);
    } catch (err) {
      await this.endDrafting(rec, 'failed', failReasonOf(err));
      this.deps.logger.log('warn', 'proposal failed', { proposalId: rec.id, code: errorCodeOf(err) });
    } finally {
      this.current = null;
      await this.cleanup(rec.id);
    }
  }

  /** The commit D the lab runs for the service: the latest Deploy Record of it. */
  private async findBase(service: ServiceName): Promise<string> {
    const answer = await this.deps.lab.deploys(iso(new Date(this.now().getTime() - DEPLOY_LOOKBACK_MS)));
    if (answer.kind !== 'ok') throw new ProposalError('lab_unavailable');
    const mine = answer.value.filter((d) => d.service === service && FULL_SHA_PATTERN.test(d.sha)).sort((a, b) => a.time.localeCompare(b.time));
    const latest = mine.at(-1);
    if (latest === undefined) throw new ProposalError('base_unknown');
    return latest.sha;
  }

  private commitMessage(rec: ProposalRecord, hunt: HuntDetail, kind: ProposalKind, service: ServiceName, culpritSha: string): string {
    const line = kind === 'revert' ? `Revert ${culpritSha.slice(0, 7)} in ${service}` : oneLine(hunt.diagnosis?.summary ?? '', 60) || `fix for ${service}`;
    return `Exorcist: ${line}\n\nHunt: ${rec.huntId}\nPatch kind: ${kind}`;
  }

  private async tryAiPatch(
    rec: ProposalRecord,
    hunt: HuntDetail,
    service: ServiceName,
    baseSha: string,
    culpritFiles: readonly string[],
  ): Promise<{ candidate: Candidate | null; aiFail: AiFailReason | null }> {
    const d = this.deps;
    const diagnosis = hunt.diagnosis as NonNullable<HuntDetail['diagnosis']>;
    const mirror = d.workdir.mirrorPath;
    try {
      const tar = await d.git.archive(mirror, baseSha, exportPathsOf(service));
      const folders = await d.workdir.create(rec.id, service, tar);
      const files = await d.workdir.fileList(folders.work);
      const diff = (await d.git.hasCommit(mirror, diagnosis.culpritSha)) ? await d.git.showDiff(mirror, diagnosis.culpritSha, `services/${service}`, MAX_DIFF_BYTES).catch(() => '') : '';
      const prompt = fixerPrompt({ service, deployId: diagnosis.culpritDeploy, sha: diagnosis.culpritSha, summary: diagnosis.summary, fixHint: hunt.fixHint ?? '', files, diff });
      await d.proposals.patch(rec.id, 'drafting', { agentStarted: true });
      const handle = startFixer({
        proposalId: rec.id,
        folder: folders.work,
        prompt,
        cfg: { model: this.cfg.model, creditCap: this.cfg.creditCap, timeoutMs: this.cfg.timeoutMs, maxToolCalls: this.cfg.maxToolCalls },
        kiroCliPath: d.huntConfig.kiroCliPath,
        parentEnv: d.parentEnv ?? process.env,
        pids: { write: (id, pid) => writeFile(d.workdir.pidPath(id), `${JSON.stringify({ pid, pgid: pid })}\n`, { mode: 0o600 }), remove: (id) => rm(d.workdir.pidPath(id), { force: true }) },
        spawn: d.spawn,
      });
      if (this.current !== null) this.current.handle = handle;
      const result = await handle.result;
      await d.proposals.patch(rec.id, 'drafting', { credits: result.credits, creditsEstimated: result.creditsEstimated });
      if (!result.finished) return { candidate: null, aiFail: result.aiFailReason ?? 'agent_failed' };
      if (!(await d.workdir.agentIntact(folders.work))) return { candidate: null, aiFail: 'agent_failed' };
      const patch = await readPatch(folders.exportDir, folders.work);
      return await this.judgeAiPatch(rec, hunt, service, baseSha, patch, culpritFiles);
    } catch (err) {
      if (err instanceof ProposalError && err.reason === 'export_unsafe') throw err;
      d.logger.log('warn', 'fixer step failed', { proposalId: rec.id, code: errorCodeOf(err) });
      return { candidate: null, aiFail: 'agent_failed' };
    } finally {
      await d.workdir.remove(rec.id).catch(() => undefined);
    }
  }

  private async judgeAiPatch(rec: ProposalRecord, hunt: HuntDetail, service: ServiceName, baseSha: string, patch: Patch, culpritFiles: readonly string[]): Promise<{ candidate: Candidate | null; aiFail: AiFailReason | null }> {
    const d = this.deps;
    const diagnosis = hunt.diagnosis as NonNullable<HuntDetail['diagnosis']>;
    const dir = d.workdir.candidatePath(rec.id, 'patch');
    await rm(dir, { recursive: true, force: true });
    await d.git.cloneAt(d.workdir.mirrorPath, dir, baseSha);
    const written = [...patch.changed, ...patch.added];
    let size = { files: 0, lines: 0 };
    let testsRan = false;
    let testedTree: string | null = null;
    const ctx: JudgeContext = { service, requireTests: this.cfg.requireTests, culpritFiles };
    const judgement = await judgePatch(patch, ctx, {
      size: async () => {
        for (const f of written) {
          await mkdir(dirname(join(dir, f.path)), { recursive: true });
          await writeFile(join(dir, f.path), f.content);
        }
        const counted = await d.git.stageAndCount(dir);
        size = { files: counted.files, lines: counted.lines };
        testedTree = counted.tree;
        return { ...size, binary: counted.binary };
      },
      syntax: async () => {
        for (const f of written) if (/\.(js|mjs|cjs)$/.test(f.path) && !(await checkSyntax(dir, f.path))) return false;
        return true;
      },
      tests: async () => {
        const result = await runChecks({ clone: dir, testFiles: await findTestFiles(dir, service), timeoutMs: this.cfg.testTimeoutMs });
        testsRan = result.ran > 0;
        return result;
      },
    });
    await rm(join(dir, CHECK_TMP), { recursive: true, force: true });
    if (!judgement.accepted) return { candidate: null, aiFail: judgement.aiFailReason };
    // Tested equals pushed: the clone still holds the tree the checks ran on, and the fix commit holds exactly it.
    if (testedTree === null || (await d.git.stagedTree(dir)) !== testedTree) return this.treeMoved(rec, 'ai_patch');
    const fixSha = await d.git.commit(dir, this.commitMessage(rec, hunt, 'ai_patch', service, diagnosis.culpritSha));
    if ((await d.git.treeOf(dir, fixSha)) !== testedTree) return this.treeMoved(rec, 'ai_patch');
    return { candidate: { kind: 'ai_patch', dir, baseSha, fixSha, checks: judgement.checks, patchFiles: size.files, patchLines: size.lines, testsRan }, aiFail: null };
  }

  /**
   * The tree that would be pushed is not the tree the checks ran on (a file changed during the run). The candidate is
   * not used: the AI patch counts as out of scope (and the revert is tried), a revert ends `checks_failed`.
   */
  private treeMoved(rec: ProposalRecord, kind: ProposalKind): { candidate: null; aiFail: AiFailReason } {
    this.deps.logger.log('warn', 'tested tree differs from the commit', { proposalId: rec.id, kind });
    return { candidate: null, aiFail: 'scope' };
  }

  private async tryRevert(
    rec: ProposalRecord,
    hunt: HuntDetail,
    service: ServiceName,
    baseSha: string,
    aiFail: AiFailReason | null,
  ): Promise<{ kind: 'ok'; candidate: Candidate } | { kind: 'ended' }> {
    const d = this.deps;
    const diagnosis = hunt.diagnosis as NonNullable<HuntDetail['diagnosis']>;
    const dir = d.workdir.candidatePath(rec.id, 'revert');
    await rm(dir, { recursive: true, force: true });
    await d.git.cloneAt(d.workdir.mirrorPath, dir, baseSha);
    const attempt = await attemptRevert(d.git, { mirror: d.workdir.mirrorPath, clone: dir, base: baseSha, culprit: diagnosis.culpritSha, message: this.commitMessage(rec, hunt, 'revert', service, diagnosis.culpritSha) });
    if (!attempt.ok) {
      await this.endDrafting(rec, 'checks_failed', attempt.reason, { aiFailReason: aiFail, kind: null });
      return { kind: 'ended' };
    }
    let testsRan = false;
    const testedTree = await d.git.treeOf(dir, attempt.head);
    const judgement = await judgeRevert(
      { service, files: attempt.files, requireTests: this.cfg.requireTests },
      {
        problems: () => revertFileProblems(dir, attempt.files),
        tests: async () => {
          const result = await runChecks({ clone: dir, testFiles: await findTestFiles(dir, service), timeoutMs: this.cfg.testTimeoutMs });
          testsRan = result.ran > 0;
          return result;
        },
      },
    );
    await rm(join(dir, CHECK_TMP), { recursive: true, force: true });
    if (!judgement.accepted) {
      this.publish('proposal.checks', { ...this.base(rec), kind: 'revert', checks: judgement.checks, aiFailReason: aiFail, at: iso(this.now()) });
      await this.endDrafting(rec, 'checks_failed', 'checks_failed', { checks: judgement.checks, aiFailReason: aiFail, kind: null });
      return { kind: 'ended' };
    }
    // Tested equals pushed: the working tree after the run is still the revert commit's tree.
    if ((await d.git.stagedTree(dir)) !== testedTree) {
      this.treeMoved(rec, 'revert');
      const checks = [...judgement.checks.filter((c) => c.name !== 'scope'), { name: 'scope' as const, ok: false }];
      this.publish('proposal.checks', { ...this.base(rec), kind: 'revert', checks, aiFailReason: aiFail, at: iso(this.now()) });
      await this.endDrafting(rec, 'checks_failed', 'checks_failed', { checks, aiFailReason: aiFail, kind: null });
      return { kind: 'ended' };
    }
    return { kind: 'ok', candidate: { kind: 'revert', dir, baseSha, fixSha: attempt.head, checks: judgement.checks, patchFiles: attempt.files.length, patchLines: null, testsRan } };
  }

  /** Pushes the two branches, opens the pull request and moves the Proposal to `open`. */
  private async publishCandidate(rec: ProposalRecord, hunt: HuntDetail, c: Candidate, aiFail: AiFailReason | null): Promise<void> {
    const d = this.deps;
    const diagnosis = hunt.diagnosis as NonNullable<HuntDetail['diagnosis']>;
    const aiFailReason = c.kind === 'revert' ? aiFail : null;
    this.publish('proposal.checks', { ...this.base(rec), kind: c.kind, checks: c.checks, aiFailReason, at: iso(this.now()) });
    const fresh = await d.proposals.byId(rec.id);
    const credits = fresh?.credits ?? 0;
    const { branch, baseBranch } = await publishBranches({ git: d.git, github: d.github }, { huntId: rec.huntId, dir: c.dir, baseSha: c.baseSha, fixSha: c.fixSha });
    const pr = await openPullRequest(
      d.github,
      {
        huntId: rec.huntId,
        repo: this.cfg.repo as string,
        webOrigin: this.cfg.webOrigin as string,
        service: diagnosis.culpritService,
        deployId: diagnosis.culpritDeploy,
        sha: diagnosis.culpritSha,
        kind: c.kind,
        summary: diagnosis.summary,
        evidence: hunt.evidence.filter((e) => e.cited).map((e) => ({ kind: e.kind, ref: e.ref, detail: e.detail })),
        checks: c.checks,
        testsRan: c.testsRan,
        credits,
        creditsEstimated: fresh?.creditsEstimated ?? false,
      },
      { head: branch, base: baseBranch },
    );
    const at = this.now();
    const moved = await d.proposals.move(rec.id, 'drafting', 'open', {
      kind: c.kind,
      prNumber: pr.number,
      prUrl: pr.htmlUrl,
      branch,
      baseBranch,
      baseSha: c.baseSha,
      headSha: c.fixSha,
      checks: c.checks,
      patchFiles: c.patchFiles,
      patchLines: c.patchLines,
      aiFailReason,
      openedAt: at,
    });
    if (moved) this.publish('proposal.opened', { ...this.base(rec), kind: c.kind, prNumber: pr.number, prUrl: pr.htmlUrl, at: iso(at) });
    await this.refresh(rec.id);
  }

  private async cleanup(id: string): Promise<void> {
    await this.deps.workdir.remove(id).catch(() => undefined);
    for (const name of ['patch', 'revert']) await rm(this.deps.workdir.candidatePath(id, name), { recursive: true, force: true }).catch(() => undefined);
  }

  // --- watching ---

  /** One pass of the watcher over every `open` Proposal. It also continues a `merged` one that has no deploy going. */
  async tick(): Promise<void> {
    if (this.stopping) return;
    const gh = this.deps.github;
    if ((gh.rateLimitedUntil ?? 0) > Date.now()) return;
    for (const rec of await this.deps.proposals.listByStatus(['open'])) {
      if (this.busy.has(rec.id)) continue;
      this.busy.add(rec.id);
      try {
        await this.watchOne(rec);
      } catch (err) {
        // A failed poll is not a failed Proposal: try again at the next tick.
        this.deps.logger.log('warn', 'proposal poll failed', { proposalId: rec.id, code: errorCodeOf(err) });
      } finally {
        this.busy.delete(rec.id);
      }
    }
    // A merged Proposal whose deploy is not confirmed yet is looked at again, until `FIX_DEPLOY_CONFIRM_MS`.
    for (const rec of await this.deps.proposals.listByStatus(['merged'])) await this.continueMerged(rec);
  }

  private async watchOne(rec: ProposalRecord): Promise<void> {
    if (rec.prNumber === null || rec.headSha === null) return;
    const answer = await this.deps.github.getPull(rec.prNumber, rec.etag);
    if (answer.kind === 'not_modified') return;
    const pull = answer.pull;
    // The new ETag is stored together with what it answered, never before: if that write fails, the next poll sends
    // the old ETag, gets the full answer again (not a 304) and still sees the change.
    const etag = answer.etag !== null && answer.etag !== rec.etag ? { etag: answer.etag } : {};
    const at = this.now();
    if (pull.state === 'closed' && !pull.merged) {
      if (await this.deps.proposals.move(rec.id, 'open', 'rejected', { ...etag, finishedAt: at })) this.publish('proposal.rejected', { ...this.base(rec), at: iso(at) });
      await this.refresh(rec.id);
      return;
    }
    if (!pull.merged) {
      // Still open: nothing changes but the ETag.
      if ('etag' in etag) await this.deps.proposals.patch(rec.id, 'open', etag);
      return;
    }
    // What was merged must be what was pushed: the same head, the same two branches.
    if (pull.headSha !== rec.headSha || pull.headRef !== rec.branch || pull.baseRef !== rec.baseBranch || pull.mergeCommitSha === null) {
      await this.endOpen(rec, 'open', 'head_changed', { ...etag, mergeSha: pull.mergeCommitSha, mergedBy: pull.mergedBy });
      return;
    }
    if (!(await this.deps.proposals.move(rec.id, 'open', 'merged', { ...etag, mergeSha: pull.mergeCommitSha, mergedBy: pull.mergedBy, mergedAt: at }))) return;
    this.publish('proposal.merged', { ...this.base(rec), mergedBy: pull.mergedBy, at: iso(at) });
    const merged = await this.refresh(rec.id);
    if (merged !== null) await this.deploy(merged);
  }

  private async endOpen(rec: ProposalRecord, from: 'open' | 'merged', failReason: ProposalFailReason, extra: Parameters<ProposalStore['move']>[3] = {}): Promise<void> {
    const at = this.now();
    if (await this.deps.proposals.move(rec.id, from, 'failed', { ...extra, failReason, finishedAt: at })) {
      this.publish('proposal.failed', { ...this.base(rec), status: 'failed', failReason, at: iso(at) });
    }
    await this.refresh(rec.id);
  }

  private async continueMerged(rec: ProposalRecord): Promise<void> {
    if (this.busy.has(rec.id)) return;
    this.busy.add(rec.id);
    try {
      await this.deploy(rec);
    } finally {
      this.busy.delete(rec.id);
    }
  }

  // --- deploying ---

  /**
   * The fix is merged: check it is what was pushed (the ref, the files, the content), then make sure the lab runs it.
   * A Deploy Record of the merge commit by `exorcist` that already exists (an API that stopped after the deploy call)
   * is not deployed again. A deploy that is asked for but not listed yet keeps the Proposal `merged`: the next ticks
   * look again, and only after `FIX_DEPLOY_CONFIRM_MS` from the merge does it end `failed` / `deploy_unconfirmed`.
   */
  private async deploy(rec: ProposalRecord): Promise<void> {
    const d = this.deps;
    try {
      if (rec.mergeSha === null || rec.baseSha === null || !FULL_SHA_PATTERN.test(rec.mergeSha)) throw new ProposalError('internal');
      const hunt = await d.hunts.get(rec.huntId);
      const service = hunt?.diagnosis?.culpritService;
      if (service === undefined) throw new ProposalError('internal');
      const mirror = d.workdir.mirrorPath;
      const head = await d.git.fetchIncidentBranch(mirror, rec.huntId);
      if (head !== rec.mergeSha) throw new ProposalError('ref_moved');
      await this.checkMergeScope(rec, service, mirror);
      await this.checkMergedContent(rec, mirror);
      if (await this.recordSeen(rec, service)) return await this.markDeployed(rec);
      if (!this.deployAsked.has(rec.id)) {
        await this.askDeploy(rec, service);
        this.deployAsked.add(rec.id);
      }
      if (await this.waitRecord(rec, service)) return await this.markDeployed(rec);
      const since = (rec.mergedAt ?? this.now()).getTime();
      if (this.now().getTime() - since >= this.cfg.deployConfirmMs) throw new ProposalError('deploy_unconfirmed');
      d.logger.log('info', 'proposal deploy not confirmed yet', { proposalId: rec.id });
    } catch (err) {
      this.deployAsked.delete(rec.id);
      await this.endOpen(rec, 'merged', failReasonOf(err));
      d.logger.log('warn', 'proposal deploy failed', { proposalId: rec.id, code: errorCodeOf(err) });
    }
  }

  /** `POST /chaos/deploy-fix` with bounded retries: a 4xx is final (`deploy_rejected`), no answer is `deploy_unavailable`. */
  private async askDeploy(rec: ProposalRecord, service: ServiceName): Promise<void> {
    const d = this.deps;
    const body = { service, huntId: rec.huntId, sha: rec.mergeSha as string };
    const retries = d.timings?.deployRetries ?? 3;
    for (let attempt = 1; attempt <= retries; attempt++) {
      const ans = await d.lab.deployFix(body);
      if (ans.kind === 'rejected') throw new ProposalError('deploy_rejected');
      if (ans.kind === 'ok') return;
      if (attempt < retries) await this.sleep((d.timings?.retryBackoffMs ?? 1000) * attempt);
    }
    throw new ProposalError('deploy_unavailable');
  }

  /**
   * What GitHub merged holds exactly what was pushed. The pushed head (fetched from `exorcist/<huntId>`, or already in
   * the copy) must be there; a merge commit has it as its second parent, a squash or a rebase descends from the base;
   * and in every case the tree of the merge commit is the tree of the pushed head. An edit made on GitHub while
   * merging (or a rebase that changed the content) is `merge_content`.
   */
  private async checkMergedContent(rec: ProposalRecord, mirror: string): Promise<void> {
    const g = this.deps.git;
    const head = rec.headSha;
    const merge = rec.mergeSha as string;
    if (head === null || !FULL_SHA_PATTERN.test(head)) throw new ProposalError('merge_content');
    // The branch may already be gone (deleted after the merge); the head can still be in the copy through the merge.
    await g.fetchFixBranch(mirror, rec.huntId).catch(() => null);
    if (!(await g.hasCommit(mirror, head))) throw new ProposalError('merge_content');
    const parents = await g.parents(mirror, merge);
    if (parents.length === 2) {
      if (parents[1] !== head) throw new ProposalError('merge_content');
    } else if (parents.length !== 1 || !(await g.isAncestor(mirror, rec.baseSha as string, merge))) {
      throw new ProposalError('merge_content');
    }
    if ((await g.treeOf(mirror, merge)) !== (await g.treeOf(mirror, head))) throw new ProposalError('merge_content');
  }

  /** The Deploy Record of the merge commit, by `exorcist`, for this service. */
  private async recordSeen(rec: ProposalRecord, service: ServiceName): Promise<boolean> {
    const answer = await this.deps.lab.deploys(iso(new Date(this.now().getTime() - DEPLOY_LOOKBACK_MS)));
    return answer.kind === 'ok' && answer.value.some((x) => x.service === service && x.sha === rec.mergeSha && x.actor === 'exorcist');
  }

  /** Looks for the Deploy Record for a short while within this pass (`timings.confirmMs`); false when it is not there yet. */
  private async waitRecord(rec: ProposalRecord, service: ServiceName): Promise<boolean> {
    const limit = this.deps.timings?.confirmMs ?? 10_000;
    const every = this.deps.timings?.confirmEveryMs ?? 2000;
    const started = Date.now();
    for (;;) {
      if (await this.recordSeen(rec, service)) return true;
      if (Date.now() - started >= limit) return false;
      await this.sleep(every);
    }
  }

  private async markDeployed(rec: ProposalRecord): Promise<void> {
    this.deployAsked.delete(rec.id);
    const at = this.now();
    if (await this.deps.proposals.move(rec.id, 'merged', 'deployed', { deployedAt: at, finishedAt: at })) this.publish('proposal.deployed', { ...this.base(rec), at: iso(at) });
    await this.refresh(rec.id);
  }

  private async checkMergeScope(rec: ProposalRecord, service: ServiceName, mirror: string): Promise<void> {
    const d = this.deps;
    const files = await d.git.diffNames(mirror, rec.baseSha as string, rec.mergeSha as string);
    if (files.length === 0 || !files.every((f) => f.startsWith(`services/${service}/`))) throw new ProposalError('merge_scope');
    if (rec.kind === 'ai_patch') {
      const count = await d.git.numstat(mirror, rec.baseSha as string, rec.mergeSha as string);
      // No more than was pushed, and never over the limits of an AI patch.
      if (count.binary || count.files > Math.min(5, rec.patchFiles ?? 5) || count.lines > 60) throw new ProposalError('merge_scope');
    }
  }

  /** The branch names a Proposal uses, for tests and the cleanup job. */
  static branchesOf(huntId: string): { incident: string; fix: string } {
    return { incident: incidentBranch(huntId), fix: fixBranch(huntId) };
  }

  /** The hunt the API has just finished watching a request for: used by the operator route to decide 409. */
  async hasActive(huntId: string): Promise<boolean> {
    const rec = await this.deps.proposals.latestOfHunt(huntId);
    return rec !== null && (rec.status === 'drafting' || rec.status === 'open' || rec.status === 'merged');
  }

  /** Test helper: wait for the drafts that are queued. */
  async idle(): Promise<void> {
    await this.chain;
  }
}

export type { HuntStopReason };
