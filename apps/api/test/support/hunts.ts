/**
 * In-memory stand-ins for the Hunt runner: a store, a working folder, a lab and a child process.
 * They let the unit and property tests drive the real `HuntRunner` with no database, no
 * `kiro-cli` and no Credits.
 */
import {
  CUID_PATTERN,
  type EvidenceKindName,
  type HuntDetail,
  type HuntStepView,
  type HuntSummary,
  type HuntTool,
  type ServiceName,
} from '@haunted-ops/shared';
import { Ledger, MemorySink } from '@haunted-ops/exorcist-mcp/ledger';
import { EventBus, type BusEvent } from '../../src/events/event-bus.js';
import { HuntRunner, type HuntRunnerDeps } from '../../src/hunts/hunt-runner.js';
import { JsonLogger } from '../../src/security/logger.js';
import type { SubmitDiagnosisInput } from '@haunted-ops/exorcist-mcp/schemas';
import { parseHuntConfig, type HuntConfig } from '../../src/hunts/hunt-config.js';
import type { HuntExit, HuntProcessOptions, HuntStopReason } from '../../src/hunts/hunt-process.js';
import type { HuntProcessLike, HuntWorkdirLike } from '../../src/hunts/hunt-runner.js';
import type {
  CreatedHunt,
  HuntFinish,
  HuntStore,
  IncidentFacts,
  NewHunt,
  ValidDiagnosisRecord,
} from '../../src/hunts/hunt-store.js';
import type { LabAnswer, LabDeploy, LabLookup } from '../../src/hunts/lab-client.js';

export const GOOD_SHA = '65c0fca31d0df62c4bab40d2d854c81b1044c650';

const pad = (n: number): string => String(n).padStart(19, '0');

export interface MemHunt {
  id: string;
  incidentId: string;
  serviceId: string;
  trigger: NewHunt['trigger'];
  status: HuntSummary['status'];
  endReason: HuntFinish['reason'] | null;
  invalidCheck: string | null;
  stopDetail: string | null;
  creditsEstimated: boolean;
  model: string;
  credits: number;
  toolCalls: number;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
  durationMs: number | null;
  diagnosis: ValidDiagnosisRecord | null;
  steps: HuntStepView[];
  evidence: Array<{ order: number; kind: EvidenceKindName; ref: string; detail: string }>;
}

export class MemoryHuntStore implements HuntStore {
  readonly incidents = new Map<string, IncidentFacts>();
  readonly hunts: MemHunt[] = [];
  private n = 0;

  constructor(private readonly clock: () => Date = () => new Date()) {}

  addIncident(service: ServiceName, openedAt: Date, level: 2 | 3 | 4 = 3): IncidentFacts {
    const facts: IncidentFacts = { incidentId: `cminc${pad(++this.n)}`, serviceId: `cmsvc${service}aaaaaaaaaaaaaaa`, service, level, reasonKind: 'error_rate', openedAt, closedAt: null };
    this.incidents.set(facts.incidentId, facts);
    return facts;
  }

  closeIncident(id: string, at: Date): void {
    const f = this.incidents.get(id);
    if (f) this.incidents.set(id, { ...f, closedAt: at });
  }

  byId(id: string): MemHunt {
    const h = this.hunts.find((x) => x.id === id);
    if (!h) throw new Error('unknown hunt');
    return h;
  }

  async incidentFacts(id: string): Promise<IncidentFacts | null> {
    return this.incidents.get(id) ?? null;
  }

  async openIncidentOf(service: ServiceName): Promise<IncidentFacts | null> {
    return [...this.incidents.values()].filter((i) => i.service === service && i.closedAt === null).at(-1) ?? null;
  }

  async openIncidents(): Promise<IncidentFacts[]> {
    return [...this.incidents.values()].filter((i) => i.closedAt === null);
  }

  async hasAutoHunt(incidentId: string): Promise<boolean> {
    return this.hunts.some((h) => h.incidentId === incidentId && h.trigger === 'auto');
  }

  async create(h: NewHunt): Promise<CreatedHunt> {
    const createdAt = this.clock();
    const row: MemHunt = {
      id: `cmhunt${pad(++this.n)}`,
      incidentId: h.incidentId,
      serviceId: h.serviceId,
      trigger: h.trigger,
      status: h.cancelled ? 'cancelled' : 'queued',
      endReason: h.cancelled?.reason ?? null,
      invalidCheck: null,
      stopDetail: null,
      creditsEstimated: false,
      model: h.model,
      credits: 0,
      toolCalls: 0,
      startedAt: null,
      finishedAt: h.cancelled?.at ?? null,
      createdAt,
      durationMs: null,
      diagnosis: null,
      steps: [],
      evidence: [],
    };
    if (!CUID_PATTERN.test(row.id)) throw new Error('bad id');
    this.hunts.push(row);
    return { id: row.id, createdAt };
  }

  async markRunning(id: string, startedAt: Date): Promise<boolean> {
    const h = this.byId(id);
    if (h.status !== 'queued') return false;
    h.status = 'running';
    h.startedAt = startedAt;
    return true;
  }

  async addStep(id: string, step: HuntStepView): Promise<void> {
    const h = this.byId(id);
    if (!h.steps.some((s) => s.index === step.index)) h.steps.push(step);
  }

  async addEvidence(id: string, e: { order: number; kind: EvidenceKindName; ref: string; detail: string }): Promise<void> {
    const h = this.byId(id);
    if (!h.evidence.some((x) => x.order === e.order)) h.evidence.push(e);
  }

  async setProgress(id: string, p: { credits: number; toolCalls: number }): Promise<void> {
    const h = this.byId(id);
    if (h.status === 'running') {
      h.credits = p.credits;
      h.toolCalls = p.toolCalls;
    }
  }

  async finish(id: string, f: HuntFinish): Promise<boolean> {
    const h = this.byId(id);
    if (h.status !== 'queued' && h.status !== 'running') return false;
    h.status = f.status;
    h.endReason = f.reason;
    h.invalidCheck = f.invalidCheck;
    h.stopDetail = f.stopDetail ?? null;
    h.creditsEstimated = f.creditsEstimated ?? false;
    h.credits = f.credits;
    h.toolCalls = f.toolCalls;
    h.durationMs = f.durationMs;
    h.finishedAt = f.finishedAt;
    h.diagnosis = f.diagnosis;
    return true;
  }

  async creditsToday(now: Date): Promise<number> {
    const day = now.toISOString().slice(0, 10);
    return this.hunts.filter((h) => h.startedAt !== null && h.startedAt.toISOString().slice(0, 10) === day).reduce((s, h) => s + h.credits, 0);
  }

  async startedToday(now: Date): Promise<number> {
    const day = now.toISOString().slice(0, 10);
    return this.hunts.filter((h) => h.startedAt !== null && h.startedAt.toISOString().slice(0, 10) === day).length;
  }

  async lastRunFinishedAt(serviceId: string): Promise<Date | null> {
    const times = this.hunts.filter((h) => h.serviceId === serviceId && h.startedAt !== null && h.finishedAt !== null).map((h) => (h.finishedAt as Date).getTime());
    return times.length === 0 ? null : new Date(Math.max(...times));
  }

  async sweepStale(now: Date): Promise<number> {
    let n = 0;
    for (const h of this.hunts) {
      if (h.status === 'queued' || h.status === 'running') {
        h.status = 'failed';
        h.endReason = 'api_restart';
        h.finishedAt = now;
        n++;
      }
    }
    return n;
  }

  async get(): Promise<HuntDetail | null> {
    return null;
  }

  async latestPerService(): Promise<Map<ServiceName, HuntSummary>> {
    return new Map();
  }
}

export class MemoryWorkdir implements HuntWorkdirLike {
  readonly path = '/memory/hunts';
  readonly ledgers = new Map<string, string>();
  prepared = 0;
  pruned = 0;
  readonly pids = new Map<string, number>();
  reaped = 0;
  failPrepare = false;

  async prepare(): Promise<void> {
    if (this.failPrepare) throw new Error('refused');
    this.prepared++;
  }
  async createLedger(id: string): Promise<string> {
    this.ledgers.set(id, '');
    return `${this.path}/ledgers/${id}.jsonl`;
  }
  async readLedger(id: string): Promise<string> {
    return this.ledgers.get(id) ?? '';
  }
  async removeLedger(id: string): Promise<void> {
    this.ledgers.delete(id);
  }
  streamPath(id: string): string {
    return `${this.path}/${id}.stream.jsonl`;
  }
  async writePid(id: string, pid: number): Promise<void> {
    this.pids.set(id, pid);
  }
  async removePid(id: string): Promise<void> {
    this.pids.delete(id);
  }
  readonly calls: string[] = [];
  async reapOrphans(): Promise<number> {
    this.calls.push('reap');
    return this.reaped;
  }
  async pruneStreams(): Promise<void> {
    this.pruned++;
  }
}

export class MemoryLab implements LabLookup {
  deploysDown = false;
  commitsDown = false;
  deployList: LabDeploy[] = [];
  unreachable = new Set<string>();

  async deploys(): Promise<LabAnswer<LabDeploy[]>> {
    return this.deploysDown ? { kind: 'unavailable' } : { kind: 'ok', value: this.deployList };
  }
  async commitReachable(sha: string): Promise<LabAnswer<true>> {
    if (this.commitsDown) return { kind: 'unavailable' };
    return this.unreachable.has(sha) ? { kind: 'missing' } : { kind: 'ok', value: true };
  }
}

// --- stream lines, in the shape of kiro-cli 3.3.0 ---

export const toolCallLine = (id: string, title: string, rawInput: unknown): string =>
  `${JSON.stringify({ type: 'sessionUpdate', data: { sessionId: 's', update: { sessionUpdate: 'tool_call', toolCallId: id, title, rawInput } } })}\n`;

export const toolUpdateLine = (id: string): string =>
  `${JSON.stringify({ type: 'sessionUpdate', data: { sessionId: 's', update: { sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed' } } })}\n`;

/** An update as kiro-cli 3.3.0 sends it: `title` is null while a call runs, `rawInput` only when the update carries one. */
export const toolUpdateWith = (id: string, status: string, title: string | null, rawInput?: unknown): string => {
  const update: Record<string, unknown> = { sessionUpdate: 'tool_call_update', toolCallId: id, status, title };
  if (rawInput !== undefined) update.rawInput = rawInput;
  return `${JSON.stringify({ type: 'sessionUpdate', data: { sessionId: 's', update } })}\n`;
};

export const creditsLine = (usage: number): string =>
  `${JSON.stringify({ type: 'sessionUpdate', data: { sessionId: 's', update: { sessionUpdate: 'session_info_update', _meta: { kiro: { kind: 'session_usage', credits: [{ usage, unit: 'credit', unitPlural: 'credits' }] } } } } })}\n`;

export const finishedLine = (): string => `${JSON.stringify({ type: 'runFinished', data: { status: 'success' } })}\n`;

export const loadLine = (id: string, tool: HuntTool): string => toolCallLine(id, 'Tool Load', { id: `tool::exorcist::${tool}` });

// --- a scripted process ---

export interface Script {
  /** Ledger text written before the first chunk. */
  ledger?: string;
  chunks?: string[];
  code?: number;
  /** Wait for `release()` or `stop()` after the chunks. */
  hang?: boolean;
  spawnFailed?: boolean;
  /** The pid the process reports once started. */
  pid?: number;
}

export class FakeProcess implements HuntProcessLike {
  readonly done: Promise<HuntExit>;
  stoppedBy: HuntStopReason | null = null;
  started = false;
  private resolveDone!: (e: HuntExit) => void;
  private wake: (() => void) | null = null;
  private closed = false;
  private code: number | null;

  constructor(
    private readonly opts: HuntProcessOptions,
    private readonly script: Script,
    private readonly owner: FakeSpawner,
  ) {
    this.code = script.code ?? 0;
    this.done = new Promise((r) => {
      this.resolveDone = r;
    });
  }

  get huntId(): string {
    return this.opts.env.HUNT_ID as string;
  }

  get pid(): number | undefined {
    return this.started ? this.script.pid : undefined;
  }

  start(): void {
    if (this.started || this.closed) return;
    if (this.stoppedBy !== null || this.script.spawnFailed) {
      this.close(null, this.script.spawnFailed === true);
      return;
    }
    this.started = true;
    this.owner.live++;
    this.owner.maxLive = Math.max(this.owner.maxLive, this.owner.live);
    void this.play();
  }

  stop(reason: HuntStopReason): void {
    if (this.stoppedBy === null) this.stoppedBy = reason;
    this.wake?.();
  }

  /** Lets a hanging script end with `code`. */
  release(code = 0): void {
    this.code = code;
    this.wake?.();
  }

  private async play(): Promise<void> {
    const id = this.huntId;
    if (this.script.ledger !== undefined) this.owner.workdir.ledgers.set(id, this.script.ledger);
    for (const chunk of this.script.chunks ?? []) {
      if (this.stoppedBy !== null) break;
      this.opts.onStdout(chunk);
      await new Promise((r) => setImmediate(r));
    }
    if (this.script.hang === true && this.stoppedBy === null) await new Promise<void>((r) => (this.wake = r));
    await new Promise((r) => setImmediate(r));
    this.close(this.stoppedBy !== null ? null : this.code, false);
  }

  private close(code: number | null, spawnFailed: boolean): void {
    if (this.closed) return;
    this.closed = true;
    if (this.started) this.owner.live--;
    this.resolveDone({ code, signal: null, stoppedBy: this.stoppedBy, spawnFailed, stdoutBytes: 0, stderrBytes: 0 });
  }
}

export class FakeSpawner {
  readonly processes: FakeProcess[] = [];
  live = 0;
  maxLive = 0;

  constructor(
    readonly workdir: MemoryWorkdir,
    private readonly pick: (huntId: string, index: number) => Script,
  ) {}

  spawn = (opts: HuntProcessOptions): FakeProcess => {
    const p = new FakeProcess(opts, this.pick(opts.env.HUNT_ID as string, this.processes.length), this);
    this.processes.push(p);
    return p;
  };

  byHunt(id: string): FakeProcess | undefined {
    return this.processes.find((p) => p.huntId === id);
  }
}

/** Lets pending promise callbacks and immediates run. */
export async function settle(rounds = 120): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
}

// --- a good (or tampered) hunt, as ledger and stream ---

export interface GoodRun {
  ledger: string;
  chunks: string[];
  input: SubmitDiagnosisInput;
}

export interface GoodRunOptions {
  service?: ServiceName;
  deployId?: string;
  sha?: string;
  credits?: number;
  summary?: string;
}

/** A hunt that reads two things, then submits a diagnosis that cites the culprit deploy and commit. */
export function goodRun(o: GoodRunOptions = {}): GoodRun {
  const service = o.service ?? 'payments';
  const deployId = o.deployId ?? 'd-7';
  const sha = o.sha ?? GOOD_SHA;
  let t = Date.parse('2026-11-13T10:41:30.000Z');
  const sink = new MemorySink();
  const ledger = new Ledger(sink, () => (t += 1000));
  ledger.handle({ handle: `metric:${service}/error_ratio/15m`, kind: 'metric', tool: 'query_metrics', service, deployId: null, sha: null, detail: `${service} error_ratio 15m` });
  ledger.handle({ handle: `deploy:${deployId}`, kind: 'deploy', tool: 'recent_deploys', service, deployId, sha, detail: `${deployId} ${service}` });
  ledger.handle({ handle: `commit:${sha}`, kind: 'commit', tool: 'diff_commit', service: null, deployId: null, sha, detail: `commit ${sha.slice(0, 7)}` });
  const input: SubmitDiagnosisInput = {
    service,
    culprit_deploy: deployId,
    culprit_sha: sha.slice(0, 7),
    summary: o.summary ?? 'The retry guard was removed in the last deploy.',
    evidence: [
      { kind: 'metric', ref: `metric:${service}/error_ratio/15m`, detail: 'errors rose' },
      { kind: 'deploy', ref: `deploy:${deployId}`, detail: 'deploy before the rise' },
      { kind: 'commit', ref: `commit:${sha}`, detail: 'the guard is gone' },
    ],
    fix_hint: 'Restore the retry guard.',
  };
  ledger.diagnosis(input);
  const chunks = [
    loadLine('l1', 'query_metrics'),
    toolCallLine('c1', '@exorcist/query_metrics', { service, signal: 'error_ratio', window: '15m' }),
    toolUpdateLine('c1'),
    toolCallLine('c2', '@exorcist/recent_deploys', { since: '2026-11-13T10:20:00Z' }),
    toolUpdateLine('c2'),
    toolCallLine('c3', '@exorcist/diff_commit', { sha }),
    toolUpdateLine('c3'),
    toolCallLine('c4', '@exorcist/submit_diagnosis', input),
    toolUpdateLine('c4'),
    creditsLine(o.credits ?? 0.9),
    finishedLine(),
  ];
  return { ledger: sink.lines.join(''), chunks, input };
}

export const labFor = (o: { service?: ServiceName; deployId?: string; sha?: string; openedAt: Date }): MemoryLab => {
  const lab = new MemoryLab();
  lab.deployList = [
    { id: 'd-3', service: 'orders', sha: 'b'.repeat(40), time: new Date(o.openedAt.getTime() - 3_600_000).toISOString() },
    { id: o.deployId ?? 'd-7', service: o.service ?? 'payments', sha: o.sha ?? GOOD_SHA, time: new Date(o.openedAt.getTime() - 30_000).toISOString() },
  ];
  return lab;
};

/** Hunt settings for tests: on, with the caps of the defaults and a short cooldown. */
export function testHuntConfig(over: Partial<Record<string, string>> = {}): HuntConfig {
  return parseHuntConfig(
    {
      HUNTS_ENABLED: 'true',
      LAB_READ_TOKEN: 'lab-read-token-0123456789-abcdef',
      HUNT_ADMIN_TOKEN: 'admin-token-0123456789-abcdefgh',
      KIRO_CLI_PATH: '/bin/sh',
      HUNT_SETTLE_MS: '5',
      HUNT_COOLDOWN_MS: '1000',
      ...over,
    },
    { resolveExecutable: (p) => p },
  );
}

// --- a runner with every dependency in memory ---

export interface HarnessOptions {
  config?: HuntConfig;
  pick?: (huntId: string, index: number) => Script;
  startAt?: string;
  /** Timers of the settle window, to fire them by hand. */
  timers?: HuntRunnerDeps['timers'];
}

export function harness(o: HarnessOptions = {}) {
  const clock = { t: Date.parse(o.startAt ?? '2026-11-13T10:45:00.000Z') };
  const now = (): Date => new Date(clock.t);
  const store = new MemoryHuntStore(now);
  const workdir = new MemoryWorkdir();
  const bus = new EventBus();
  const events: BusEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const logs: string[] = [];
  const lab = new MemoryLab();
  const spawner = new FakeSpawner(workdir, o.pick ?? (() => ({ hang: true })));
  const config = o.config ?? testHuntConfig();
  const runner = new HuntRunner({
    config,
    store,
    bus,
    workdir,
    lab,
    logger: new JsonLogger((l) => logs.push(l), now),
    prometheus: { url: 'http://127.0.0.1:9090', allowRemote: false },
    spawn: spawner.spawn,
    now,
    ledgerPollMs: 5,
    timers: o.timers,
    parentEnv: { HOME: '/home/someone', LANG: 'en_US.UTF-8' },
  });
  return { clock, now, store, workdir, bus, events, logs, lab, spawner, runner, config };
}

export type Harness = ReturnType<typeof harness>;

/** Checks the sequence of hunt events of every Hunt: `queued (started (step|evidence)* diagnosis?)? finished`. */
export function huntSequenceErrors(events: readonly BusEvent[], statusOf: (huntId: string) => string | undefined): string[] {
  const errors: string[] = [];
  const perHunt = new Map<string, BusEvent[]>();
  for (const e of events) {
    if (!e.name.startsWith('hunt.')) continue;
    const id = (e.payload as { huntId: string }).huntId;
    perHunt.set(id, [...(perHunt.get(id) ?? []), e]);
  }
  for (const [id, list] of perHunt) {
    const names = list.map((e) => e.name);
    if (names[0] !== 'hunt.queued') errors.push(`${id}: first event is ${names[0]}`);
    if (names.filter((n) => n === 'hunt.finished').length !== 1 || names.at(-1) !== 'hunt.finished') errors.push(`${id}: finished is not exactly once and last`);
    if (names.filter((n) => n === 'hunt.queued').length !== 1) errors.push(`${id}: queued is not exactly once`);
    const started = names.indexOf('hunt.started');
    const middle = names.slice(1, -1);
    if (started === -1) {
      if (middle.length > 0) errors.push(`${id}: events between queued and finished without started`);
    } else {
      if (started !== 1) errors.push(`${id}: started is not second`);
      if (names.filter((n) => n === 'hunt.started').length !== 1) errors.push(`${id}: started more than once`);
      const rest = middle.slice(1);
      const diagnosisAt = rest.indexOf('hunt.diagnosis');
      if (diagnosisAt !== -1 && diagnosisAt !== rest.length - 1) errors.push(`${id}: diagnosis is not just before finished`);
      if (rest.some((n) => n !== 'hunt.step' && n !== 'hunt.evidence' && n !== 'hunt.diagnosis')) errors.push(`${id}: unexpected event`);
    }
    const steps = list.filter((e) => e.name === 'hunt.step').map((e) => (e.payload as { index: number }).index);
    if (steps.some((s, i) => s !== i + 1)) errors.push(`${id}: step indexes ${steps.join(',')}`);
    const ev = list.filter((e) => e.name === 'hunt.evidence').map((e) => (e.payload as { index: number }).index);
    if (ev.some((s, i) => s !== i + 1)) errors.push(`${id}: evidence indexes ${ev.join(',')}`);
    const hasDiagnosis = names.includes('hunt.diagnosis');
    if (hasDiagnosis !== (statusOf(id) === 'succeeded')) errors.push(`${id}: diagnosis event and stored status ${statusOf(id)} disagree`);
    const fin = list.at(-1)?.payload as { status?: string } | undefined;
    if (fin?.status !== statusOf(id)) errors.push(`${id}: finished status ${fin?.status} is not stored status ${statusOf(id)}`);
  }
  return errors;
}
