import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  CUID_PATTERN,
  PROPOSAL_EDGES,
  PROPOSAL_EVENT_NAMES,
  PROPOSAL_STATUSES,
  canMove,
  checkAiFailDetail,
  fixBranch,
  incidentBranch,
  isActiveProposalStatus,
  isFinalProposalStatus,
  scrubAiFailDetail,
  validateProposalEvent,
  validateProposalSummary,
  validateProposalView,
  validateServiceState,
  validateSseEvent,
  testsSkippedDetail,
  type ProposalSummary,
  type ProposalView,
} from '../src/index.js';
import { cuidArb, proposalSummaryArb, serviceStateArb, payloadArbs } from './arbitraries.js';

const ID = 'cmproposalaaaaaaaaaaaaaaa';
const HUNT = 'cmhuntaaaaaaaaaaaaaaaaaaa';
const URL = 'https://github.com/Akar-Samudra-Artifisial/Haunted-Lab/pull/12';

const open: ProposalSummary = {
  id: ID,
  huntId: HUNT,
  attempt: 1,
  kind: 'ai_patch',
  status: 'open',
  prNumber: 12,
  prUrl: URL,
  mergedBy: null,
  checks: [{ name: 'scope', ok: true }, { name: 'tests', ok: true }],
  failReason: null,
  aiFailReason: null,
  updatedAt: '2026-11-14T10:00:00.000Z',
};

describe('proposal summaries', () => {
  it('accepts every status in its consistent form', () => {
    expect(validateProposalSummary(open).ok).toBe(true);
    expect(validateProposalSummary({ ...open, status: 'drafting', kind: null, prNumber: null, prUrl: null }).ok).toBe(true);
    expect(validateProposalSummary({ ...open, status: 'merged', mergedBy: 'octocat' }).ok).toBe(true);
    expect(validateProposalSummary({ ...open, status: 'deployed', mergedBy: 'octocat[bot]' }).ok).toBe(true);
    // GitHub may not name who merged (`merged_by: null`): a merge with no login is still a merge.
    expect(validateProposalSummary({ ...open, status: 'merged', mergedBy: null }).ok).toBe(true);
    expect(validateProposalSummary({ ...open, status: 'deployed', mergedBy: null }).ok).toBe(true);
    expect(validateProposalSummary({ ...open, status: 'rejected' }).ok).toBe(true);
    expect(validateProposalSummary({ ...open, status: 'failed', failReason: 'head_changed' }).ok).toBe(true);
    expect(validateProposalSummary({ ...open, status: 'checks_failed', kind: null, prNumber: null, prUrl: null, failReason: 'revert_conflict', aiFailReason: 'size' }).ok).toBe(true);
  });

  it('refuses a status without what it needs, and a field the status cannot have', () => {
    const bad = [
      { ...open, prUrl: null },
      { ...open, prUrl: 'https://example.com/x/y/pull/12' },
      { ...open, prUrl: 'https://github.com/a/b/pull/13' },
      { ...open, prUrl: 'http://github.com/a/b/pull/12' },
      { ...open, mergedBy: 'octocat' },
      { ...open, status: 'drafting', kind: null, prNumber: null, prUrl: null, mergedBy: 'octocat' },
      { ...open, status: 'failed' },
      { ...open, failReason: 'internal' },
      { ...open, status: 'drafting' },
      { ...open, kind: null },
      { ...open, kind: 'rewrite' },
      { ...open, status: 'done' },
      { ...open, attempt: 0 },
      { ...open, checks: [{ name: 'shell', ok: true }] },
      { ...open, extra: 1 },
      { ...open, status: 'merged', mergedBy: '<script>' },
    ];
    for (const b of bad) expect(validateProposalSummary(b).ok, JSON.stringify(b)).toBe(false);
    for (const x of [null, undefined, 1, 'x', [], {}]) expect(validateProposalSummary(x).ok).toBe(false);
  });

  it('accepts a view and checks its extra fields', () => {
    const view: ProposalView = {
      ...open,
      aiFailDetail: null,
      service: 'payments',
      credits: 0.9,
      creditsEstimated: false,
      createdAt: '2026-11-14T09:59:00.000Z',
      openedAt: '2026-11-14T10:00:00.000Z',
      mergedAt: null,
      deployedAt: null,
    };
    expect(validateProposalView(view).ok).toBe(true);
    expect(validateProposalView({ ...view, credits: -1 }).ok).toBe(false);
    expect(validateProposalView({ ...view, deployedAt: view.createdAt }).ok).toBe(false);
    expect(validateProposalView({ ...view, service: 'nginx' }).ok).toBe(false);
  });
  it('shows why the Fixer run was not used: aiFailDetail is one short line with no path and no token (task 22)', () => {
    const view: ProposalView = {
      ...open,
      status: 'drafting',
      kind: null,
      prNumber: null,
      prUrl: null,
      aiFailReason: 'agent_failed',
      aiFailDetail: 'fixer_not_started: Error: parentEnv is required in tests',
      service: 'payments',
      credits: 0,
      creditsEstimated: false,
      createdAt: '2026-11-14T09:59:00.000Z',
      openedAt: null,
      mergedAt: null,
      deployedAt: null,
    };
    expect(validateProposalView(view).ok).toBe(true);
    for (const detail of ['foreign_tool: Tool Call tool_id=tool::builtin::fs_read', 'write_outside_scope: fs_write outside services/payments/src/ kind=edit keys=[command,path]', 'step_error: Error: spawn kiro-cli ENOENT [path]']) {
      expect(validateProposalView({ ...view, aiFailDetail: detail }).ok, detail).toBe(true);
    }
    const bad = [
      '',
      'x'.repeat(301),
      'two\nlines',
      'step_error: ENOENT /var/folders/ab/cd',
      'step_error: open /etc/passwd failed',
      'token github_pat_AAAAAAAAAAAAAAAAAAAAAAAA',
      'a'.repeat(40),
      'https://user:secret@example.com/x',
      5,
    ];
    for (const detail of bad) expect(validateProposalView({ ...view, aiFailDetail: detail }).ok, String(detail)).toBe(false);
    expect(validateProposalView({ ...view, aiFailDetail: undefined }).ok).toBe(false);
  });
  it('scrubs a detail so that it always passes: absolute paths and token-like text are replaced, the length is capped', () => {
    expect(scrubAiFailDetail('step_error: ENOENT, open /var/folders/ab/cd/file.txt and /etc/hosts')).toBe('step_error: ENOENT, open [path] and [path]');
    expect(scrubAiFailDetail('a/b and c/d stay, and https://github.com/x/y too')).toBe('a/b and c/d stay, and https://github.com/x/y too');
    expect(scrubAiFailDetail('Bearer abcdef123456 github_pat_ABCDEFGHIJKLMNOP')).toBe('[redacted] [redacted]');
    expect(scrubAiFailDetail('line one\nline two\u0007')).toBe('line one line two');
    fc.assert(
      fc.property(fc.string({ maxLength: 600 }), (text) => {
        const out = scrubAiFailDetail(text);
        expect(out.length).toBeLessThanOrEqual(300);
        const checked: string[] = [];
        checkAiFailDetail(out, '$', checked);
        // An empty result is not a detail (the store shows null for it); anything else passes the check.
        expect(checked.length === 0 || out === '', text).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it('is a valid field of a Service state and refused when malformed', () => {
    fc.assert(fc.property(serviceStateArb, (s) => validateServiceState(s).ok), { numRuns: 100 });
    fc.assert(fc.property(proposalSummaryArb, (p) => validateProposalSummary(p).ok), { numRuns: 200 });
  });
});

describe('a skipped tests check', () => {
  const skipped = { name: 'tests', ok: true, skipped: true, detail: 'no sandbox-green tests for orders' } as const;
  it('is accepted only on tests, with ok true and the fixed detail', () => {
    expect(validateProposalSummary({ ...open, checks: [{ name: 'scope', ok: true }, skipped] }).ok).toBe(true);
    expect(testsSkippedDetail('orders')).toBe(skipped.detail);
    for (const bad of [
      { ...skipped, name: 'size' },
      { ...skipped, ok: false },
      { ...skipped, skipped: false },
      { ...skipped, detail: 'anything else' },
      { name: 'tests', ok: true, skipped: true },
      { name: 'tests', ok: true, detail: skipped.detail },
    ]) {
      expect(validateProposalSummary({ ...open, checks: [bad] }).ok, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('proposal events', () => {
  it('has a validator for each of the seven events, and a valid sample of each is accepted', () => {
    expect([...PROPOSAL_EVENT_NAMES]).toHaveLength(7);
    for (const name of PROPOSAL_EVENT_NAMES) {
      fc.assert(
        fc.property(payloadArbs[name] as fc.Arbitrary<never>, (payload) => {
          expect(validateProposalEvent(name, payload).ok).toBe(true);
          expect(validateSseEvent(name, payload).ok).toBe(true);
        }),
        { numRuns: 50 },
      );
    }
  });

  it('refuses a payload with an unknown key, a bad URL or a bad login', () => {
    const merged = { proposalId: ID, huntId: HUNT, service: 'payments', mergedBy: 'octocat', at: '2026-11-14T10:00:00.000Z' };
    expect(validateProposalEvent('proposal.merged', merged).ok).toBe(true);
    expect(validateProposalEvent('proposal.merged', { ...merged, mergedBy: null }).ok).toBe(true);
    expect(validateProposalEvent('proposal.merged', { ...merged, mergedBy: '@octocat' }).ok).toBe(false);
    expect(validateProposalEvent('proposal.merged', { ...merged, token: 'x' }).ok).toBe(false);
    const opened = { proposalId: ID, huntId: HUNT, service: 'payments', kind: 'revert', prNumber: 3, prUrl: 'https://github.com/a/b/pull/3', at: merged.at };
    expect(validateProposalEvent('proposal.opened', opened).ok).toBe(true);
    expect(validateProposalEvent('proposal.opened', { ...opened, prUrl: 'https://evil.example/a/b/pull/3' }).ok).toBe(false);
    expect(validateProposalEvent('proposal.failed', { proposalId: ID, huntId: HUNT, service: 'payments', status: 'failed', failReason: 'because', at: merged.at }).ok).toBe(false);
  });
});

describe('the status graph', () => {
  it('moves only forward along the documented edges', () => {
    expect(PROPOSAL_EDGES.drafting).toEqual(['open', 'checks_failed', 'failed']);
    expect(PROPOSAL_EDGES.open).toEqual(['merged', 'rejected', 'failed']);
    expect(PROPOSAL_EDGES.merged).toEqual(['deployed', 'failed']);
    for (const s of ['checks_failed', 'deployed', 'rejected', 'failed'] as const) {
      expect(isFinalProposalStatus(s)).toBe(true);
      for (const t of PROPOSAL_STATUSES) expect(canMove(s, t)).toBe(false);
    }
    for (const s of PROPOSAL_STATUSES) expect(canMove(s, s)).toBe(false);
    expect(PROPOSAL_STATUSES.filter(isActiveProposalStatus)).toEqual(['drafting', 'open', 'merged']);
  });
});

describe('branch names', () => {
  it('are built only from a valid CUID', () => {
    fc.assert(
      fc.property(cuidArb, (id) => {
        expect(incidentBranch(id)).toBe(`incident/${id}`);
        expect(fixBranch(id)).toBe(`exorcist/${id}`);
      }),
      { numRuns: 100 },
    );
    for (const bad of ['', 'main', '../x', 'a b', 'ABCDEFGHIJKLMNOPQRSTUVWXY', 'x'.repeat(40), 'a'.repeat(19), '-aaaaaaaaaaaaaaaaaaaaaaaa/x', 'cmhunt\naaaaaaaaaaaaaaaaaaa']) {
      expect(() => incidentBranch(bad), bad).toThrow();
      expect(() => fixBranch(bad), bad).toThrow();
    }
    expect(CUID_PATTERN.test(HUNT)).toBe(true);
  });
});
