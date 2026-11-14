import { describe, expect, it } from 'vitest';
import type { ProposalSummary, ServiceState } from '@haunted-ops/shared';
import { huntIdFromPath } from '../App.js';
import { proposalSentences } from '../components/LiveAnnouncer.js';
import { applyLiveEvent, applyProposalEvent, type LiveState } from './live-state.js';

const P1 = 'cmproposalaaaaaaaaaaaaaa1';
const P2 = 'cmproposalaaaaaaaaaaaaaa2';
const H1 = 'cmhuntaaaaaaaaaaaaaaaaaa1';
const at = (s: number): string => new Date(Date.UTC(2026, 10, 14, 10, 0, s)).toISOString();
const base = { huntId: H1, service: 'payments' as const };
const started = (proposalId: string, attempt: number, s = 0) => ({ ...base, proposalId, attempt, at: at(s) });

function walk(): ProposalSummary | null {
  let p = applyProposalEvent(null, 'proposal.started', started(P1, 1));
  p = applyProposalEvent(p, 'proposal.checks', { ...base, proposalId: P1, kind: 'revert', checks: [{ name: 'tests', ok: true }], aiFailReason: 'tests_failed', at: at(1) });
  p = applyProposalEvent(p, 'proposal.opened', { ...base, proposalId: P1, kind: 'revert', prNumber: 4, prUrl: 'https://github.com/example/haunted-lab/pull/4', at: at(2) });
  return p;
}

describe('applyProposalEvent', () => {
  it('follows started, checks, opened, merged and deployed', () => {
    const open = walk();
    expect(open).toMatchObject({ id: P1, status: 'open', kind: 'revert', prNumber: 4, aiFailReason: 'tests_failed', checks: [{ name: 'tests', ok: true }] });
    const merged = applyProposalEvent(open, 'proposal.merged', { ...base, proposalId: P1, mergedBy: 'octocat', at: at(3) });
    expect(merged).toMatchObject({ status: 'merged', mergedBy: 'octocat' });
    expect(applyProposalEvent(merged, 'proposal.deployed', { ...base, proposalId: P1, at: at(4) })).toMatchObject({ status: 'deployed' });
  });

  it('ignores another Proposal, a replayed event and a move the graph does not allow', () => {
    const open = walk();
    expect(applyProposalEvent(open, 'proposal.merged', { ...base, proposalId: P2, mergedBy: 'octocat', at: at(3) })).toBe(open);
    expect(applyProposalEvent(open, 'proposal.opened', { ...base, proposalId: P1, kind: 'revert', prNumber: 4, prUrl: 'https://github.com/example/haunted-lab/pull/4', at: at(2) })).toBe(open);
    expect(applyProposalEvent(open, 'proposal.deployed', { ...base, proposalId: P1, at: at(4) })).toBe(open);
    expect(applyProposalEvent(open, 'proposal.started', started(P1, 1))).toBe(open);
    // An older attempt of the same Hunt never replaces the current one; a newer one does.
    expect(applyProposalEvent(open, 'proposal.started', started(P2, 1))).toBe(open);
    expect(applyProposalEvent(open, 'proposal.started', started(P2, 2, 9))).toMatchObject({ id: P2, attempt: 2, status: 'drafting' });
  });

  it('ends failed or checks_failed with the reason', () => {
    const drafting = applyProposalEvent(null, 'proposal.started', started(P1, 1));
    expect(applyProposalEvent(drafting, 'proposal.failed', { ...base, proposalId: P1, status: 'checks_failed', failReason: 'revert_conflict', at: at(5) })).toMatchObject({
      status: 'checks_failed',
      failReason: 'revert_conflict',
    });
  });

  it('updates the Service in the live state, and nothing else', () => {
    const service = { name: 'payments', proposal: null, room: { x: 0, y: 0 } } as unknown as ServiceState;
    const state: LiveState = { services: [service], ingest: null };
    const next = applyLiveEvent(state, 'proposal.started', started(P1, 1));
    expect(next.services[0]?.proposal).toMatchObject({ id: P1, status: 'drafting' });
    expect(applyLiveEvent(next, 'proposal.started', started(P1, 1))).toBe(next);
    expect(applyLiveEvent(state, 'proposal.started', { ...started(P1, 1), service: 'ledger' })).toBe(state);
  });
});

describe('proposalSentences', () => {
  it('says one short sentence per status change, nothing on first sight or for the same state', () => {
    const svc = (proposal: ProposalSummary | null) => ({ name: 'payments', proposal }) as unknown as ServiceState;
    const open = walk();
    expect(proposalSentences(new Map(), [svc(open)])).toEqual([]);
    expect(proposalSentences(new Map([['payments', open]]), [svc(open)])).toEqual([]);
    expect(proposalSentences(new Map([['payments', null]]), [svc(open)])).toEqual(['Pull request 4 open on payments, revert.']);
    const merged = applyProposalEvent(open, 'proposal.merged', { ...base, proposalId: P1, mergedBy: 'octocat', at: at(3) });
    expect(proposalSentences(new Map([['payments', open]]), [svc(merged)])).toEqual(['Fix merged on payments by octocat.']);
  });
});

describe('huntIdFromPath', () => {
  it('takes the id of a /hunts/<id> link and nothing else', () => {
    expect(huntIdFromPath(`/hunts/${H1}`)).toBe(H1);
    expect(huntIdFromPath(`/hunts/${H1}/`)).toBe(H1);
    expect(huntIdFromPath('/')).toBeNull();
    expect(huntIdFromPath('/hunts/NOT-AN-ID')).toBeNull();
    expect(huntIdFromPath(`/hunts/${H1}/../x`)).toBeNull();
  });
});
