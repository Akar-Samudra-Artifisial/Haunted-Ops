import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  PROPOSAL_CHECK_NAMES,
  PROPOSAL_FAIL_REASONS,
  PROPOSAL_KINDS,
  AI_FAIL_REASONS,
  validateProposalSummary,
  type ProposalStatus,
  type ProposalSummary,
  type ServiceState,
} from '@haunted-ops/shared';
import { toSceneModel } from '../scene/model.js';
import { serviceStateArb } from '../test/arbs.js';
import { PROPOSAL_PHASE, proposalView } from './proposal-text.js';
import { tableRowText } from './table-model.js';

const iso = '2026-11-14T10:00:00.000Z';
const cuid = fc.stringMatching(/^[a-z0-9]{25}$/);
const login = fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9-]{0,20}$/);
const checks = fc.array(fc.record({ name: fc.constantFrom(...PROPOSAL_CHECK_NAMES), ok: fc.boolean() }), { maxLength: 8 });
/** Any URL the browser could be handed, GitHub or not. */
const anyUrl = fc.oneof(
  fc.integer({ min: 1, max: 9999 }).map((n) => `https://github.com/example/haunted-lab/pull/${n}`),
  fc.constantFrom('javascript:alert(1)', 'http://github.com/x/y/pull/1', 'https://github.com.evil.example/x/y/pull/1', 'https://example.com/pull/1'),
);

/** A consistent summary of any status, built the way the validator wants it. */
const summaryArb: fc.Arbitrary<ProposalSummary> = fc
  .record({
    id: cuid,
    huntId: cuid,
    attempt: fc.integer({ min: 1, max: 5 }),
    status: fc.constantFrom<ProposalStatus>('drafting', 'checks_failed', 'open', 'merged', 'deployed', 'rejected', 'failed'),
    kind: fc.constantFrom(...PROPOSAL_KINDS),
    prNumber: fc.integer({ min: 1, max: 9999 }),
    mergedBy: login,
    checks,
    failReason: fc.constantFrom(...PROPOSAL_FAIL_REASONS),
    aiFailReason: fc.option(fc.constantFrom(...AI_FAIL_REASONS), { nil: null }),
    withPr: fc.boolean(),
  })
  .map(({ status, kind, prNumber, mergedBy, failReason, withPr, ...rest }) => {
    const afterOpen = status === 'open' || status === 'merged' || status === 'deployed';
    const pr = afterOpen || ((status === 'rejected' || status === 'failed') && withPr);
    return {
      ...rest,
      status,
      kind: status === 'drafting' && !withPr ? null : kind,
      prNumber: pr ? prNumber : null,
      prUrl: pr ? `https://github.com/example/haunted-lab/pull/${prNumber}` : null,
      mergedBy: status === 'merged' || status === 'deployed' || (status === 'failed' && withPr) ? mergedBy : null,
      failReason: status === 'failed' || status === 'checks_failed' ? failReason : null,
      updatedAt: iso,
    };
  });

const withProposal = (s: ServiceState, p: ProposalSummary | null): ServiceState => ({ ...s, proposal: p });

// Feature: fix-proposal-flow, Property 13: the table and the scene show the same Proposal state
describe('Property 13: the table and the scene show the same Proposal state', () => {
  it('builds valid summaries', () => {
    fc.assert(
      fc.property(summaryArb, (p) => {
        expect(validateProposalSummary(p).ok).toBe(true);
      }),
    );
  });

  it('reads the table cell and the scene label through one helper, and the phase is a function of the status', () => {
    fc.assert(
      fc.property(serviceStateArb, fc.option(summaryArb, { nil: null }), fc.boolean(), (s, p, reducedMotion) => {
        const service = withProposal(s, p);
        const row = tableRowText(service);
        const room = toSceneModel([service], Date.parse(iso), { reducedMotion, quality: 'full' }).rooms[0];
        const view = proposalView(p);
        expect(row.fix).toBe(view.cell);
        if (p === null) {
          expect(room?.proposal).toBeNull();
          expect(view.phase).toBe('none');
        } else {
          expect(room?.proposal).toMatchObject({ phase: PROPOSAL_PHASE[p.status], label: row.fix });
          expect(room?.summary).toContain(row.fix);
        }
      }),
    );
  });

  it('links only to GitHub, says "merged by" only after a merge, and puts the status in words', () => {
    fc.assert(
      fc.property(summaryArb, anyUrl, (p, url) => {
        const v = proposalView({ ...p, prUrl: p.prUrl === null ? null : url });
        if (p.prUrl === null || !url.startsWith('https://github.com/')) expect(v.link).toBeNull();
        else expect(v.link?.href).toBe(url);
        const merged = p.status === 'merged' || p.status === 'deployed' || (p.status === 'failed' && p.mergedBy !== null);
        expect(v.cell.includes('merged by @')).toBe(merged);
        expect(v.cell).toContain(v.statusText);
        expect(v.sentence.length).toBeGreaterThan(0);
        expect(v.sentence.length).toBeLessThan(120);
        if (p.checks.length > 0) expect(v.checksText).toMatch(/(passed|failed)/);
      }),
    );
  });
});
