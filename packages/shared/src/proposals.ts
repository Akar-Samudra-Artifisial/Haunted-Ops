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

export const PROPOSAL_STATUSES = ['drafting', 'checks_failed', 'open', 'merged', 'deployed', 'rejected', 'failed'] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export const PROPOSAL_KINDS = ['ai_patch', 'revert'] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];

/** The allowed moves of a Proposal status. A status only moves forward; the others are final. */
export const PROPOSAL_EDGES: Readonly<Record<ProposalStatus, readonly ProposalStatus[]>> = Object.freeze({
  drafting: ['open', 'checks_failed', 'failed'],
  open: ['merged', 'rejected', 'failed'],
  merged: ['deployed', 'failed'],
  checks_failed: [],
  deployed: [],
  rejected: [],
  failed: [],
});

export const canMove = (from: ProposalStatus, to: ProposalStatus): boolean => PROPOSAL_EDGES[from].includes(to);

/** A status that never changes again. */
export const isFinalProposalStatus = (s: ProposalStatus): boolean => PROPOSAL_EDGES[s].length === 0;

/** A Proposal that is still moving (the store allows one per Hunt). */
export const isActiveProposalStatus = (s: ProposalStatus): boolean => s === 'drafting' || s === 'open' || s === 'merged';

/** Why the Fixer's patch was not used. */
/** `unchecked`: the patch passed, but neither a syntax checker nor a test applied to it, so it was not proposed. */
export const AI_FAIL_REASONS = ['scope', 'size', 'forbidden_file', 'tests_failed', 'agent_failed', 'timeout', 'budget', 'daily_limit', 'unchecked'] as const;
export type AiFailReason = (typeof AI_FAIL_REASONS)[number];

/** Why a Proposal ended `checks_failed` or `failed`. Fixed codes: no message of git or GitHub is kept. */
export const PROPOSAL_FAIL_REASONS = [
  'lab_unavailable',
  'base_unknown',
  'branch_exists',
  'revert_unavailable',
  'revert_conflict',
  'checks_failed',
  'github_unauthorized',
  'github_forbidden',
  'github_rate_limited',
  'github_not_found',
  'github_unprocessable',
  'github_unavailable',
  'github_bad_response',
  'push_rejected',
  'head_changed',
  'ref_moved',
  'merge_scope',
  /** What GitHub merged is not the tree that was pushed (an edit while merging, a rebase that changed content). */
  'merge_content',
  'deploy_rejected',
  'deploy_unavailable',
  'deploy_unconfirmed',
  'export_unsafe',
  'api_restart',
  'internal',
] as const;
export type ProposalFailReason = (typeof PROPOSAL_FAIL_REASONS)[number];

export const PROPOSAL_CHECK_NAMES = ['non_empty', 'scope', 'forbidden_file', 'size', 'syntax', 'tests', 'touches_culprit_files', 'merge_scope'] as const;
export type ProposalCheckName = (typeof PROPOSAL_CHECK_NAMES)[number];

export interface ProposalCheck {
  name: ProposalCheckName;
  ok: boolean;
  /**
   * Only on `tests` and `syntax`, only with `ok: true`: nothing checked it (no sandbox-green test file; no syntax
   * checker for the file kinds). Recorded, never a silent pass; the pull request body says so.
   */
  skipped?: true;
  /** With `skipped`: `no sandbox-green tests for <service>`, or `no syntax checker for these files`. */
  detail?: string;
}

/** The `detail` of a skipped `tests` check. */
export const testsSkippedDetail = (service: ServiceName): string => `no sandbox-green tests for ${service}`;
export const PROPOSAL_CHECK_DETAIL_PATTERN = /^no sandbox-green tests for (gate|orders|payments|ledger)$/;
/** The `detail` of a skipped `syntax` check (no checker applies to the written file kinds). */
export const SYNTAX_SKIPPED_DETAIL = 'no syntax checker for these files';

export const PROPOSAL_LIMITS = Object.freeze({ checks: 12, prNumber: 99_999_999 });

/** `https://github.com/<owner>/<repo>/pull/<n>` and nothing else. */
export const PR_URL_PATTERN = /^https:\/\/github\.com\/[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}\/pull\/\d{1,8}$/;
/** A GitHub login, with the `[bot]` suffix of apps. */
export const GITHUB_LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/;

/** `incident/<huntId>`: the base of the pull request and the ref the lab deploys. */
export function incidentBranch(huntId: string): string {
  if (typeof huntId !== 'string' || !CUID_PATTERN.test(huntId)) throw new Error('invalid hunt id');
  return `incident/${huntId}`;
}

/** `exorcist/<huntId>`: the head of the pull request. */
export function fixBranch(huntId: string): string {
  if (typeof huntId !== 'string' || !CUID_PATTERN.test(huntId)) throw new Error('invalid hunt id');
  return `exorcist/${huntId}`;
}

/** The two branch names a Proposal may ever push, delete or list. */
export const PROPOSAL_BRANCH_PATTERN = /^(incident|exorcist)\/[a-z0-9]{20,32}$/;

export interface ProposalSummary {
  id: string;
  huntId: string;
  attempt: number;
  kind: ProposalKind | null;
  status: ProposalStatus;
  prNumber: number | null;
  prUrl: string | null;
  mergedBy: string | null;
  checks: ProposalCheck[];
  failReason: ProposalFailReason | null;
  aiFailReason: AiFailReason | null;
  updatedAt: string;
}

/** The longest `aiFailDetail`. */
export const AI_FAIL_DETAIL_MAX = 300;
// eslint-disable-next-line no-control-regex
const DETAIL_CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
/** An absolute path: a slash that does not continue a word, a URL or a relative path. */
const DETAIL_PATH = /(?<![\w.:/-])\/[\w.@~+-]+(?:\/[\w.@~+-]*)*/;
/** Token-like text: a known token prefix, a long unbroken run, `Bearer <x>`, or credentials in a URL. */
const DETAIL_TOKEN = /(?:github_pat_|gh[pousr]_|sk-|AKIA)[A-Za-z0-9_.-]{6,}|Bearer\s+\S{6,}|\b[A-Za-z0-9_-]{32,}\b|[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/@]+@/;
/**
 * The text of an `aiFailDetail` as a view may show it: one line, an absolute path as `[path]`, token-like text as
 * `[redacted]`, at most 300 characters. The same text always passes `checkAiFailDetail`.
 */
export function scrubAiFailDetail(text: string): string {
  const clean = text
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(new RegExp(DETAIL_TOKEN.source, 'g'), '[redacted]')
    .replace(new RegExp(DETAIL_PATH.source, 'g'), '[path]')
    .trim()
    .slice(0, AI_FAIL_DETAIL_MAX);
  // A cut can leave half of a token or path at the end: scrub again so what is shown always passes the check.
  return DETAIL_PATH.test(clean) || DETAIL_TOKEN.test(clean) ? scrubAiFailDetail(clean.slice(0, -1)) : clean;
}
/** `GET /api/proposals/:id`. `aiFailDetail` is why the Fixer's run was not used (`<code>: <few words>`), scrubbed. */
export interface ProposalView extends ProposalSummary {
  aiFailDetail: string | null;
  service: ServiceName;
  credits: number;
  creditsEstimated: boolean;
  createdAt: string;
  openedAt: string | null;
  mergedAt: string | null;
  deployedAt: string | null;
}

export interface ProposalEventPayloads {
  'proposal.started': { proposalId: string; huntId: string; service: ServiceName; attempt: number; at: string };
  'proposal.checks': {
    proposalId: string;
    huntId: string;
    service: ServiceName;
    kind: ProposalKind;
    checks: ProposalCheck[];
    aiFailReason: AiFailReason | null;
    at: string;
  };
  'proposal.opened': { proposalId: string; huntId: string; service: ServiceName; kind: ProposalKind; prNumber: number; prUrl: string; at: string };
  /** `mergedBy` is null when GitHub does not name who merged. */
  'proposal.merged': { proposalId: string; huntId: string; service: ServiceName; mergedBy: string | null; at: string };
  'proposal.deployed': { proposalId: string; huntId: string; service: ServiceName; at: string };
  'proposal.rejected': { proposalId: string; huntId: string; service: ServiceName; at: string };
  'proposal.failed': {
    proposalId: string;
    huntId: string;
    service: ServiceName;
    status: 'failed' | 'checks_failed';
    failReason: ProposalFailReason;
    at: string;
  };
}

export const PROPOSAL_EVENT_NAMES = [
  'proposal.started',
  'proposal.checks',
  'proposal.opened',
  'proposal.merged',
  'proposal.deployed',
  'proposal.rejected',
  'proposal.failed',
] as const satisfies readonly (keyof ProposalEventPayloads)[];
export type ProposalEventName = (typeof PROPOSAL_EVENT_NAMES)[number];

// --- checks ---

const checkPattern =
  (pattern: RegExp): Check =>
  (input, path, errors) => {
    if (typeof input !== 'string' || !pattern.test(input)) errors.push(path);
  };

const checkPositive: Check = (input, path, errors) => {
  checkInteger(input, path, errors);
  if (typeof input === 'number' && (input < 1 || input > PROPOSAL_LIMITS.prNumber)) errors.push(path);
};

export const checkProposalStatus = checkOneOf(PROPOSAL_STATUSES);
export const checkProposalKind = checkOneOf(PROPOSAL_KINDS);
export const checkAiFailReason = checkOneOf(AI_FAIL_REASONS);
export const checkProposalFailReason = checkOneOf(PROPOSAL_FAIL_REASONS);
export const checkAiFailDetail: Check = (input, path, errors) => {
  if (typeof input !== 'string' || input.length === 0 || input.length > AI_FAIL_DETAIL_MAX || DETAIL_CONTROL.test(input) || DETAIL_PATH.test(input) || DETAIL_TOKEN.test(input)) errors.push(path);
};
export const checkPrUrl = checkPattern(PR_URL_PATTERN);
export const checkGithubLogin = checkPattern(GITHUB_LOGIN_PATTERN);

const checkPlainCheck: Check = checkObject({
  name: checkOneOf(PROPOSAL_CHECK_NAMES),
  ok: (v, p, e) => {
    if (typeof v !== 'boolean') e.push(p);
  },
});
const checkSkippedSyntax: Check = checkObject({
  name: checkOneOf(['syntax']),
  ok: (v, p, e) => {
    if (v !== true) e.push(p);
  },
  skipped: (v, p, e) => {
    if (v !== true) e.push(p);
  },
  detail: (v, p, e) => {
    if (v !== SYNTAX_SKIPPED_DETAIL) e.push(p);
  },
});
const checkSkippedTests: Check = checkObject({
  name: checkOneOf(['tests']),
  ok: (v, p, e) => {
    if (v !== true) e.push(p);
  },
  skipped: (v, p, e) => {
    if (v !== true) e.push(p);
  },
  detail: (v, p, e) => {
    if (typeof v !== 'string' || !PROPOSAL_CHECK_DETAIL_PATTERN.test(v)) e.push(p);
  },
});
/** `{ name, ok }`, or the skipped tests check `{ name: 'tests', ok: true, skipped: true, detail }`. */
export const checkProposalCheck: Check = (input, path, errors) => {
  const skipped = typeof input === 'object' && input !== null && Object.hasOwn(input, 'skipped');
  const isSyntax = skipped && (input as { name?: unknown }).name === 'syntax';
  (skipped ? (isSyntax ? checkSkippedSyntax : checkSkippedTests) : checkPlainCheck)(input, path, errors);
};

const checkChecks: Check = (input, path, errors) => {
  checkArrayOf(checkProposalCheck)(input, path, errors);
  if (Array.isArray(input) && input.length > PROPOSAL_LIMITS.checks) errors.push(path);
};

const summaryShape: Record<string, Check> = {
  id: checkCuid,
  huntId: checkCuid,
  attempt: checkPositive,
  kind: checkNullable(checkProposalKind),
  status: checkProposalStatus,
  prNumber: checkNullable(checkPositive),
  prUrl: checkNullable(checkPrUrl),
  mergedBy: checkNullable(checkGithubLogin),
  checks: checkChecks,
  failReason: checkNullable(checkProposalFailReason),
  aiFailReason: checkNullable(checkAiFailReason),
  updatedAt: checkIsoTimestamp,
};

/** Consistency of a summary: what each status must have, and nothing a status cannot have. */
function checkProposalFields(s: ProposalSummary, path: string, errors: string[]): void {
  const hasPr = s.prNumber !== null && s.prUrl !== null;
  if ((s.prNumber === null) !== (s.prUrl === null)) errors.push(`${path}.prUrl`);
  if (s.prUrl !== null && s.prNumber !== null && !s.prUrl.endsWith(`/pull/${s.prNumber}`)) errors.push(`${path}.prUrl`);
  const afterOpen = s.status === 'open' || s.status === 'merged' || s.status === 'deployed';
  if (afterOpen && (!hasPr || s.kind === null)) errors.push(`${path}.status`);
  if (s.status === 'drafting' && (hasPr || s.failReason !== null)) errors.push(`${path}.status`);
  // Who merged is known only from `merged` on, and GitHub may not name anyone (`merged_by: null`), so a merged or
  // deployed Proposal can have no login; before the merge it never has one.
  if ((s.status === 'drafting' || s.status === 'open' || s.status === 'checks_failed' || s.status === 'rejected') && s.mergedBy !== null) errors.push(`${path}.mergedBy`);
  if ((s.status === 'failed' || s.status === 'checks_failed') !== (s.failReason !== null)) errors.push(`${path}.failReason`);
  if (s.status === 'checks_failed' && hasPr) errors.push(`${path}.status`);
}

export const checkProposalSummary: Check = (input, path, errors) => {
  const before = errors.length;
  checkObject(summaryShape)(input, path, errors);
  if (errors.length === before) checkProposalFields(input as ProposalSummary, path, errors);
};

export const checkProposalView: Check = (input, path, errors) => {
  const before = errors.length;
  checkObject({
    ...summaryShape,
    aiFailDetail: checkNullable(checkAiFailDetail),
    service: checkServiceName,
    credits: (v, p, e) => {
      checkFiniteNumber(v, p, e);
      if (typeof v === 'number' && v < 0) e.push(p);
    },
    creditsEstimated: (v, p, e) => {
      if (typeof v !== 'boolean') e.push(p);
    },
    createdAt: checkIsoTimestamp,
    openedAt: checkNullable(checkIsoTimestamp),
    mergedAt: checkNullable(checkIsoTimestamp),
    deployedAt: checkNullable(checkIsoTimestamp),
  })(input, path, errors);
  if (errors.length !== before) return;
  const v = input as ProposalView;
  checkProposalFields(v, path, errors);
  if ((v.deployedAt !== null) !== (v.status === 'deployed')) errors.push(`${path}.deployedAt`);
};

const eventBase = { proposalId: checkCuid, huntId: checkCuid, service: checkServiceName };

export const proposalPayloadChecks: { [K in ProposalEventName]: Check } = {
  'proposal.started': checkObject({ ...eventBase, attempt: checkPositive, at: checkIsoTimestamp }),
  'proposal.checks': checkObject({
    ...eventBase,
    kind: checkProposalKind,
    checks: checkChecks,
    aiFailReason: checkNullable(checkAiFailReason),
    at: checkIsoTimestamp,
  }),
  'proposal.opened': checkObject({ ...eventBase, kind: checkProposalKind, prNumber: checkPositive, prUrl: checkPrUrl, at: checkIsoTimestamp }),
  'proposal.merged': checkObject({ ...eventBase, mergedBy: checkNullable(checkGithubLogin), at: checkIsoTimestamp }),
  'proposal.deployed': checkObject({ ...eventBase, at: checkIsoTimestamp }),
  'proposal.rejected': checkObject({ ...eventBase, at: checkIsoTimestamp }),
  'proposal.failed': checkObject({
    ...eventBase,
    status: checkOneOf(['failed', 'checks_failed']),
    failReason: checkProposalFailReason,
    at: checkIsoTimestamp,
  }),
};

export const validateProposalSummary = makeValidator<ProposalSummary>(checkProposalSummary);
export const validateProposalView = makeValidator<ProposalView>(checkProposalView);
export const validateProposalEvent = <K extends ProposalEventName>(name: K, input: unknown): Result<ProposalEventPayloads[K]> =>
  makeValidator<ProposalEventPayloads[K]>(proposalPayloadChecks[name])(input);
