import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { PROPOSAL_STATUSES, canMove, isActiveProposalStatus, validateProposalSummary, validateProposalView, type ProposalStatus } from '@haunted-ops/shared';
import { MemoryProposalStore } from '../../test/support/fix.js';
import { toProposalSummary, toProposalView, type ProposalPatch } from './proposal-store.js';

const HUNT = 'cmhuntaaaaaaaaaaaaaaaaaaa';
const NOW = new Date('2026-11-14T10:00:00.000Z');
const status = fc.constantFrom(...PROPOSAL_STATUSES);

/** Enough data for a status to pass the summary rules, so the store output can be validated at every step. */
const PATCH_FOR: Partial<Record<ProposalStatus, ProposalPatch>> = {
  open: { kind: 'ai_patch', prNumber: 4, prUrl: 'https://github.com/o/r/pull/4' },
  merged: { mergedBy: 'octocat', mergeSha: 'a'.repeat(40) },
  failed: { failReason: 'internal' },
  checks_failed: { failReason: 'checks_failed' },
};

// Feature: fix-proposal-flow, Property 5: a proposal status only moves forward along the graph
describe('Property 5: a proposal status only moves forward along the graph', () => {
  it('accepts a move exactly when it is an edge from the current status, and a stale writer changes nothing', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.tuple(status, status), { minLength: 1, maxLength: 12 }), async (requests) => {
        const store = new MemoryProposalStore(() => NOW);
        const rec = await store.create(HUNT, NOW);
        expect(rec).not.toBeNull();
        const id = (rec as { id: string }).id;
        let current: ProposalStatus = 'drafting';
        for (const [from, to] of requests) {
          const before = JSON.stringify(await store.byId(id));
          const applied = await store.move(id, from, to, PATCH_FOR[to]);
          const expected = from === current && canMove(from, to);
          expect(applied).toBe(expected);
          const after = await store.byId(id);
          if (expected) {
            current = to;
            expect(after?.status).toBe(to);
          } else {
            // A rejected move changes nothing, the patch included.
            expect(JSON.stringify(after)).toBe(before);
          }
        }
        // The recorded moves are a path of edges from `drafting`.
        let at: ProposalStatus = 'drafting';
        for (const m of store.moves) {
          expect(m.from).toBe(at);
          expect(canMove(m.from, m.to)).toBe(true);
          at = m.to;
        }
      }),
      { numRuns: 200 },
    );
  });

  it('never leaves a final status', async () => {
    const store = new MemoryProposalStore(() => NOW);
    const rec = (await store.create(HUNT, NOW)) as { id: string };
    expect(await store.move(rec.id, 'drafting', 'failed', { failReason: 'internal' })).toBe(true);
    for (const to of PROPOSAL_STATUSES) expect(await store.move(rec.id, 'failed', to, PATCH_FOR[to])).toBe(false);
    expect((await store.byId(rec.id))?.status).toBe('failed');
  });

  it('keeps one active Proposal per Hunt, and a retry is the next attempt', async () => {
    const store = new MemoryProposalStore(() => NOW);
    const a = (await store.create(HUNT, NOW)) as { id: string; attempt: number };
    expect(await store.create(HUNT, NOW)).toBeNull();
    await store.move(a.id, 'drafting', 'open', PATCH_FOR.open);
    expect(await store.create(HUNT, NOW)).toBeNull();
    await store.move(a.id, 'open', 'merged', PATCH_FOR.merged);
    expect(await store.create(HUNT, NOW)).toBeNull();
    await store.move(a.id, 'merged', 'failed', PATCH_FOR.failed);
    const b = await store.create(HUNT, NOW);
    expect(b).toMatchObject({ attempt: 2, status: 'drafting' });
    expect([a.attempt, b?.attempt]).toEqual([1, 2]);
    expect((await store.latestOfHunt(HUNT))?.attempt).toBe(2);
    expect(PROPOSAL_STATUSES.filter(isActiveProposalStatus)).toEqual(['drafting', 'open', 'merged']);
  });

  it('shows a consistent summary and view at every status', async () => {
    const store = new MemoryProposalStore(() => NOW);
    const rec = (await store.create(HUNT, NOW)) as { id: string };
    const check = async (): Promise<void> => {
      const r = await store.byId(rec.id);
      expect(validateProposalSummary(toProposalSummary(r as never)).ok).toBe(true);
      expect(toProposalView(r as never).service).toBe('payments');
    };
    await check();
    await store.move(rec.id, 'drafting', 'open', PATCH_FOR.open);
    await check();
    await store.move(rec.id, 'open', 'merged', PATCH_FOR.merged);
    await check();
    await store.move(rec.id, 'merged', 'deployed', { deployedAt: NOW });
    await check();
  });
});

// Feature: fix-proposal-flow, Property 20: the view shows the halt detail only scrubbed
describe('Property 20: the view of a Proposal shows aiFailDetail scrubbed, whatever the stored text is', () => {
  it('always gives a view that passes the validator, with no absolute path and no token-like text', async () => {
    const store = new MemoryProposalStore(() => NOW);
    const rec = (await store.create(HUNT, NOW)) as { id: string };
    await fc.assert(
      fc.asyncProperty(fc.oneof(fc.string({ maxLength: 500 }), fc.constantFrom('step_error: Error: ENOENT /var/x/y github_pat_AAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'agent_changed: changed at permissions.rules[5].capability')), async (detail) => {
        await store.patch(rec.id, 'drafting', { aiFailDetail: detail });
        const view = toProposalView((await store.byId(rec.id)) as never);
        expect(validateProposalView(view).ok, JSON.stringify(detail)).toBe(true);
        if (view.aiFailDetail !== null) {
          expect(view.aiFailDetail.length).toBeLessThanOrEqual(300);
          expect(view.aiFailDetail).not.toContain('/var/x');
          expect(view.aiFailDetail).not.toContain('github_pat_AAAA');
        }
      }),
      { numRuns: 300 },
    );
    await store.patch(rec.id, 'drafting', { aiFailDetail: null });
    expect(toProposalView((await store.byId(rec.id)) as never).aiFailDetail).toBeNull();
  });
});
