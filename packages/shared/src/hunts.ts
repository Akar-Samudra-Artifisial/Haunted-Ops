import type { Result, ServiceName } from './types.js';
import {
  checkArrayOf,
  checkFiniteNumber,
  checkInteger,
  checkIsoTimestamp,
  checkNullable,
  checkObject,
  checkOneOf,
  checkServiceName,
  makeValidator,
  type Check,
} from './checks.js';
import { CUID_PATTERN, checkCuid } from './ids.js';
import { checkProposalSummary, type ProposalSummary } from './proposals.js';

/** The six tools of the Exorcist, in the order the agent is told to use them. */
export const HUNT_TOOLS = ['query_metrics', 'search_errors', 'tail_logs', 'recent_deploys', 'diff_commit', 'submit_diagnosis'] as const;
export type HuntTool = (typeof HUNT_TOOLS)[number];

export const HUNT_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const;
export type HuntStatus = (typeof HUNT_STATUSES)[number];
export type HuntFinalStatus = Exclude<HuntStatus, 'queued' | 'running'>;

export const HUNT_TRIGGERS = ['auto', 'operator'] as const;
export type HuntTrigger = (typeof HUNT_TRIGGERS)[number];

/** Why a Hunt ended. `diagnosed` is the only reason of a succeeded Hunt. */
export const HUNT_END_REASONS = [
  'diagnosed',
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
  'busy',
  'cooldown',
  'disabled',
  'incident_closed',
  'shutdown',
  'api_restart',
  /** Withdrawn because an Incident further downstream the call chain is the better place to look. */
  'downstream',
  /** Withdrawn because an upstream Hunt already diagnosed this Service as the culprit's Service. */
  'diagnosed_upstream',
  /** The day's limit of started Hunts (`HUNT_DAILY_MAX`) was reached. */
  'daily_limit',
] as const;
export type HuntEndReason = (typeof HUNT_END_REASONS)[number];

/** The checks of the diagnosis validator, in the order they run. */
export const DIAGNOSIS_CHECKS = [
  'stream_mismatch',
  'service',
  'deploy_unknown',
  'deploy_service',
  'deploy_after_incident',
  'sha_mismatch',
  'sha_unreachable',
  'evidence_unseen',
  'evidence_kind',
  'culprit_not_cited',
  'lab_unavailable',
] as const;
export type DiagnosisCheck = (typeof DIAGNOSIS_CHECKS)[number];

export const EVIDENCE_KINDS = ['metric', 'error', 'log', 'deploy', 'commit'] as const;
export type EvidenceKindName = (typeof EVIDENCE_KINDS)[number];

/** Text limits shared by the API, the Web and the validators. */
export const HUNT_LIMITS = Object.freeze({
  stepSummary: 120,
  evidenceRef: 80,
  evidenceDetail: 200,
  /** The diagnosis texts are model text on a public page: cleaned and cut to these lengths. */
  summary: 400,
  fixHint: 300,
  stopDetail: 200,
  cited: 10,
  model: 64,
  /** Steps kept in a summary. */
  summarySteps: 8,
});

/** 40 lowercase hex characters. */
export const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/;
/** Lab deploy ids (`d-102`). */
export const DEPLOY_ID_PATTERN = /^d-[0-9]{1,9}$/;
export { CUID_PATTERN, checkCuid };

export interface HuntEventPayloads {
  'hunt.queued': { huntId: string; incidentId: string; service: ServiceName; trigger: HuntTrigger; queuedAt: string };
  'hunt.started': { huntId: string; service: ServiceName; model: string; startedAt: string };
  'hunt.step': { huntId: string; service: ServiceName; index: number; tool: HuntTool; summary: string; at: string };
  'hunt.evidence': {
    huntId: string;
    service: ServiceName;
    index: number;
    kind: EvidenceKindName;
    ref: string;
    detail: string;
    at: string;
  };
  'hunt.diagnosis': {
    huntId: string;
    service: ServiceName;
    culpritDeploy: string;
    culpritSha: string;
    culpritService: ServiceName;
    summary: string;
    fixHint: string;
    cited: string[];
    at: string;
  };
  'hunt.finished': {
    huntId: string;
    service: ServiceName;
    status: HuntFinalStatus;
    reason: HuntEndReason;
    invalidCheck: DiagnosisCheck | null;
    /** Set exactly when the reason is `diagnosed_upstream`. */
    diagnosedBy: ServiceName | null;
    credits: number;
    durationMs: number;
    toolCalls: number;
    finishedAt: string;
  };
}

export const HUNT_EVENT_NAMES = [
  'hunt.queued',
  'hunt.started',
  'hunt.step',
  'hunt.evidence',
  'hunt.diagnosis',
  'hunt.finished',
] as const satisfies readonly (keyof HuntEventPayloads)[];
export type HuntEventName = (typeof HUNT_EVENT_NAMES)[number];

export interface HuntStepView {
  index: number;
  tool: HuntTool;
  summary: string;
  at: string;
}

export interface HuntDiagnosisView {
  culpritDeploy: string;
  culpritSha: string;
  /** The Service the culprit deploy belongs to: the hunted one, or one it depends on. */
  culpritService: ServiceName;
  summary: string;
}

/** The latest Hunt of a Service, as `GET /api/services` and the Web keep it. */
export interface HuntSummary {
  id: string;
  incidentId: string;
  service: ServiceName;
  trigger: HuntTrigger;
  status: HuntStatus;
  reason: HuntEndReason | null;
  /** The last 8 Steps, oldest first. */
  steps: HuntStepView[];
  stepCount: number;
  evidenceCount: number;
  /** Valid diagnoses only. */
  diagnosis: HuntDiagnosisView | null;
  credits: number;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** The Service of the Hunt that diagnosed this one's cause; set exactly when the reason is `diagnosed_upstream`. */
  diagnosedBy: ServiceName | null;
}

export interface HuntEvidenceView {
  index: number;
  kind: EvidenceKindName;
  ref: string;
  detail: string;
  cited: boolean;
}

/** `GET /api/hunts/:id`. */
export interface HuntDetail extends HuntSummary {
  model: string;
  toolCalls: number;
  durationMs: number | null;
  invalidCheck: DiagnosisCheck | null;
  /** What stopped the Hunt, in a few words (for `foreign_tool`: the refused tool title and Tool Load ids). */
  stopDetail: string | null;
  /** True when `credits` is the per-hunt cap, counted because the Hunt ended before Kiro reported its Credits. */
  creditsEstimated: boolean;
  /** The id of the Hunt that diagnosed this one's cause (reason `diagnosed_upstream`), else null. */
  linkedHuntId: string | null;
  allSteps: HuntStepView[];
  evidence: HuntEvidenceView[];
  fixHint: string | null;
  /** The latest Proposal (fix) of this Hunt, or null. */
  proposal: ProposalSummary | null;
}

// --- checks ---

const checkPattern =
  (pattern: RegExp): Check =>
  (input, path, errors) => {
    if (typeof input !== 'string' || !pattern.test(input)) errors.push(path);
  };

/** A string of `min` to `max` characters with no C0/C1 control character other than line feed and tab. */
export const checkBoundedText =
  (max: number, min = 0): Check =>
  (input, path, errors) => {
    // eslint-disable-next-line no-control-regex
    if (typeof input !== 'string' || input.length < min || input.length > max || /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(input)) {
      errors.push(path);
    }
  };

const checkNonNegative: Check = (input, path, errors) => {
  if (typeof input !== 'number' || !Number.isFinite(input) || input < 0) errors.push(path);
};

const checkCount: Check = (input, path, errors) => {
  checkInteger(input, path, errors);
  if (typeof input === 'number' && input < 0) errors.push(path);
};

const checkIndex: Check = (input, path, errors) => {
  checkInteger(input, path, errors);
  if (typeof input === 'number' && input < 1) errors.push(path);
};

const checkMaxItems =
  (max: number, inner: Check): Check =>
  (input, path, errors) => {
    checkArrayOf(inner)(input, path, errors);
    if (Array.isArray(input) && input.length > max) errors.push(path);
  };

export const checkFullSha = checkPattern(FULL_SHA_PATTERN);
export const checkDeployId = checkPattern(DEPLOY_ID_PATTERN);
export const checkHuntTool = checkOneOf(HUNT_TOOLS);
export const checkHuntStatus = checkOneOf(HUNT_STATUSES);
export const checkHuntTrigger = checkOneOf(HUNT_TRIGGERS);
export const checkHuntEndReason = checkOneOf(HUNT_END_REASONS);
export const checkDiagnosisCheck = checkOneOf(DIAGNOSIS_CHECKS);
export const checkEvidenceKind = checkOneOf(EVIDENCE_KINDS);
const checkModel = checkPattern(/^[a-z0-9][a-z0-9.-]{0,63}$/);

export const checkHuntStepView = checkObject({
  index: checkIndex,
  tool: checkHuntTool,
  summary: checkBoundedText(HUNT_LIMITS.stepSummary, 1),
  at: checkIsoTimestamp,
});

const checkDiagnosisView = checkObject({
  culpritDeploy: checkDeployId,
  culpritSha: checkFullSha,
  culpritService: checkServiceName,
  summary: checkBoundedText(HUNT_LIMITS.summary, 1),
});

const summaryShape = {
  id: checkCuid,
  incidentId: checkCuid,
  service: checkServiceName,
  trigger: checkHuntTrigger,
  status: checkHuntStatus,
  reason: checkNullable(checkHuntEndReason),
  steps: checkMaxItems(HUNT_LIMITS.summarySteps, checkHuntStepView),
  stepCount: checkCount,
  evidenceCount: checkCount,
  diagnosis: checkNullable(checkDiagnosisView),
  credits: checkNonNegative,
  queuedAt: checkIsoTimestamp,
  startedAt: checkNullable(checkIsoTimestamp),
  finishedAt: checkNullable(checkIsoTimestamp),
  diagnosedBy: checkNullable(checkServiceName),
};

/** A summary is also consistent: a diagnosis only on a succeeded Hunt, a reason only once it ended. */
export const checkHuntSummary: Check = (input, path, errors) => {
  const before = errors.length;
  checkObject(summaryShape)(input, path, errors);
  if (errors.length !== before) return;
  const s = input as unknown as HuntSummary;
  const ended = s.status === 'succeeded' || s.status === 'failed' || s.status === 'cancelled';
  if (s.diagnosis !== null && s.status !== 'succeeded') errors.push(`${path}.diagnosis`);
  if (s.status === 'succeeded' && (s.diagnosis === null || s.reason !== 'diagnosed')) errors.push(`${path}.status`);
  if (s.status !== 'succeeded' && s.reason === 'diagnosed') errors.push(`${path}.reason`);
  if (ended !== (s.reason !== null) || ended !== (s.finishedAt !== null)) errors.push(`${path}.reason`);
  if ((s.diagnosedBy !== null) !== (s.reason === 'diagnosed_upstream')) errors.push(`${path}.diagnosedBy`);
  if (s.stepCount < s.steps.length) errors.push(`${path}.stepCount`);
};

export const checkHuntDetail: Check = (input, path, errors) => {
  const { model, toolCalls, durationMs, invalidCheck, stopDetail, creditsEstimated, linkedHuntId, allSteps, evidence, fixHint, proposal, ...rest } =
    (input ?? {}) as Record<string, unknown>;
  if (typeof input !== 'object' || input === null) {
    errors.push(path);
    return;
  }
  checkHuntSummary(rest, path, errors);
  checkModel(model, `${path}.model`, errors);
  checkCount(toolCalls, `${path}.toolCalls`, errors);
  checkNullable(checkCount)(durationMs, `${path}.durationMs`, errors);
  checkNullable(checkDiagnosisCheck)(invalidCheck, `${path}.invalidCheck`, errors);
  checkNullable(checkBoundedText(HUNT_LIMITS.stopDetail, 1))(stopDetail, `${path}.stopDetail`, errors);
  if (typeof creditsEstimated !== 'boolean') errors.push(`${path}.creditsEstimated`);
  checkNullable(checkCuid)(linkedHuntId, `${path}.linkedHuntId`, errors);
  if ((linkedHuntId !== null && linkedHuntId !== undefined) && (rest as { reason?: unknown }).reason !== 'diagnosed_upstream') errors.push(`${path}.linkedHuntId`);
  checkArrayOf(checkHuntStepView)(allSteps, `${path}.allSteps`, errors);
  checkArrayOf(
    checkObject({
      index: checkIndex,
      kind: checkEvidenceKind,
      ref: checkBoundedText(HUNT_LIMITS.evidenceRef, 1),
      detail: checkBoundedText(HUNT_LIMITS.evidenceDetail),
      cited: (v, p, e) => {
        if (typeof v !== 'boolean') e.push(p);
      },
    }),
  )(evidence, `${path}.evidence`, errors);
  checkNullable(checkBoundedText(HUNT_LIMITS.fixHint))(fixHint, `${path}.fixHint`, errors);
  checkNullable(checkProposalSummary)(proposal, `${path}.proposal`, errors);
  if (proposal !== null && proposal !== undefined && (proposal as { huntId?: unknown }).huntId !== (rest as { id?: unknown }).id) errors.push(`${path}.proposal`);
};

const finalStatus = checkOneOf(['succeeded', 'failed', 'cancelled']);

export const huntPayloadChecks: { [K in HuntEventName]: Check } = {
  'hunt.queued': checkObject({
    huntId: checkCuid,
    incidentId: checkCuid,
    service: checkServiceName,
    trigger: checkHuntTrigger,
    queuedAt: checkIsoTimestamp,
  }),
  'hunt.started': checkObject({ huntId: checkCuid, service: checkServiceName, model: checkModel, startedAt: checkIsoTimestamp }),
  'hunt.step': checkObject({
    huntId: checkCuid,
    service: checkServiceName,
    index: checkIndex,
    tool: checkHuntTool,
    summary: checkBoundedText(HUNT_LIMITS.stepSummary, 1),
    at: checkIsoTimestamp,
  }),
  'hunt.evidence': checkObject({
    huntId: checkCuid,
    service: checkServiceName,
    index: checkIndex,
    kind: checkEvidenceKind,
    ref: checkBoundedText(HUNT_LIMITS.evidenceRef, 1),
    detail: checkBoundedText(HUNT_LIMITS.evidenceDetail),
    at: checkIsoTimestamp,
  }),
  'hunt.diagnosis': checkObject({
    huntId: checkCuid,
    service: checkServiceName,
    culpritDeploy: checkDeployId,
    culpritSha: checkFullSha,
    culpritService: checkServiceName,
    summary: checkBoundedText(HUNT_LIMITS.summary, 1),
    fixHint: checkBoundedText(HUNT_LIMITS.fixHint),
    cited: checkMaxItems(HUNT_LIMITS.cited, checkBoundedText(HUNT_LIMITS.evidenceRef, 1)),
    at: checkIsoTimestamp,
  }),
  'hunt.finished': (input, path, errors) => {
    const before = errors.length;
    checkObject({
      huntId: checkCuid,
      service: checkServiceName,
      status: finalStatus,
      reason: checkHuntEndReason,
      invalidCheck: checkNullable(checkDiagnosisCheck),
      diagnosedBy: checkNullable(checkServiceName),
      credits: checkNonNegative,
      durationMs: checkCount,
      toolCalls: checkCount,
      finishedAt: checkIsoTimestamp,
    })(input, path, errors);
    if (errors.length !== before) return;
    const p = input as HuntEventPayloads['hunt.finished'];
    if ((p.status === 'succeeded') !== (p.reason === 'diagnosed')) errors.push(`${path}.reason`);
    if (p.invalidCheck !== null && p.reason !== 'invalid_diagnosis') errors.push(`${path}.invalidCheck`);
    if ((p.diagnosedBy !== null) !== (p.reason === 'diagnosed_upstream')) errors.push(`${path}.diagnosedBy`);
    checkFiniteNumber(p.credits, `${path}.credits`, errors);
  },
};

export const validateHuntSummary = makeValidator<HuntSummary>(checkHuntSummary);
export const validateHuntDetail = makeValidator<HuntDetail>(checkHuntDetail);
export const validateHuntEvent = <K extends HuntEventName>(name: K, input: unknown): Result<HuntEventPayloads[K]> =>
  makeValidator<HuntEventPayloads[K]>(huntPayloadChecks[name])(input);

/** Short first part of a SHA, as shown in the scene and the table. */
export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}
