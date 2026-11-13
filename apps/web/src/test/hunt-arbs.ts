import fc from 'fast-check';
import { HUNT_TOOLS, type HuntEndReason, type HuntSummary } from '@haunted-ops/shared';
import { nameArb } from './arbs.js';

const T0 = Date.parse('2026-11-13T10:00:00.000Z');
export const at = (s: number): string => new Date(T0 + s * 1000).toISOString();

const FAILED_REASONS: readonly HuntEndReason[] = [
  'invalid_diagnosis',
  'no_diagnosis',
  'foreign_tool',
  'credit_cap',
  'daily_cap',
  'tool_limit',
  'timeout',
  'mcp_startup',
  'cli_error',
  'stream_error',
  'api_restart',
];
const CANCELLED_REASONS: readonly HuntEndReason[] = ['busy', 'cooldown', 'disabled', 'incident_closed', 'shutdown', 'daily_cap', 'downstream', 'diagnosed_upstream'];

/** A valid, consistent Hunt summary of any status, with up to 8 steps out of up to 30. */
export const huntSummaryArb: fc.Arbitrary<HuntSummary> = fc
  .record({
    service: nameArb,
    trigger: fc.constantFrom('auto' as const, 'operator' as const),
    status: fc.constantFrom('queued' as const, 'running' as const, 'succeeded' as const, 'failed' as const, 'cancelled' as const),
    stepCount: fc.integer({ min: 0, max: 30 }),
    tools: fc.array(fc.constantFrom(...HUNT_TOOLS), { minLength: 8, maxLength: 8 }),
    failed: fc.constantFrom(...FAILED_REASONS),
    cancelled: fc.constantFrom(...CANCELLED_REASONS),
    deploy: fc.integer({ min: 1, max: 999 }),
    culpritService: nameArb,
    by: nameArb,
    sha: fc.stringMatching(/^[0-9a-f]{40}$/),
    summary: fc.constantFrom('The guard was removed.', 'A refund lookup lost its fallback.', 'x'),
    evidenceCount: fc.integer({ min: 0, max: 20 }),
    credits: fc.double({ min: 0, max: 3, noNaN: true }),
    id: fc.stringMatching(/^[a-z0-9]{25}$/),
  })
  .map((r): HuntSummary => {
    const queued = r.status === 'queued';
    const stepCount = queued ? 0 : r.stepCount;
    const shown = Math.min(stepCount, 8);
    const steps = Array.from({ length: shown }, (_, k) => {
      const index = stepCount - shown + k + 1;
      return { index, tool: r.tools[k] as (typeof HUNT_TOOLS)[number], summary: `step ${index}`, at: at(10 + index) };
    });
    const ended = r.status === 'succeeded' || r.status === 'failed' || r.status === 'cancelled';
    const reason: HuntEndReason | null = r.status === 'succeeded' ? 'diagnosed' : r.status === 'failed' ? r.failed : r.status === 'cancelled' ? r.cancelled : null;
    return {
      id: r.id,
      incidentId: 'cmincidentaaaaaaaaaaaaaaa',
      service: r.service,
      trigger: r.trigger,
      status: r.status,
      reason,
      steps,
      stepCount,
      evidenceCount: queued ? 0 : r.evidenceCount,
      diagnosis: r.status === 'succeeded' ? { culpritDeploy: `d-${r.deploy}`, culpritSha: r.sha, culpritService: r.culpritService, summary: r.summary } : null,
      credits: queued ? 0 : r.credits,
      queuedAt: at(0),
      startedAt: queued ? null : at(5),
      finishedAt: ended ? at(60) : null,
      diagnosedBy: reason === 'diagnosed_upstream' ? r.by : null,
    };
  });

export function makeHunt(over: Partial<HuntSummary> = {}): HuntSummary {
  return {
    id: 'cmhuntaaaaaaaaaaaaaaaaaaa',
    incidentId: 'cmincidentaaaaaaaaaaaaaaa',
    service: 'payments',
    trigger: 'auto',
    status: 'queued',
    reason: null,
    steps: [],
    stepCount: 0,
    evidenceCount: 0,
    diagnosis: null,
    credits: 0,
    queuedAt: at(0),
    startedAt: null,
    finishedAt: null,
    diagnosedBy: null,
    ...over,
  };
}

export const SHA = '65c0fca31d0df62c4bab40d2d854c81b1044c650';

export const runningHunt = (stepCount = 3): HuntSummary =>
  makeHunt({
    status: 'running',
    startedAt: at(5),
    stepCount,
    steps: Array.from({ length: Math.min(stepCount, 8) }, (_, k) => {
      const index = stepCount - Math.min(stepCount, 8) + k + 1;
      return { index, tool: 'search_errors' as const, summary: `errors payments since 10:41:00`, at: at(10 + index) };
    }),
  });

export const sealedHunt = (): HuntSummary =>
  makeHunt({
    status: 'succeeded',
    reason: 'diagnosed',
    startedAt: at(5),
    finishedAt: at(60),
    stepCount: 6,
    diagnosis: { culpritDeploy: 'd-7', culpritSha: SHA, culpritService: 'payments', summary: 'The guard was removed.' },
  });

export const failedHunt = (reason: HuntEndReason = 'credit_cap'): HuntSummary =>
  makeHunt({ status: 'failed', reason, startedAt: at(5), finishedAt: at(60), stepCount: 2 });

export interface HuntOfOptions {
  status: HuntSummary['status'];
  /** Absolute times in ms; a Hunt that never started has no `startedAt`. */
  startedAt?: number;
  finishedAt?: number;
  stepCount?: number;
  reason?: HuntEndReason;
}

/** A consistent Hunt summary with times given in absolute milliseconds (the scene model takes `now` the same way). */
export function huntOf(o: HuntOfOptions): HuntSummary {
  const iso = (ms: number): string => new Date(ms).toISOString();
  const ended = o.status === 'succeeded' || o.status === 'failed' || o.status === 'cancelled';
  const stepCount = o.stepCount ?? 0;
  const shown = Math.min(stepCount, 8);
  const base = o.startedAt ?? 0;
  return makeHunt({
    status: o.status,
    reason: o.status === 'succeeded' ? 'diagnosed' : ended ? (o.reason ?? (o.status === 'failed' ? 'timeout' : 'disabled')) : null,
    queuedAt: iso((o.startedAt ?? o.finishedAt ?? 1_000_000) - 1000),
    startedAt: o.startedAt === undefined ? null : iso(o.startedAt),
    finishedAt: ended ? iso(o.finishedAt ?? base + 1000) : null,
    diagnosedBy: o.reason === 'diagnosed_upstream' ? 'payments' : null,
    stepCount,
    steps: Array.from({ length: shown }, (_, k) => {
      const index = stepCount - shown + k + 1;
      return { index, tool: 'search_errors' as const, summary: `errors ${index}`, at: iso(base + index * 100) };
    }),
    diagnosis: o.status === 'succeeded' ? { culpritDeploy: 'd-7', culpritSha: SHA, culpritService: 'payments', summary: 'The guard was removed.' } : null,
  });
}
