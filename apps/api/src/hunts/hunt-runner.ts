import {
  EVIDENCE_KINDS,
  HUNT_LIMITS,
  type DiagnosisCheck,
  type HuntEndReason,
  type HuntFinalStatus,
  type HuntSummary,
  type HuntTrigger,
  type ServiceName,
} from '@haunted-ops/shared';
import { clean } from '@haunted-ops/exorcist-mcp/untrusted';
import { downstreamOf, mostDownstream } from '@haunted-ops/shared';
import type { EventBus } from '../events/event-bus.js';
import type { JsonLogger } from '../security/logger.js';
import { validateDiagnosis } from './diagnosis-validator.js';
import { CreditMeter, ToolCounter, acceptedOf, checkToolCall, describeForeign, fitsDailyBudget, isSameCall, wrappedCall, type AcceptedCall, type GuardStop } from './guards.js';
import { parseToolInput } from '@haunted-ops/exorcist-mcp/schemas';
import type { HuntConfig } from './hunt-config.js';
import { buildHuntArgv, buildHuntEnv, defaultMcpBinDir, type PromptFacts } from './hunt-env.js';
import { DEFAULT_MAX_OUTPUT_BYTES, HuntProcess, type HuntExit, type HuntProcessOptions, type HuntStopReason } from './hunt-process.js';
import type { HuntFinish, HuntStore, IncidentFacts, ValidDiagnosisRecord } from './hunt-store.js';
import type { LabLookup } from './lab-client.js';
import { LedgerTail, type HandleLine } from './ledger-tail.js';
import { StreamParser, type HuntStreamEvent } from './stream-parser.js';
import { StreamRecorder } from './stream-recorder.js';
import { stepSummary } from './step-summary.js';

/** More than this many lines that are not JSON stop the Hunt. */
export const MAX_MALFORMED_LINES = 20;

/** What the runner needs from a child process. A fake implements it in tests. */
export interface HuntProcessLike {
  /** The process id (and process group id) once started; a fake has none. */
  readonly pid?: number | undefined;
  start(): void;
  stop(reason: HuntStopReason): void;
  readonly done: Promise<HuntExit>;
}

/** What the runner needs from the working directory. */
export interface HuntWorkdirLike {
  readonly path: string;
  prepare(): Promise<void>;
  createLedger(huntId: string): Promise<string>;
  readLedger(huntId: string): Promise<string>;
  removeLedger(huntId: string): Promise<void>;
  /** Where the reduced stream of a Hunt is kept. */
  streamPath(huntId: string): string;
  /** Deletes the oldest stream files, keeping the newest 20. */
  pruneStreams(): Promise<void>;
  /** Notes the process of a running Hunt, so a crash of this API cannot leave it behind. */
  writePid(huntId: string, pid: number): Promise<void>;
  removePid(huntId: string): Promise<void>;
  /** Kills the `kiro-cli` process groups that an earlier API process left behind. Returns how many it killed. */
  reapOrphans(): Promise<number>;
}

export interface HuntRunnerDeps {
  config: HuntConfig;
  store: HuntStore;
  bus: Pick<EventBus, 'publish' | 'subscribe'>;
  workdir: HuntWorkdirLike;
  lab: LabLookup;
  logger: Pick<JsonLogger, 'log'>;
  prometheus: { url: string; allowRemote: boolean };
  spawn?: (options: HuntProcessOptions) => HuntProcessLike;
  now?: () => Date;
  mcpBinDir?: string;
  /** Only HOME and LANG are read from it. */
  parentEnv?: Readonly<Record<string, string | undefined>>;
  ledgerPollMs?: number;
  /** Timers of the settle window. Tests inject their own. */
  timers?: { set: (fn: () => void, ms: number) => unknown; clear: (handle: unknown) => void };
}

export type HuntRequest =
  | { trigger: 'operator'; incidentId: string }
  | { trigger: 'operator'; service: ServiceName }
  /** `replaceUpstream`: set by the settle step; a queued automatic Hunt of a Service upstream of this one is withdrawn (`downstream`). */
  | { trigger: 'auto'; incidentId: string; replaceUpstream?: boolean };

export type RequestResult =
  /** The request was recorded as a Hunt: queued, or cancelled at once with a reason. */
  | { kind: 'recorded'; huntId: string; status: 'queued' | 'cancelled'; reason: HuntEndReason | null }
  | { kind: 'no_open_incident' }
  /** Nothing was recorded: an `auto` request for an Incident that has one, or a stopped runner. */
  | { kind: 'skipped' };

/** Reasons that mean the Hunt was withdrawn, not that it failed. */
const CANCEL_REASONS: ReadonlySet<HuntEndReason> = new Set<HuntEndReason>(['busy', 'cooldown', 'disabled', 'incident_closed', 'shutdown', 'downstream', 'diagnosed_upstream', 'daily_limit']);

/** How long the runner remembers a diagnosis, to recognise a late Incident of the Service it named. */
export const DIAGNOSED_MEMORY_MS = 10 * 60 * 1000;

/** A diagnosis that named `culpritService` for a Hunt on another Service. */
interface Diagnosed {
  huntId: string;
  from: ServiceName;
  /** When the diagnosed Hunt's Incident opened, and when its diagnosis was made (ms). */
  incidentOpenedAt: number;
  at: number;
}

/** Why a request or a queued Hunt is withdrawn, and which Hunt made it unnecessary. */
interface Link {
  diagnosedBy: ServiceName;
  huntId: string;
}

/** The final status of a Hunt that ended for `reason`. */
export function statusFor(reason: HuntEndReason, started: boolean): HuntFinalStatus {
  if (reason === 'diagnosed') return 'succeeded';
  if (CANCEL_REASONS.has(reason)) return 'cancelled';
  if (reason === 'daily_cap') return started ? 'failed' : 'cancelled';
  return 'failed';
}

interface HuntRec {
  id: string;
  facts: IncidentFacts;
  trigger: HuntTrigger;
  summary: HuntSummary;
  /** Set when a stop was asked for before the process exists. */
  pendingStop: HuntStopReason | null;
  /** Set while the process exists. */
  stopWith: ((reason: HuntStopReason) => void) | null;
  started: boolean;
}

const iso = (d: Date): string => d.toISOString();

/** A short code for a failure, never a message: a Prisma error code (`P2002`), a system code (`ECONNRESET`) or the class name. */
function errorCode(err: unknown): string {
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
  if (typeof code === 'string' && /^[A-Za-z0-9_]{1,24}$/.test(code)) return code;
  return err instanceof Error ? err.constructor.name : typeof err;
}

export class HuntRunner {
  private readonly cfg: HuntConfig;
  private readonly store: HuntStore;
  private readonly now: () => Date;
  private enabled: boolean;
  private shuttingDown = false;
  private running: HuntRec | null = null;
  private runningDone: Promise<void> = Promise.resolve();
  private queued: HuntRec | null = null;
  private lock: Promise<unknown> = Promise.resolve();
  private readonly settleTimers = new Set<unknown>();
  private unsubscribe: (() => void) | null = null;
  private readonly latestByService = new Map<ServiceName, HuntSummary>();
  private readonly lastFinished = new Map<string, number>();
  private readonly diagnosed = new Map<ServiceName, Diagnosed[]>();

  constructor(private readonly deps: HuntRunnerDeps) {
    this.cfg = deps.config;
    this.store = deps.store;
    this.now = deps.now ?? (() => new Date());
    this.enabled = deps.config.enabled;
  }

  // --- lifecycle ---

  /** Marks Hunts left over by an earlier process, prepares the working folder and listens for Incidents. */
  async start(): Promise<void> {
    // A process group an earlier API process left behind (a hard crash) is killed before its Hunt is marked as lost.
    const reaped = await this.deps.workdir.reapOrphans().catch(() => 0);
    if (reaped > 0) this.deps.logger.log('warn', 'hunt processes reaped', { count: reaped });
    const swept = await this.store.sweepStale(this.now());
    if (swept > 0) this.deps.logger.log('warn', 'hunts swept', { count: swept, reason: 'api_restart' });
    for (const [name, summary] of await this.store.latestPerService()) this.latestByService.set(name, summary);
    if (this.cfg.enabled) await this.deps.workdir.prepare();
    this.unsubscribe = this.deps.bus.subscribe((event) => {
      if (event.name !== 'incident.opened') return;
      const p = event.payload as { incidentId: string; level: number };
      if (p.level < 2) return;
      this.onIncidentOpened(p.incidentId);
    });
  }

  /**
   * An Incident opened at level 2 or higher. The lab is one call chain, so a fault makes every caller
   * upstream fail too and several Incidents open within seconds. The runner therefore waits for the
   * settle window, then hunts only the most downstream Service among the open Incidents; the others
   * are linked to that Hunt and get none of their own.
   */
  onIncidentOpened(incidentId: string): void {
    if (this.shuttingDown) return;
    const set = this.deps.timers?.set ?? ((fn: () => void, ms: number): unknown => setTimeout(fn, ms));
    const handle = set(() => {
      this.settleTimers.delete(handle);
      this.settleAuto(incidentId).catch(() => this.deps.logger.log('error', 'hunt request failed', {}));
    }, this.cfg.settleMs);
    this.settleTimers.add(handle);
  }

  private settleAuto(incidentId: string): Promise<void> {
    return this.locked(async () => {
      if (this.shuttingDown) return;
      const own = await this.store.incidentFacts(incidentId);
      if (own === null || own.closedAt !== null) return;
      const open = (await this.store.openIncidents()).filter((i) => i.level >= 2);
      const target = open.find((i) => i.service === mostDownstream(open.map((o) => o.service)));
      if (target === undefined) return;
      if (target.incidentId !== incidentId) {
        this.deps.logger.log('info', 'hunt linked', { incidentId, service: own.service, hunted: target.service, huntedIncidentId: target.incidentId });
      }
      await this.doRequest({ trigger: 'auto', incidentId: target.incidentId, replaceUpstream: true });
    });
  }

  /** Stops listening, cancels the queued Hunt and stops the running one with `shutdown`. */
  async stop(): Promise<void> {
    if (!this.shuttingDown) {
      this.shuttingDown = true;
      this.unsubscribe?.();
      this.unsubscribe = null;
      const clear = this.deps.timers?.clear ?? ((h: unknown): void => clearTimeout(h as NodeJS.Timeout));
      for (const h of this.settleTimers) clear(h);
      this.settleTimers.clear();
      await this.lock.catch(() => undefined);
      const q = this.queued;
      this.queued = null;
      if (q !== null) await this.finishRec(q, this.cancelledFinish('shutdown'));
      this.stopRunning('shutdown');
    }
    await this.runningDone;
  }

  /** Nest calls this when the app closes: a running Hunt is stopped like on a shutdown. */
  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** The latest Hunt of a Service, for `GET /api/services` and `service.updated`. */
  latest(name: ServiceName): HuntSummary | null {
    return this.latestByService.get(name) ?? null;
  }

  /**
   * The runtime Kill switch. Turning Hunts off cancels the queued Hunt and stops the running one.
   * Turning them on is possible only when the environment allows Hunts. Returns the state now in force.
   */
  setEnabled(enabled: boolean): Promise<boolean> {
    return this.locked(async () => {
      if (!enabled) {
        this.enabled = false;
        const q = this.queued;
        this.queued = null;
        if (q !== null) await this.finishRec(q, this.cancelledFinish('disabled'));
        this.stopRunning('disabled');
      } else if (this.cfg.enabled) {
        this.enabled = true;
      }
      this.deps.logger.log('warn', 'hunt kill switch', { enabled: this.enabled });
      return this.enabled;
    });
  }

  // --- requests ---

  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => undefined);
    return run;
  }

  request(input: HuntRequest): Promise<RequestResult> {
    return this.locked(() => this.doRequest(input));
  }

  private async doRequest(input: HuntRequest): Promise<RequestResult> {
    if (this.shuttingDown) return { kind: 'skipped' };
    const facts = 'incidentId' in input ? await this.store.incidentFacts(input.incidentId) : await this.store.openIncidentOf(input.service);
    if (facts === null) return input.trigger === 'auto' ? { kind: 'skipped' } : { kind: 'no_open_incident' };
    if (input.trigger === 'auto' && (await this.store.hasAutoHunt(facts.incidentId))) return { kind: 'skipped' };
    if (facts.closedAt !== null) {
      if (input.trigger === 'operator') return { kind: 'no_open_incident' };
      return this.recordCancelled(facts, input.trigger, 'incident_closed');
    }
    if (input.trigger === 'auto' && input.replaceUpstream === true) {
      // An Incident that opened after the Hunt of an upstream Service began, and no later than the settle
      // window after that Hunt named this Service as the cause, belongs to the same fault: no Hunt of its own.
      const known = this.diagnosedBefore(facts);
      if (known !== null) return this.recordCancelled(facts, 'auto', 'diagnosed_upstream', { diagnosedBy: known.from, huntId: known.huntId });
    }
    const lastRun = input.trigger === 'auto' ? await this.store.lastRunFinishedAt(facts.serviceId) : null;

    // A Service further downstream the chain is the better place to look than a queued automatic Hunt of a
    // caller upstream of it: that one is withdrawn, and the new one takes the slot instead of being `busy`.
    if (input.trigger === 'auto' && input.replaceUpstream === true && this.enabled) {
      const queued = this.queued;
      if (queued !== null && queued.trigger === 'auto' && downstreamOf(queued.facts.service).includes(facts.service)) {
        this.queued = null;
        await this.finishRec(queued, this.cancelledFinish('downstream'));
      }
    }

    const startedToday = await this.store.startedToday(this.now());

    // Requests are serialized by `locked`, so no other request sits between the slot check below and the record.
    // A Hunt may still end while `store.create` runs; that only frees the slot.
    if (!this.enabled) return this.recordCancelled(facts, input.trigger, 'disabled');
    // Hunts that started today (both triggers) plus the one waiting in the queue: at the limit, the request is withdrawn.
    if (startedToday + (this.queued === null ? 0 : 1) >= this.cfg.dailyMax) return this.recordCancelled(facts, input.trigger, 'daily_limit');
    if (this.running !== null && this.queued !== null) return this.recordCancelled(facts, input.trigger, 'busy');
    if (input.trigger === 'auto') {
      const mem = this.lastFinished.get(facts.serviceId) ?? 0;
      const last = Math.max(lastRun?.getTime() ?? 0, mem);
      if (last > 0 && this.now().getTime() - last < this.cfg.cooldownMs) return this.recordCancelled(facts, input.trigger, 'cooldown');
    }

    const created = await this.store.create({ incidentId: facts.incidentId, serviceId: facts.serviceId, trigger: input.trigger, model: this.cfg.model });
    const rec = this.newRec(created.id, facts, input.trigger, created.createdAt);
    this.queued = rec;
    this.remember(rec);
    this.publishQueued(rec);
    this.log(rec);
    queueMicrotask(() => this.drain());
    return { kind: 'recorded', huntId: rec.id, status: 'queued', reason: null };
  }

  private newRec(id: string, facts: IncidentFacts, trigger: HuntTrigger, queuedAt: Date): HuntRec {
    const summary: HuntSummary = {
      id,
      incidentId: facts.incidentId,
      service: facts.service,
      trigger,
      status: 'queued',
      reason: null,
      steps: [],
      stepCount: 0,
      evidenceCount: 0,
      diagnosis: null,
      credits: 0,
      queuedAt: iso(queuedAt),
      startedAt: null,
      finishedAt: null,
      diagnosedBy: null,
    };
    return { id, facts, trigger, summary, pendingStop: null, stopWith: null, started: false };
  }

  private async recordCancelled(facts: IncidentFacts, trigger: HuntTrigger, reason: HuntEndReason, link: Link | null = null): Promise<RequestResult> {
    const at = this.now();
    const created = await this.store.create({
      incidentId: facts.incidentId,
      serviceId: facts.serviceId,
      trigger,
      model: this.cfg.model,
      cancelled: { reason, at, diagnosedBy: link?.diagnosedBy ?? null, linkedHuntId: link?.huntId ?? null },
    });
    const rec = this.newRec(created.id, facts, trigger, created.createdAt);
    rec.summary = { ...rec.summary, status: 'cancelled', reason, finishedAt: iso(at), diagnosedBy: link?.diagnosedBy ?? null };
    this.remember(rec);
    this.publishQueued(rec);
    this.publish('hunt.finished', {
      huntId: rec.id,
      service: facts.service,
      status: 'cancelled',
      reason,
      invalidCheck: null,
      diagnosedBy: link?.diagnosedBy ?? null,
      credits: 0,
      durationMs: 0,
      toolCalls: 0,
      finishedAt: iso(at),
    });
    this.log(rec);
    return { kind: 'recorded', huntId: rec.id, status: 'cancelled', reason };
  }

  // --- the queue ---

  private drain(): void {
    if (this.running !== null || this.queued === null) return;
    const rec = this.queued;
    this.queued = null;
    this.running = rec;
    this.runningDone = this.execute(rec).finally(() => {
      this.running = null;
      this.drain();
    });
  }

  private stopRunning(reason: HuntStopReason): void {
    const r = this.running;
    if (r === null) return;
    if (r.stopWith !== null) r.stopWith(reason);
    else r.pendingStop ??= reason;
  }

  private cancelledFinish(reason: HuntEndReason, link: Link | null = null): HuntFinish {
    return {
      status: 'cancelled',
      reason,
      invalidCheck: null,
      diagnosedBy: link?.diagnosedBy ?? null,
      linkedHuntId: link?.huntId ?? null,
      credits: 0,
      toolCalls: 0,
      durationMs: null,
      finishedAt: this.now(),
      diagnosis: null,
    };
  }

  /** The diagnosis (if any) that already named `facts.service` as the cause of a fault that began upstream of it. */
  private diagnosedBefore(facts: IncidentFacts): Diagnosed | null {
    const opened = facts.openedAt.getTime();
    for (const d of this.diagnosed.get(facts.service) ?? []) {
      if (opened > d.incidentOpenedAt && opened <= d.at + this.cfg.settleMs) return d;
    }
    return null;
  }

  /**
   * A Hunt on `rec`'s Service named `culprit` (another Service) as the cause. Remember it, and withdraw a
   * queued automatic Hunt of that Service whose Incident opened after this Hunt's Incident: its cause is
   * known. A running Hunt and an operator Hunt are left alone.
   */
  private async noteDiagnosis(rec: HuntRec, culprit: ServiceName, at: Date): Promise<void> {
    if (culprit === rec.facts.service) return;
    const horizon = at.getTime() - DIAGNOSED_MEMORY_MS;
    const kept = (this.diagnosed.get(culprit) ?? []).filter((d) => d.at >= horizon);
    kept.push({ huntId: rec.id, from: rec.facts.service, incidentOpenedAt: rec.facts.openedAt.getTime(), at: at.getTime() });
    this.diagnosed.set(culprit, kept);
    const queued = this.queued;
    if (queued !== null && queued.trigger === 'auto' && queued.facts.service === culprit && queued.facts.openedAt.getTime() > rec.facts.openedAt.getTime()) {
      this.queued = null;
      await this.finishRec(queued, this.cancelledFinish('diagnosed_upstream', { diagnosedBy: rec.facts.service, huntId: rec.id }));
    }
  }

  /** Runs one Hunt from the queue to its end. It never throws. */
  private async execute(rec: HuntRec): Promise<void> {
    try {
      const pre = await this.checkBeforeStart(rec);
      if (pre.kind === 'ended') return;
      const startedAt = this.now();
      if (!(await this.store.markRunning(rec.id, startedAt))) return;
      rec.started = true;
      rec.summary = { ...rec.summary, status: 'running', startedAt: iso(startedAt) };
      this.remember(rec);
      await this.run(rec, pre.facts, pre.spentToday, startedAt);
    } catch (err) {
      this.deps.logger.log('error', 'hunt crashed', { huntId: rec.id, errorClass: err instanceof Error ? err.constructor.name : typeof err });
      await this.finishRec(rec, this.failedFinish(rec, 'cli_error', null, { credits: rec.summary.credits, toolCalls: rec.summary.stepCount }, null)).catch(() => undefined);
    }
  }

  private async checkBeforeStart(rec: HuntRec): Promise<{ kind: 'ended' } | { kind: 'ok'; facts: IncidentFacts; spentToday: number }> {
    const end = async (reason: HuntEndReason): Promise<{ kind: 'ended' }> => {
      await this.finishRec(rec, this.cancelledFinish(reason));
      return { kind: 'ended' };
    };
    if (this.shuttingDown) return end('shutdown');
    if (!this.enabled) return end('disabled');
    const facts = await this.store.incidentFacts(rec.facts.incidentId);
    if (facts === null || facts.closedAt !== null) return end('incident_closed');
    if ((await this.store.startedToday(this.now())) >= this.cfg.dailyMax) return end('daily_limit');
    const spentToday = await this.store.creditsToday(this.now());
    if (!fitsDailyBudget(spentToday, this.cfg.creditCap, this.cfg.dailyCreditCap)) return end('daily_cap');
    return { kind: 'ok', facts, spentToday };
  }

  private failedFinish(
    rec: HuntRec,
    reason: HuntEndReason,
    check: DiagnosisCheck | null,
    totals: { credits: number; toolCalls: number },
    startedAt: Date | null,
  ): HuntFinish {
    const finishedAt = this.now();
    return {
      status: statusFor(reason, rec.started),
      reason,
      invalidCheck: check,
      credits: totals.credits,
      toolCalls: totals.toolCalls,
      durationMs: startedAt === null ? null : Math.max(0, finishedAt.getTime() - startedAt.getTime()),
      finishedAt,
      diagnosis: null,
    };
  }

  private async run(rec: HuntRec, facts: IncidentFacts, spentToday: number, startedAt: Date): Promise<void> {
    const { workdir, logger } = this.deps;
    const promptFacts: PromptFacts = { incidentId: facts.incidentId, service: facts.service, level: facts.level, reasonKind: facts.reasonKind, openedAt: facts.openedAt };
    const meter = new CreditMeter(this.cfg.creditCap, this.cfg.dailyCreditCap, spentToday);
    const counter = new ToolCounter(this.cfg.maxToolCalls);
    const parser = new StreamParser();
    // The accepted calls by id: a later event with the id of one is that call only if it names the same tool.
    const accepted = new Map<string, AcceptedCall>();
    let diagnosisId: string | null = null;
    let stepIndex = 0;
    let evidenceIndex = 0;
    let streamDiagnosis: unknown;
    let stopDetail: string | null = null;
    // The reduced stream of this Hunt, kept in the working folder (the last 20) to make a fixture of a failed live run.
    let recorder: StreamRecorder | null = null;
    try {
      recorder = new StreamRecorder(workdir.streamPath(rec.id), [this.cfg.labReadToken ?? '', this.cfg.adminToken ?? '']);
    } catch {
      recorder = null;
    }
    let halted = false;
    let writes: Promise<void> = Promise.resolve();
    const enqueue = (fn: () => Promise<void>): void => {
      writes = writes.then(fn).catch(() => logger.log('error', 'hunt write failed', { huntId: rec.id }));
    };
    const totals = (): { credits: number; toolCalls: number } => ({ credits: meter.total, toolCalls: counter.count });

    let argv: string[];
    let env: Record<string, string>;
    try {
      await workdir.prepare();
      const ledgerPath = await workdir.createLedger(rec.id);
      argv = buildHuntArgv(this.cfg, promptFacts);
      env = buildHuntEnv({
        cfg: this.cfg,
        prometheusUrl: this.deps.prometheus.url,
        prometheusAllowRemote: this.deps.prometheus.allowRemote,
        huntId: rec.id,
        ledgerPath,
        mcpBinDir: this.deps.mcpBinDir ?? defaultMcpBinDir(),
        parentEnv: this.deps.parentEnv ?? process.env,
      });
    } catch (err) {
      logger.log('error', 'hunt setup failed', { huntId: rec.id, errorClass: err instanceof Error ? err.constructor.name : typeof err });
      await this.finishRec(rec, this.failedFinish(rec, 'cli_error', null, totals(), startedAt));
      return;
    }

    this.publish('hunt.started', { huntId: rec.id, service: facts.service, model: this.cfg.model, startedAt: iso(startedAt) });
    this.log(rec);

    const onEvidence = async (line: HandleLine): Promise<void> => {
      const ref = typeof line.handle === 'string' ? line.handle : '';
      if (ref.length < 1 || ref.length > HUNT_LIMITS.evidenceRef || !(EVIDENCE_KINDS as readonly string[]).includes(line.kind)) return;
      const detail = clean(line.detail, HUNT_LIMITS.evidenceDetail);
      const at = Number.isFinite(Date.parse(line.at)) ? iso(new Date(line.at)) : iso(this.now());
      const index = ++evidenceIndex;
      rec.summary = { ...rec.summary, evidenceCount: index };
      this.remember(rec);
      this.publish('hunt.evidence', { huntId: rec.id, service: facts.service, index, kind: line.kind, ref, detail, at });
      await this.store.addEvidence(rec.id, { order: index, kind: line.kind, ref, detail });
    };
    const tail = new LedgerTail({ read: () => workdir.readLedger(rec.id), onHandle: onEvidence, intervalMs: this.deps.ledgerPollMs });

    const spawn = this.deps.spawn ?? ((o: HuntProcessOptions): HuntProcessLike => new HuntProcess(o));
    const refuse = (title: string, rawInput: unknown): void => {
      stopDetail = describeForeign(title, rawInput);
      this.deps.logger.log('warn', 'hunt stopped', { huntId: rec.id, reason: 'foreign_tool', detail: stopDetail });
      halt('foreign_tool');
    };
    /** The latest complete input of the diagnosis call: a later update may carry the fuller one. */
    const takeDiagnosis = (id: string, rawInput: unknown): void => {
      if (id !== diagnosisId || rawInput === undefined || rawInput === null) return;
      const candidate = wrappedCall(rawInput)?.arguments ?? rawInput;
      if (parseToolInput('submit_diagnosis', candidate).ok) streamDiagnosis = candidate;
    };
    const handle = (ev: HuntStreamEvent): void => {
      if (halted) return;
      switch (ev.type) {
        case 'tool_call_update': {
          const known = accepted.get(ev.id);
          if (known === undefined) {
            // An update for a call that was never accepted can only be judged by what it says it is.
            if (ev.title !== null && ev.title !== undefined && ev.title !== '' && checkToolCall({ type: 'tool_call', id: ev.id, title: ev.title, rawInput: ev.rawInput }).kind === 'foreign') {
              refuse(ev.title, ev.rawInput);
            }
            return;
          }
          if (!isSameCall(known, ev.title, ev.rawInput)) return refuse(ev.title ?? '', ev.rawInput);
          takeDiagnosis(ev.id, ev.rawInput);
          return;
        }
        case 'tool_call': {
          // The id of an accepted call comes back (kiro-cli repeats a call): it is the same call only if it names the same tool.
          const known = ev.id === '' ? undefined : accepted.get(ev.id);
          if (known !== undefined) {
            if (!isSameCall(known, ev.title, ev.rawInput)) return refuse(ev.title, ev.rawInput);
            takeDiagnosis(ev.id, ev.rawInput);
            return;
          }
          const verdict = checkToolCall(ev);
          if (verdict.kind === 'foreign') return refuse(verdict.title, ev.rawInput);
          const call = acceptedOf(verdict, ev.rawInput);
          if (ev.id !== '' && call !== null) accepted.set(ev.id, call);
          const limit = counter.add();
          if (limit !== null) return halt(limit);
          if (verdict.kind === 'load') return;
          const index = ++stepIndex;
          const at = iso(this.now());
          const summary = stepSummary(verdict.tool, verdict.input);
          const view = { index, tool: verdict.tool, summary, at };
          rec.summary = { ...rec.summary, stepCount: index, steps: [...rec.summary.steps, view].slice(-HUNT_LIMITS.summarySteps) };
          this.remember(rec);
          this.publish('hunt.step', { huntId: rec.id, service: facts.service, ...view });
          enqueue(async () => {
            await this.store.addStep(rec.id, view);
            await this.store.setProgress(rec.id, totals());
          });
          if (verdict.tool === 'submit_diagnosis') {
            diagnosisId = ev.id === '' ? null : ev.id;
            if (streamDiagnosis === undefined) streamDiagnosis = verdict.input;
          }
          return;
        }
        case 'credits': {
          const stop = meter.add(ev.usage);
          rec.summary = { ...rec.summary, credits: meter.total };
          this.remember(rec);
          enqueue(() => this.store.setProgress(rec.id, totals()));
          if (stop !== null) halt(stop);
          return;
        }
        default:
          if (parser.malformed > MAX_MALFORMED_LINES) halt('stream_error');
      }
    };
    const feed = (events: HuntStreamEvent[]): void => {
      for (const ev of events) {
        handle(ev);
        if (parser.malformed > MAX_MALFORMED_LINES && !halted) halt('stream_error');
      }
    };

    const proc = spawn({
      executable: this.cfg.kiroCliPath,
      argv,
      env,
      cwd: workdir.path,
      timeoutMs: this.cfg.timeoutMs,
      maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
      onStdout: (chunk) => {
        recorder?.write(chunk);
        feed(parser.push(chunk));
      },
    });
    function halt(reason: HuntStopReason | GuardStop): void {
      if (halted) return;
      halted = true;
      proc.stop(reason);
    }
    rec.stopWith = (reason) => halt(reason);
    if (rec.pendingStop !== null) halt(rec.pendingStop);

    tail.start();
    proc.start();
    // The process group is noted so that a crash of this API cannot leave it running (see `reapOrphans`).
    if (proc.pid !== undefined) await workdir.writePid(rec.id, proc.pid).catch(() => undefined);
    const exit = await proc.done;
    await workdir.removePid(rec.id).catch(() => undefined);
    if (!halted) feed(parser.end());
    await tail.stop();
    await writes;
    await recorder?.close();
    await workdir.pruneStreams().catch(() => undefined);

    const verdict = await this.decide(rec, facts, exit, tail.lines, streamDiagnosis, stopDetail);
    const finishedAt = this.now();
    // Kiro reports Credits once, at the end of a turn. A Hunt that ended without that report may still have been
    // charged, so it counts for the per-hunt cap, and so for the daily budget, and says so.
    const estimated = meter.reports === 0 && !exit.spawnFailed;
    await this.finishRec(rec, {
      status: statusFor(verdict.reason, true),
      reason: verdict.reason,
      invalidCheck: verdict.check,
      stopDetail: verdict.detail,
      creditsEstimated: estimated,
      credits: estimated ? this.cfg.creditCap : meter.total,
      toolCalls: counter.count,
      durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
      finishedAt,
      diagnosis: verdict.diagnosis,
    });
    await workdir.removeLedger(rec.id).catch(() => undefined);
    rec.stopWith = null;
  }

  /** What a finished process means, in the order: our stop, spawn failure, exit 3, diagnosis, exit code. */
  private async decide(
    rec: HuntRec,
    facts: IncidentFacts,
    exit: HuntExit,
    ledger: Parameters<typeof validateDiagnosis>[1],
    streamDiagnosis: unknown,
    foreignDetail: string | null,
  ): Promise<{ reason: HuntEndReason; check: DiagnosisCheck | null; diagnosis: ValidDiagnosisRecord | null; detail: string | null }> {
    const plain = (reason: HuntEndReason, detail: string | null = null): { reason: HuntEndReason; check: null; diagnosis: null; detail: string | null } => ({
      reason,
      check: null,
      diagnosis: null,
      detail,
    });
    if (exit.stoppedBy === 'foreign_tool') return plain('foreign_tool', foreignDetail);
    if (exit.stoppedBy === 'credit_cap' || exit.stoppedBy === 'tool_limit') {
      // A diagnosis that was already submitted and holds up is not thrown away because a cap was reached after it.
      try {
        const late = await validateDiagnosis({ service: facts.service, openedAt: facts.openedAt }, ledger, streamDiagnosis, this.deps.lab);
        if (late.ok) return { reason: 'diagnosed', check: null, diagnosis: late.diagnosis, detail: `${exit.stoppedBy} after the diagnosis` };
      } catch {
        this.deps.logger.log('error', 'diagnosis check failed', { huntId: rec.id });
      }
      return plain(exit.stoppedBy);
    }
    if (exit.stoppedBy !== null) return plain(exit.stoppedBy);
    if (exit.spawnFailed) return plain('cli_error');
    if (exit.code === 3) return plain('mcp_startup');
    let verdict;
    try {
      verdict = await validateDiagnosis({ service: facts.service, openedAt: facts.openedAt }, ledger, streamDiagnosis, this.deps.lab);
    } catch {
      this.deps.logger.log('error', 'diagnosis check failed', { huntId: rec.id });
      return plain('cli_error');
    }
    if (verdict.ok) return { reason: 'diagnosed', check: null, diagnosis: verdict.diagnosis, detail: null };
    if (verdict.reason === 'invalid_diagnosis') return { reason: 'invalid_diagnosis', check: verdict.check, diagnosis: null, detail: null };
    return plain(exit.code === 0 ? 'no_diagnosis' : 'cli_error');
  }

  // --- ending a Hunt ---

  /** Stores the end of a Hunt, then publishes `hunt.diagnosis` (valid only) and `hunt.finished`. */
  private async finishRec(rec: HuntRec, f: HuntFinish): Promise<boolean> {
    let stored = false;
    for (let attempt = 1; attempt <= 2 && !stored; attempt++) {
      try {
        if (!(await this.store.finish(rec.id, f))) return false;
        stored = true;
      } catch (err) {
        this.deps.logger.log('error', 'hunt finish failed', { huntId: rec.id, attempt, code: errorCode(err) });
      }
    }
    if (!stored) {
      // The database could not take the end. Viewers still get the end, but a diagnosis that is not stored is not
      // shown as a success, and the Hunt leaves memory so `GET /api/services` shows what the row says; the next start
      // marks the row `api_restart`.
      const lost: HuntFinish = f.status === 'succeeded' ? { ...f, status: 'failed', reason: 'cli_error', invalidCheck: null, diagnosis: null, stopDetail: null } : f;
      this.publish('hunt.finished', {
        huntId: rec.id,
        service: rec.facts.service,
        status: lost.status,
        reason: lost.reason,
        invalidCheck: lost.invalidCheck,
        diagnosedBy: lost.diagnosedBy ?? null,
        credits: lost.credits,
        durationMs: lost.durationMs ?? 0,
        toolCalls: lost.toolCalls,
        finishedAt: iso(lost.finishedAt),
      });
      if (this.latestByService.get(rec.facts.service)?.id === rec.id) this.latestByService.delete(rec.facts.service);
      if (rec.started) this.lastFinished.set(rec.facts.serviceId, f.finishedAt.getTime());
      return false;
    }
    const d = f.diagnosis;
    rec.summary = {
      ...rec.summary,
      status: f.status,
      reason: f.reason,
      credits: f.credits,
      finishedAt: iso(f.finishedAt),
      diagnosedBy: f.diagnosedBy ?? null,
      diagnosis: d === null ? null : { culpritDeploy: d.culpritDeploy, culpritSha: d.culpritSha, culpritService: d.culpritService, summary: d.summary },
    };
    this.remember(rec);
    if (rec.started) this.lastFinished.set(rec.facts.serviceId, f.finishedAt.getTime());
    if (d !== null) {
      this.publish('hunt.diagnosis', {
        huntId: rec.id,
        service: rec.facts.service,
        culpritDeploy: d.culpritDeploy,
        culpritSha: d.culpritSha,
        culpritService: d.culpritService,
        summary: d.summary,
        fixHint: d.fixHint,
        cited: [...d.cited],
        at: iso(f.finishedAt),
      });
    }
    this.publish('hunt.finished', {
      huntId: rec.id,
      service: rec.facts.service,
      status: f.status,
      reason: f.reason,
      invalidCheck: f.invalidCheck,
      diagnosedBy: f.diagnosedBy ?? null,
      credits: f.credits,
      durationMs: f.durationMs ?? 0,
      toolCalls: f.toolCalls,
      finishedAt: iso(f.finishedAt),
    });
    this.log(rec);
    if (d !== null) await this.noteDiagnosis(rec, d.culpritService, f.finishedAt);
    return true;
  }

  // --- helpers ---

  /** Keeps `rec.summary` as the latest Hunt of its Service unless a newer one is already there. */
  private remember(rec: HuntRec): void {
    const current = this.latestByService.get(rec.facts.service);
    if (current === undefined || current.id === rec.id || current.queuedAt <= rec.summary.queuedAt) this.latestByService.set(rec.facts.service, rec.summary);
  }

  private publishQueued(rec: HuntRec): void {
    this.publish('hunt.queued', { huntId: rec.id, incidentId: rec.facts.incidentId, service: rec.facts.service, trigger: rec.trigger, queuedAt: rec.summary.queuedAt });
  }

  /** Publishing never throws into the runner: a closed bus or a bad payload is logged by name only. */
  private publish: EventBus['publish'] = (name, payload) => {
    try {
      return this.deps.bus.publish(name, payload);
    } catch (err) {
      this.deps.logger.log('error', 'hunt event not published', { event: name, errorClass: err instanceof Error ? err.constructor.name : typeof err });
      return undefined as never;
    }
  };

  /** One line per transition: ids and words only, never a payload. */
  private log(rec: HuntRec): void {
    this.deps.logger.log('info', 'hunt', {
      huntId: rec.id,
      service: rec.facts.service,
      trigger: rec.trigger,
      status: rec.summary.status,
      reason: rec.summary.reason,
    });
  }
}
