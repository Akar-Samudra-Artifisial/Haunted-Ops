import type { AiFailReason, ProposalCheck, ProposalCheckName, ProposalFailReason, ProposalStatus, ProposalSummary } from '@haunted-ops/shared';

/** What the scene draws for a Proposal. A function of the status alone. */
export type ProposalPhase = 'none' | 'drafting' | 'pinned' | 'cleansing' | 'faded';

export const PROPOSAL_PHASE: Readonly<Record<ProposalStatus, Exclude<ProposalPhase, 'none'>>> = Object.freeze({
  drafting: 'drafting',
  open: 'pinned',
  merged: 'pinned',
  deployed: 'cleansing',
  rejected: 'faded',
  failed: 'faded',
  checks_failed: 'faded',
});

export const PROPOSAL_STATUS_TEXT: Readonly<Record<ProposalStatus, string>> = Object.freeze({
  drafting: 'drafting a fix',
  checks_failed: 'no fix could be proposed',
  open: 'pull request open, waiting for review',
  merged: 'merged, deploying',
  deployed: 'fix deployed',
  rejected: 'closed without a merge',
  failed: 'failed',
});

const CHECK_TEXT: Readonly<Record<ProposalCheckName, string>> = Object.freeze({
  non_empty: 'has changes',
  scope: 'in scope',
  forbidden_file: 'allowed files',
  size: 'size',
  syntax: 'syntax',
  tests: 'tests',
  touches_culprit_files: 'touches culprit files',
  merge_scope: 'merge scope',
});

const AI_FAIL_TEXT: Readonly<Record<AiFailReason, string>> = Object.freeze({
  scope: 'out of scope',
  size: 'too large',
  forbidden_file: 'forbidden file',
  tests_failed: 'tests failed',
  agent_failed: 'agent failed',
  timeout: 'timed out',
  budget: 'budget reached',
  daily_limit: 'daily limit reached',
});

const FAIL_TEXT = (r: ProposalFailReason): string => r.replace(/_/g, ' ');

export interface ProposalViewModel {
  phase: ProposalPhase;
  /** One line for the table cell. */
  cell: string;
  kindText: string | null;
  statusText: string;
  /** Checks in words, e.g. "tests passed, size failed". */
  checksText: string | null;
  /** Why the AI patch was not used, when the revert took its place. */
  aiFailText: string | null;
  failText: string | null;
  /** A GitHub pull request link, only when the URL is a GitHub URL. */
  link: { href: string; label: string } | null;
  mergedBy: string | null;
  /** The sentence the announcer says when the status changes to this one. */
  sentence: string;
}

export const isGithubUrl = (url: string | null): url is string => url !== null && url.startsWith('https://github.com/');

export function checksInWords(checks: readonly ProposalCheck[]): string | null {
  if (checks.length === 0) return null;
  return checks.map((c) => `${CHECK_TEXT[c.name]} ${c.ok ? 'passed' : 'failed'}`).join(', ');
}

/** The one place that turns a Proposal into text, for the table cell, the announcer and the scene label. */
export function proposalView(p: ProposalSummary | null, service = ''): ProposalViewModel {
  if (p === null) {
    return { phase: 'none', cell: 'none', kindText: null, statusText: '', checksText: null, aiFailText: null, failText: null, link: null, mergedBy: null, sentence: '' };
  }
  const kindText = p.kind === null ? null : p.kind === 'revert' ? 'revert' : 'AI patch';
  const statusText = PROPOSAL_STATUS_TEXT[p.status];
  const link = isGithubUrl(p.prUrl) && p.prNumber !== null ? { href: p.prUrl, label: `Pull request #${p.prNumber}` } : null;
  const mergedBy = p.mergedBy !== null && p.status !== 'drafting' && p.status !== 'open' ? p.mergedBy : null;
  const failText = p.failReason === null ? null : FAIL_TEXT(p.failReason);
  const aiFailText = p.aiFailReason === null ? null : AI_FAIL_TEXT[p.aiFailReason];
  const cell = [kindText === null ? 'Fix' : `Fix (${kindText})`, statusText, mergedBy === null ? null : `merged by @${mergedBy}`, failText === null ? null : `reason: ${failText}`]
    .filter((x): x is string => x !== null)
    .join(', ');
  const on = service === '' ? '' : ` on ${service}`;
  const sentence = {
    drafting: `Fix drafting${on}.`,
    open: `Pull request ${p.prNumber ?? ''} open${on}${kindText === null ? '' : `, ${kindText}`}.`.replace('request  open', 'request open'),
    merged: `Fix merged${on}${mergedBy === null ? '' : ` by ${mergedBy}`}.`,
    deployed: `Fix deployed${on}.`,
    rejected: `Pull request closed without a merge${on}.`,
    failed: `Fix failed${on}${failText === null ? '' : `: ${failText}`}.`,
    checks_failed: `No fix could be proposed${on}${failText === null ? '' : `: ${failText}`}.`,
  }[p.status];
  return { phase: PROPOSAL_PHASE[p.status], cell, kindText, statusText, checksText: checksInWords(p.checks), aiFailText, failText, link, mergedBy, sentence };
}
