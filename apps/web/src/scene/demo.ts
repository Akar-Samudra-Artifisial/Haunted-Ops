import {
  SERVICE_NAMES,
  initialHauntState,
  stepHaunt,
  type HauntLevel,
  type HauntState,
  type HuntSummary,
  type HuntTool,
  type OpenIncident,
  type ProposalCheck,
  type ProposalSummary,
  type Sample,
  type ServiceName,
  type ServiceState,
} from '@haunted-ops/shared';
import { clamp } from './math.js';
import type { DemoScenarioName } from './params.js';

export const DEMO_DURATION_MS = 48_000;
/** In the demo an Incident closes after this many calm seconds (30 s in the real pipeline). */
export const DEMO_INCIDENT_CLOSE_S = 2;

const ROOM: Record<ServiceName, { x: number; y: number }> = {
  gate: { x: 0, y: 0 },
  orders: { x: 1, y: 0 },
  payments: { x: 0, y: 1 },
  ledger: { x: 1, y: 1 },
};
const EPOCH = Date.parse('2026-11-13T10:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

/** Linear ramp: `from` before `t0`, `to` after `t1`. */
const ramp = (t: number, t0: number, t1: number, from: number, to: number): number =>
  from + (to - from) * clamp((t - t0) / (t1 - t0), 0, 1);

/** Calm background: a little deterministic wobble so the numbers look alive. */
function calmSample(service: ServiceName, second: number): Sample {
  const i = SERVICE_NAMES.indexOf(service);
  return { errorRate: 0.002 + 0.001 * (1 + Math.sin(second * 0.7 + i)), p95Ms: 60 + 12 * (1 + Math.sin(second * 0.9 + i * 1.7)), up: 1 };
}

/** What Prometheus would say at a given second of the script. */
function scriptedSample(service: ServiceName, s: number): Sample {
  const base = calmSample(service, s);
  switch (service) {
    case 'payments': {
      // rise 5-11 to 0.35, rise 16-20 to 0.6, hold, fall 36-40
      const up1 = ramp(s, 5, 11, 0, 0.35);
      const up2 = ramp(s, 16, 20, 0, 0.25);
      const down = ramp(s, 36, 40, 1, 0);
      return { ...base, errorRate: base.errorRate! + (up1 + up2) * down };
    }
    case 'orders': {
      const slow = ramp(s, 20, 26, 0, 2330) * ramp(s, 36, 40, 1, 0);
      return { ...base, p95Ms: base.p95Ms! + slow };
    }
    case 'ledger':
      return { ...base, up: s < 30 ? 1 : s < 36 ? 0 : ramp(s, 36, 38, 0, 1) };
    default:
      return base;
  }
}

// --- the demo Hunt on payments ---

const DEMO_HUNT_ID = 'cmdemohuntpayments000001';
const DEMO_INCIDENT_ID = 'cmdemoincidentpayments01';
const DEMO_SHA = '65c0fca31d0df62c4bab40d2d854c81b1044c650';
/** Queued at 9 s, started at 10 s, one step at each of these seconds, the diagnosis at 26 s. */
const HUNT_QUEUED_S = 9;
const HUNT_STARTED_S = 10;
const HUNT_DIAGNOSIS_S = 26;
const HUNT_STEPS: ReadonlyArray<{ at: number; tool: HuntTool; summary: string }> = [
  { at: 12, tool: 'query_metrics', summary: 'metrics payments error_ratio 15m' },
  { at: 15, tool: 'search_errors', summary: 'errors payments since 09:45:00' },
  { at: 18, tool: 'tail_logs', summary: 'logs payments since 09:45:00' },
  { at: 21, tool: 'recent_deploys', summary: 'deploys since 08:00:00' },
  { at: 24, tool: 'diff_commit', summary: 'diff 65c0fca' },
];

function huntBase(epoch: number, over: Partial<HuntSummary>): HuntSummary {
  return {
    id: DEMO_HUNT_ID,
    incidentId: DEMO_INCIDENT_ID,
    service: 'payments',
    trigger: 'auto',
    status: 'queued',
    reason: null,
    steps: [],
    stepCount: 0,
    evidenceCount: 0,
    diagnosis: null,
    credits: 0,
    queuedAt: iso(epoch + HUNT_QUEUED_S * 1000),
    startedAt: null,
    finishedAt: null,
    diagnosedBy: null,
    ...over,
  };
}

/**
 * The Hunt of the timeline at a second of the script, with its times counted from `epoch`: the
 * wall-clock start of this run, so the Scene sees the walk in and the 8 s of the figure in real time.
 */
export function demoHunt(second: number, epoch: number): HuntSummary | null {
  if (second < HUNT_QUEUED_S) return null;
  if (second < HUNT_STARTED_S) return huntBase(epoch, {});
  const seen = HUNT_STEPS.filter((s) => s.at <= second);
  const steps = seen.map((s, i) => ({ index: i + 1, tool: s.tool, summary: s.summary, at: iso(epoch + s.at * 1000) }));
  const running = huntBase(epoch, {
    status: 'running',
    startedAt: iso(epoch + HUNT_STARTED_S * 1000),
    steps,
    stepCount: steps.length,
    evidenceCount: steps.length * 2,
    credits: 0.15 * steps.length,
  });
  if (second < HUNT_DIAGNOSIS_S) return running;
  return {
    ...running,
    status: 'succeeded',
    reason: 'diagnosed',
    finishedAt: iso(epoch + HUNT_DIAGNOSIS_S * 1000),
    diagnosis: { culpritDeploy: 'd-7', culpritSha: DEMO_SHA, culpritService: 'payments', summary: 'The refund lookup lost its fallback in the last deploy.' },
    evidenceCount: 11,
    credits: 0.92,
  };
}

interface Replay {
  haunt: HauntState;
  incident: { id: string; openedAt: number; peak: HauntLevel } | null;
  calm: number;
  serial: number;
}

function toState(service: ServiceName, second: number, r: Replay, sample: Sample, hunt: HuntSummary | null): ServiceState {
  const openIncident: OpenIncident | null = r.incident
    ? { id: r.incident.id, openedAt: iso(r.incident.openedAt), peakLevel: r.incident.peak }
    : null;
  return {
    name: service,
    room: ROOM[service],
    hauntLevel: r.haunt.level,
    reason: r.haunt.reason,
    metrics: { ...sample, at: iso(EPOCH + second * 1000) },
    openIncident,
    updatedAt: iso(EPOCH),
    hunt,
    proposal: null,
  };
}

/**
 * The scripted state at time `tMs`. Pure: the same time always gives the same state. It replays the
 * script one second at a time through `stepHaunt`, so levels rise after 2 polls and fall after 3
 * like the real pipeline.
 *
 * 0-5 calm; 5-11 payments errors to 0.35; 16-20 to 0.6; 20-26 orders p95 to 2.4 s; 30 ledger down;
 * 36-40 everything returns; 44-48 calm. The Hunt on payments: queued 9, started 10, a step at 12, 15,
 * 18, 21 and 24, the diagnosis at 26 (see `demoHunt`).
 */
export function demoServices(tMs: number, huntEpoch: number = EPOCH): ServiceState[] {
  const second = Math.max(0, Math.floor(tMs / 1000));
  return SERVICE_NAMES.map((service) => {
    const r: Replay = { haunt: initialHauntState(0, null), incident: null, calm: 0, serial: 0 };
    let sample = scriptedSample(service, 0);
    for (let s = 0; s <= second; s++) {
      sample = scriptedSample(service, s);
      r.haunt = stepHaunt(r.haunt, sample);
      const level = r.haunt.level;
      if (r.incident === null) {
        if (level >= 2) r.incident = { id: `demo-${service}-${++r.serial}`, openedAt: EPOCH + s * 1000, peak: level };
      } else if (level > 0) {
        r.calm = 0;
        r.incident.peak = Math.max(r.incident.peak, level) as HauntLevel;
      } else if (++r.calm >= DEMO_INCIDENT_CLOSE_S) {
        r.incident = null;
        r.calm = 0;
      }
    }
    return toState(service, second, r, sample, service === 'payments' ? demoHunt(second, huntEpoch) : null);
  });
}

/** Time inside the script: stops at the end, or wraps with `loop`. */
export function demoTime(elapsedMs: number, loop: boolean): number {
  const e = Math.max(0, elapsedMs);
  return loop ? e % DEMO_DURATION_MS : Math.min(e, DEMO_DURATION_MS - 1);
}

function fixed(service: ServiceName, over: Partial<ServiceState>): ServiceState {
  return {
    name: service,
    room: ROOM[service],
    hauntLevel: 0,
    reason: null,
    metrics: { ...calmSample(service, 0), at: iso(EPOCH) },
    openIncident: null,
    updatedAt: iso(EPOCH),
    hunt: null,
    proposal: null,
    ...over,
  };
}
const metrics = (errorRate: number, p95Ms: number, up: number): ServiceState['metrics'] => ({ errorRate, p95Ms, up, at: iso(EPOCH) });
const incident = (service: ServiceName, peak: HauntLevel): OpenIncident => ({ id: `demo-${service}`, openedAt: iso(EPOCH), peakLevel: peak });

/** The demo's pull requests point at a placeholder repository; nothing is fetched from it. */
const DEMO_PR_BASE = 'https://github.com/example/haunted-lab/pull/';
const DEMO_CHECKS: ProposalCheck[] = (['non_empty', 'scope', 'forbidden_file', 'size', 'syntax', 'tests'] as const).map((name) => ({ name, ok: true }));

function demoProposal(over: Partial<ProposalSummary>): ProposalSummary {
  const hunt = demoHunt(30, EPOCH) as HuntSummary;
  return {
    id: 'cdemoproposal0000000000001',
    huntId: hunt.id,
    attempt: 1,
    kind: null,
    status: 'drafting',
    prNumber: null,
    prUrl: null,
    mergedBy: null,
    checks: [],
    failReason: null,
    aiFailReason: null,
    updatedAt: iso(EPOCH + 32_000),
    ...over,
  };
}

const sealedPayments = (): Partial<ServiceState> => ({
  hauntLevel: 2,
  reason: { kind: 'error_rate', value: 0.25 },
  metrics: metrics(0.25, 90, 1),
  openIncident: incident('payments', 3),
  hunt: demoHunt(30, EPOCH),
});

/** A frozen state for design and screenshots. */
export function scenarioServices(name: DemoScenarioName): ServiceState[] {
  const calm = SERVICE_NAMES.map((s) => fixed(s, {}));
  const patch = (changes: Partial<Record<ServiceName, Partial<ServiceState>>>): ServiceState[] =>
    calm.map((s) => (changes[s.name] ? { ...s, ...changes[s.name] } : s));
  switch (name) {
    case 'calm':
      return calm;
    case 'payments-haunted':
      return patch({
        payments: { hauntLevel: 2, reason: { kind: 'error_rate', value: 0.25 }, metrics: metrics(0.25, 90, 1), openIncident: incident('payments', 2) },
      });
    case 'payments-possessed':
      return patch({
        payments: { hauntLevel: 3, reason: { kind: 'error_rate', value: 0.6 }, metrics: metrics(0.6, 90, 1), openIncident: incident('payments', 3) },
      });
    case 'orders-fog':
      return patch({
        orders: { hauntLevel: 2, reason: { kind: 'p95', value: 2200 }, metrics: metrics(0.004, 2200, 1), openIncident: incident('orders', 2) },
      });
    case 'ledger-dark':
      return patch({
        ledger: { hauntLevel: 4, reason: { kind: 'down', value: 0 }, metrics: { errorRate: null, p95Ms: null, up: 0, at: iso(EPOCH) }, openIncident: incident('ledger', 4) },
      });
    case 'payments-hunting':
      return patch({
        payments: {
          hauntLevel: 3,
          reason: { kind: 'error_rate', value: 0.6 },
          metrics: metrics(0.6, 90, 1),
          openIncident: incident('payments', 3),
          hunt: demoHunt(18, EPOCH),
        },
      });
    case 'payments-sealed':
      return patch({
        payments: {
          hauntLevel: 2,
          reason: { kind: 'error_rate', value: 0.25 },
          metrics: metrics(0.25, 90, 1),
          openIncident: incident('payments', 3),
          hunt: demoHunt(30, EPOCH),
        },
      });
    case 'payments-fizzled': {
      const running = demoHunt(18, EPOCH) as HuntSummary;
      return patch({
        payments: {
          hauntLevel: 3,
          reason: { kind: 'error_rate', value: 0.6 },
          metrics: metrics(0.6, 90, 1),
          openIncident: incident('payments', 3),
          hunt: { ...running, status: 'failed', reason: 'credit_cap', finishedAt: iso(EPOCH + 20_000), credits: 1.6 },
        },
      });
    }
    case 'payments-fixing':
      return patch({
        payments: { ...sealedPayments(), proposal: demoProposal({ status: 'drafting' }) },
      });
    case 'payments-fix-open':
      return patch({
        payments: {
          ...sealedPayments(),
          proposal: demoProposal({ status: 'open', kind: 'ai_patch', prNumber: 1, prUrl: `${DEMO_PR_BASE}1`, checks: DEMO_CHECKS }),
        },
      });
    case 'payments-fix-deployed':
      return patch({
        payments: {
          hauntLevel: 0,
          reason: null,
          metrics: metrics(0.002, 80, 1),
          openIncident: null,
          hunt: demoHunt(30, EPOCH),
          proposal: demoProposal({ status: 'deployed', kind: 'ai_patch', prNumber: 1, prUrl: `${DEMO_PR_BASE}1`, checks: DEMO_CHECKS, mergedBy: 'on-call-human' }),
        },
      });
    case 'all-haunted':
      return patch({
        gate: { hauntLevel: 2, reason: { kind: 'error_rate', value: 0.3 }, metrics: metrics(0.3, 150, 1), openIncident: incident('gate', 2) },
        orders: { hauntLevel: 2, reason: { kind: 'p95', value: 2800 }, metrics: metrics(0.01, 2800, 1), openIncident: incident('orders', 2) },
        payments: { hauntLevel: 3, reason: { kind: 'error_rate', value: 0.6 }, metrics: metrics(0.6, 90, 1), openIncident: incident('payments', 3) },
        ledger: { hauntLevel: 4, reason: { kind: 'down', value: 0 }, metrics: { errorRate: null, p95Ms: null, up: 0, at: iso(EPOCH) }, openIncident: incident('ledger', 4) },
      });
  }
}
