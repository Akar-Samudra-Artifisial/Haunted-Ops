import fc from 'fast-check';
import {
  AI_FAIL_REASONS,
  DIAGNOSIS_CHECKS,
  DOMAIN_EVENT_NAMES,
  PROPOSAL_CHECK_NAMES,
  PROPOSAL_FAIL_REASONS,
  PROPOSAL_KINDS,
  PROPOSAL_STATUSES,
  type ProposalCheck,
  type ProposalEventPayloads,
  type ProposalSummary,
  EVIDENCE_KINDS,
  HUNT_END_REASONS,
  HUNT_STATUSES,
  HUNT_TOOLS,
  HUNT_TRIGGERS,
  type HuntEventPayloads,
  type HuntStepView,
  type HuntSummary,
  HAUNT_LEVELS,
  HAUNT_REASON_KINDS,
  RESYNC_REASONS,
  SERVICE_NAMES,
  SIGNAL_KINDS,
  formatEventId,
  type HauntLevel,
  type HauntReason,
  type Sample,
  type ServiceState,
  type SseEventName,
  type SsePayloads,
} from '../src/index.js';

export const isoArb = fc
  .date({ min: new Date('2000-01-01T00:00:00.000Z'), max: new Date('2099-12-31T23:59:59.999Z'), noInvalidDate: true })
  .map((d) => d.toISOString());

export const bootIdArb = fc.stringMatching(/^[0-9a-f]{12}$/);
export const serviceNameArb = fc.constantFrom(...SERVICE_NAMES);
export const hauntLevelArb = fc.constantFrom(...HAUNT_LEVELS);
export const signalKindArb = fc.constantFrom(...SIGNAL_KINDS);
/** Finite doubles without -0, which JSON cannot carry. */
export const finiteArb = fc.double({ noNaN: true, noDefaultInfinity: true }).map((v) => (v === 0 ? 0 : v));

export const nullableNumberArb = fc.option(finiteArb, { nil: null });
export const sampleArb: fc.Arbitrary<Sample> = fc.record({
  errorRate: nullableNumberArb,
  p95Ms: nullableNumberArb,
  up: nullableNumberArb,
});
export const hauntReasonArb: fc.Arbitrary<HauntReason> = fc.record({
  kind: fc.constantFrom(...HAUNT_REASON_KINDS),
  value: finiteArb,
});

export const serviceStateArb: fc.Arbitrary<ServiceState> = fc.record({
  name: serviceNameArb,
  room: fc.record({ x: fc.integer(), y: fc.integer() }),
  hauntLevel: hauntLevelArb,
  reason: fc.option(hauntReasonArb, { nil: null }),
  metrics: fc.option(fc.record({ errorRate: nullableNumberArb, p95Ms: nullableNumberArb, up: nullableNumberArb, at: isoArb }), {
    nil: null,
  }),
  openIncident: fc.option(
    fc.record({ id: fc.string({ minLength: 1 }), openedAt: isoArb, peakLevel: hauntLevelArb }),
    { nil: null },
  ),
  updatedAt: isoArb,
  hunt: fc.option(
    fc.constant(null).chain(() => huntSummaryArb),
    { nil: null },
  ),
  proposal: fc.option(
    fc.constant(null).chain(() => proposalSummaryArb),
    { nil: null },
  ),
});

export const cuidArb = fc.stringMatching(/^[a-z0-9]{25}$/);
export const fullShaArb = fc.stringMatching(/^[0-9a-f]{40}$/);
export const deployIdArb = fc.integer({ min: 1, max: 999_999 }).map((n) => `d-${n}`);
/** Text without control characters. */
export const plainTextArb = (min: number, max: number) =>
  fc.string({ minLength: min, maxLength: max, unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz 0123456789.,:/()-_') });
export const huntStepArb: fc.Arbitrary<HuntStepView> = fc.record({
  index: fc.integer({ min: 1, max: 40 }),
  tool: fc.constantFrom(...HUNT_TOOLS),
  summary: plainTextArb(1, 120),
  at: isoArb,
});
const failReasonArb = fc.constantFrom(...HUNT_END_REASONS.filter((r) => r !== 'diagnosed'));

/** A consistent summary: the status decides the reason, the diagnosis and the finish time. */
export const huntSummaryArb: fc.Arbitrary<HuntSummary> = fc
  .record({
    id: cuidArb,
    incidentId: cuidArb,
    service: serviceNameArb,
    trigger: fc.constantFrom(...HUNT_TRIGGERS),
    status: fc.constantFrom(...HUNT_STATUSES),
    failReason: failReasonArb,
    by: serviceNameArb,
    steps: fc.array(huntStepArb, { maxLength: 8 }),
    extraSteps: fc.integer({ min: 0, max: 10 }),
    evidenceCount: fc.integer({ min: 0, max: 30 }),
    diagnosis: fc.record({ culpritDeploy: deployIdArb, culpritSha: fullShaArb, culpritService: serviceNameArb, summary: plainTextArb(1, 400) }),
    credits: fc.double({ min: 0, max: 5, noNaN: true }),
    queuedAt: isoArb,
    startedAt: fc.option(isoArb, { nil: null }),
    finishedAt: isoArb,
  })
  .map((r): HuntSummary => {
    const ended = r.status === 'succeeded' || r.status === 'failed' || r.status === 'cancelled';
    return {
      id: r.id,
      incidentId: r.incidentId,
      service: r.service,
      trigger: r.trigger,
      status: r.status,
      reason: !ended ? null : r.status === 'succeeded' ? 'diagnosed' : r.failReason,
      steps: r.steps,
      stepCount: r.steps.length + r.extraSteps,
      evidenceCount: r.evidenceCount,
      diagnosis: r.status === 'succeeded' ? r.diagnosis : null,
      credits: r.credits,
      queuedAt: r.queuedAt,
      startedAt: r.status === 'queued' ? null : r.startedAt,
      finishedAt: ended ? r.finishedAt : null,
      diagnosedBy: ended && r.status !== 'succeeded' && r.failReason === 'diagnosed_upstream' ? r.by : null,
    };
  });

// --- proposals ---

export const loginArb = fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9-]{0,20}$/);
const prNumberArb = fc.integer({ min: 1, max: 99_999 });
export const prUrlOf = (n: number): string => `https://github.com/Akar-Samudra-Artifisial/Haunted-Lab/pull/${n}`;
export const proposalCheckArb: fc.Arbitrary<ProposalCheck> = fc.record({ name: fc.constantFrom(...PROPOSAL_CHECK_NAMES), ok: fc.boolean() });
const checksArb = fc.array(proposalCheckArb, { maxLength: 8 });

/** A consistent summary: the status decides which fields are set. */
export const proposalSummaryArb: fc.Arbitrary<ProposalSummary> = fc
  .record({
    id: cuidArb,
    huntId: cuidArb,
    attempt: fc.integer({ min: 1, max: 5 }),
    kind: fc.constantFrom(...PROPOSAL_KINDS),
    status: fc.constantFrom(...PROPOSAL_STATUSES),
    pr: prNumberArb,
    // GitHub may answer `merged_by: null`.
    login: fc.option(loginArb, { nil: null, freq: 4 }),
    checks: checksArb,
    fail: fc.constantFrom(...PROPOSAL_FAIL_REASONS),
    aiFail: fc.option(fc.constantFrom(...AI_FAIL_REASONS), { nil: null }),
    updatedAt: isoArb,
  })
  .map((r): ProposalSummary => {
    const open = r.status === 'open' || r.status === 'merged' || r.status === 'deployed' || r.status === 'rejected';
    const failed = r.status === 'failed' || r.status === 'checks_failed';
    return {
      id: r.id,
      huntId: r.huntId,
      attempt: r.attempt,
      kind: r.status === 'drafting' || r.status === 'checks_failed' ? null : r.kind,
      status: r.status,
      prNumber: open ? r.pr : null,
      prUrl: open ? prUrlOf(r.pr) : null,
      mergedBy: r.status === 'merged' || r.status === 'deployed' ? r.login : null,
      checks: r.checks,
      failReason: failed ? r.fail : null,
      aiFailReason: r.aiFail,
      updatedAt: r.updatedAt,
    };
  });

const proposalPayloadArbs: { [K in keyof ProposalEventPayloads]: fc.Arbitrary<ProposalEventPayloads[K]> } = {
  'proposal.started': fc.record({ proposalId: cuidArb, huntId: cuidArb, service: serviceNameArb, attempt: fc.integer({ min: 1, max: 5 }), at: isoArb }),
  'proposal.checks': fc.record({
    proposalId: cuidArb,
    huntId: cuidArb,
    service: serviceNameArb,
    kind: fc.constantFrom(...PROPOSAL_KINDS),
    checks: checksArb,
    aiFailReason: fc.option(fc.constantFrom(...AI_FAIL_REASONS), { nil: null }),
    at: isoArb,
  }),
  'proposal.opened': prNumberArb.chain((n) =>
    fc.record({ proposalId: cuidArb, huntId: cuidArb, service: serviceNameArb, kind: fc.constantFrom(...PROPOSAL_KINDS), prNumber: fc.constant(n), prUrl: fc.constant(prUrlOf(n)), at: isoArb }),
  ),
  'proposal.merged': fc.record({ proposalId: cuidArb, huntId: cuidArb, service: serviceNameArb, mergedBy: fc.option(loginArb, { nil: null, freq: 4 }), at: isoArb }),
  'proposal.deployed': fc.record({ proposalId: cuidArb, huntId: cuidArb, service: serviceNameArb, at: isoArb }),
  'proposal.rejected': fc.record({ proposalId: cuidArb, huntId: cuidArb, service: serviceNameArb, at: isoArb }),
  'proposal.failed': fc.record({
    proposalId: cuidArb,
    huntId: cuidArb,
    service: serviceNameArb,
    status: fc.constantFrom('failed', 'checks_failed' as const),
    failReason: fc.constantFrom(...PROPOSAL_FAIL_REASONS),
    at: isoArb,
  }),
};

const huntPayloadArbs: { [K in keyof HuntEventPayloads]: fc.Arbitrary<HuntEventPayloads[K]> } = {
  'hunt.queued': fc.record({ huntId: cuidArb, incidentId: cuidArb, service: serviceNameArb, trigger: fc.constantFrom(...HUNT_TRIGGERS), queuedAt: isoArb }),
  'hunt.started': fc.record({ huntId: cuidArb, service: serviceNameArb, model: fc.constantFrom('claude-sonnet-5.5', 'claude-haiku-5.5'), startedAt: isoArb }),
  'hunt.step': fc.record({ huntId: cuidArb, service: serviceNameArb, index: fc.integer({ min: 1, max: 30 }), tool: fc.constantFrom(...HUNT_TOOLS), summary: plainTextArb(1, 120), at: isoArb }),
  'hunt.evidence': fc.record({
    huntId: cuidArb,
    service: serviceNameArb,
    index: fc.integer({ min: 1, max: 30 }),
    kind: fc.constantFrom(...EVIDENCE_KINDS),
    ref: plainTextArb(1, 80),
    detail: plainTextArb(0, 200),
    at: isoArb,
  }),
  'hunt.diagnosis': fc.record({
    huntId: cuidArb,
    service: serviceNameArb,
    culpritDeploy: deployIdArb,
    culpritSha: fullShaArb,
    culpritService: serviceNameArb,
    summary: plainTextArb(1, 400),
    fixHint: plainTextArb(0, 300),
    cited: fc.array(plainTextArb(1, 80), { maxLength: 10 }),
    at: isoArb,
  }),
  'hunt.finished': fc
    .record({
      huntId: cuidArb,
      service: serviceNameArb,
      status: fc.constantFrom('succeeded', 'failed', 'cancelled' as const),
      failReason: failReasonArb,
      by: serviceNameArb,
      check: fc.constantFrom(...DIAGNOSIS_CHECKS),
      credits: fc.double({ min: 0, max: 5, noNaN: true }),
      durationMs: fc.integer({ min: 0, max: 300_000 }),
      toolCalls: fc.integer({ min: 0, max: 30 }),
      finishedAt: isoArb,
    })
    .map((r) => {
      const reason = r.status === 'succeeded' ? ('diagnosed' as const) : r.failReason;
      return {
        huntId: r.huntId,
        service: r.service,
        status: r.status,
        reason,
        invalidCheck: reason === 'invalid_diagnosis' ? r.check : null,
        diagnosedBy: reason === 'diagnosed_upstream' ? r.by : null,
        credits: r.credits,
        durationMs: r.durationMs,
        toolCalls: r.toolCalls,
        finishedAt: r.finishedAt,
      };
    }),
};

export const payloadArbs: { [K in SseEventName]: fc.Arbitrary<SsePayloads[K]> } = {
  'service.updated': fc.record({ service: serviceStateArb, previousLevel: hauntLevelArb }),
  'signal.recorded': fc.record({ service: serviceNameArb, kind: signalKindArb, value: finiteArb, at: isoArb }),
  'incident.opened': fc.record({
    incidentId: fc.string({ minLength: 1 }),
    service: serviceNameArb,
    openedAt: isoArb,
    level: hauntLevelArb,
    reason: fc.option(hauntReasonArb, { nil: null }),
  }),
  'incident.closed': fc.record({
    incidentId: fc.string({ minLength: 1 }),
    service: serviceNameArb,
    closedAt: isoArb,
    peakLevel: hauntLevelArb,
  }),
  'ingest.polled': fc.record({
    at: isoArb,
    samples: fc.array(fc.record({ service: serviceNameArb, errorRate: nullableNumberArb, p95Ms: nullableNumberArb, up: nullableNumberArb }), {
      maxLength: 4,
    }),
  }),
  'ingest.status': fc.record({
    state: fc.constantFrom('ok', 'stale' as const),
    at: isoArb,
    lastSuccessAt: fc.option(isoArb, { nil: null }),
  }),
  ...huntPayloadArbs,
  ...proposalPayloadArbs,
  connected: fc.record({ bootId: bootIdArb }),
  heartbeat: fc.record({ at: isoArb }),
  resync: fc.record({ reason: fc.constantFrom(...RESYNC_REASONS) }),
};

/** Any valid named event, with an id only for domain events. */
export const namedEventArb = fc.oneof(
  ...(Object.keys(payloadArbs) as SseEventName[]).map((name) =>
    fc.record({
      name: fc.constant(name),
      payload: payloadArbs[name] as fc.Arbitrary<unknown>,
      id: (DOMAIN_EVENT_NAMES as readonly string[]).includes(name)
        ? fc
            .tuple(bootIdArb, fc.integer({ min: 1, max: 999_999_999_999_999 }))
            .map(([boot, n]): string | undefined => formatEventId(boot, n))
        : fc.constant<string | undefined>(undefined),
    }),
  ),
);

/** A Sample whose raw haunt level is exactly `level`. */
export function sampleForLevel(level: HauntLevel): Sample {
  const calm: Sample = { errorRate: 0, p95Ms: 100, up: 1 };
  switch (level) {
    case 0:
      return calm;
    case 1:
      return { ...calm, errorRate: 0.06 };
    case 2:
      return { ...calm, errorRate: 0.25 };
    case 3:
      return { ...calm, errorRate: 0.6 };
    case 4:
      return { ...calm, up: 0 };
  }
}
