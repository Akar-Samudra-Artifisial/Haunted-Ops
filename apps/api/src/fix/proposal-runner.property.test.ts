import { execFileSync } from 'node:child_process';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { PROPOSAL_STATUSES, canMove, isFinalProposalStatus, type ProposalStatus } from '@haunted-ops/shared';
import { makeHarness, commitInLab, NOW, type Harness } from '../../test/support/fix-harness.js';
import { gitIn } from '../../test/support/lab-repo.js';
import { aiDeniedReason } from './proposal-runner.js';

const GIT_ENV = { PATH: process.env.PATH ?? '/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/dev/null' };
const remoteRefs = (h: Harness): string[] => execFileSync('git', ['-C', h.lab.remote, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads'], { encoding: 'utf8', env: GIT_ENV }).trim().split('\n');

// Feature: fix-proposal-flow, Property 9
describe('Property 9: the fixer never starts over budget or over the daily limit', () => {
  it('starts iff spent + cap fits the daily cap and the day has a start left', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 100, noNaN: true }),
        fc.integer({ min: 0, max: 80 }),
        fc.double({ min: 0.1, max: 10, noNaN: true }),
        fc.double({ min: 0.1, max: 100, noNaN: true }),
        fc.integer({ min: 1, max: 80 }),
        (spent, starts, creditCap, dailyCreditCap, dailyMax) => {
          const got = aiDeniedReason({ spent, starts, creditCap, dailyCreditCap, dailyMax });
          const fits = spent + creditCap <= dailyCreditCap;
          expect(got === null).toBe(fits && starts < dailyMax);
          if (!fits) expect(got).toBe('budget');
          else if (starts >= dailyMax) expect(got).toBe('daily_limit');
        },
      ),
      { numRuns: 500 },
    );
  });
});

// Feature: fix-proposal-flow, Property 7
describe('Property 7: the kind follows the checks, and a failing candidate is never proposed', () => {
  const GOOD = ['fixer-good', 'fixer-wrapped'];
  const BAD: Record<string, string> = {
    'fixer-big': 'size',
    'fixer-scope': 'scope',
    'fixer-forbidden': 'forbidden_file',
    'fixer-delete-test': 'forbidden_file',
    'fixer-symlink': 'forbidden_file',
    'fixer-no-change': 'scope',
    'fixer-breaks-tests': 'tests_failed',
    'fixer-syntax': 'tests_failed',
    'fixer-foreign-tool': 'agent_failed',
    'fixer-path-escape': 'agent_failed',
    'fixer-fail-exit': 'agent_failed',
  };
  const REVERT = {
    ok: { status: 'open', failReason: null },
    conflict: { status: 'checks_failed', failReason: 'revert_conflict' },
    unavailable: { status: 'checks_failed', failReason: 'revert_unavailable' },
  } as const;

  it('opens ai_patch iff the patch passed, revert iff it was not used and the revert passed, and nothing otherwise', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...GOOD, ...Object.keys(BAD)), fc.constantFrom('ok', 'conflict', 'unavailable' as const), async (fixture, mode) => {
        const h = await makeHarness({ fixture });
        try {
          let culprit = h.lab.culprit;
          if (mode === 'conflict') {
            gitIn(h.lab.work, ['checkout', '--quiet', '-b', 'scenario/conflict', h.lab.culprit]);
            const d = commitInLab(h, 'services/payments/src/charge.js', 'export const changed = true;\n', 'rewrite charge');
            execFileSync('git', ['-C', h.lab.work, 'push', '--quiet', h.lab.remote, 'scenario/conflict'], { env: GIT_ENV });
            h.labApi.records.push({ id: 'd-8', service: 'payments', sha: d, time: '2026-11-14T09:30:00.000Z' });
          }
          if (mode === 'unavailable') culprit = h.lab.other;
          const hunt = h.addHunt({ culpritSha: culprit });
          const before = remoteRefs(h);
          const out = await h.runner.request(hunt.id, 'operator');
          expect(out.kind).toBe('started');
          await h.runner.idle();
          const rec = await h.store.latestOfHunt(hunt.id);
          const accepted = GOOD.includes(fixture);
          // A patch that passes is proposed whatever the revert would do; otherwise the revert decides.
          const want = accepted ? { status: 'open', kind: 'ai_patch', aiFailReason: null, failReason: null } : { status: REVERT[mode].status, kind: mode === 'ok' ? 'revert' : null, aiFailReason: BAD[fixture], failReason: REVERT[mode].failReason };
          expect(rec).toMatchObject(want);
          // At most one pull request ever, and none unless the Proposal is open.
          expect(h.fake.pulls.length).toBe(rec?.status === 'open' ? 1 : 0);
          if (rec?.status === 'checks_failed') expect(remoteRefs(h)).toEqual(before);
          // The checks stored are those of the kind that was opened, all passed.
          if (rec?.status === 'open') {
            expect(rec.checks.filter((c) => c.name !== 'touches_culprit_files').every((c) => c.ok)).toBe(true);
            expect(h.fake.pulls[0]?.labels).toEqual(['exorcist', rec.kind]);
          }
        } finally {
          await h.cleanup();
        }
      }),
      { numRuns: 14 },
    );
  }, 240_000);
});

// Feature: fix-proposal-flow, Property 14
describe('Property 14: a restart resumes what can be resumed and fails what cannot', () => {
  it('ends drafting, keeps open, continues merged, leaves the final ones, after the leftovers were reaped', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.constantFrom(...PROPOSAL_STATUSES), { minLength: 1, maxLength: 6 }), async (statuses) => {
        const order: string[] = [];
        const h = await makeHarness({ fixture: 'fixer-good', runner: { reapOrphans: async () => (order.push('reap'), 1) } });
        try {
          const ids: Array<[string, ProposalStatus]> = [];
          for (const target of statuses) {
            const rec = await h.store.create(`cmhunt${String(ids.length + 1).padStart(19, '0')}`, NOW);
            const id = (rec as { id: string }).id;
            // Walk the graph to the target status with the data each one needs.
            const path: ProposalStatus[] = target === 'drafting' ? [] : target === 'open' ? ['open'] : target === 'merged' ? ['open', 'merged'] : target === 'deployed' ? ['open', 'merged', 'deployed'] : target === 'rejected' ? ['open', 'rejected'] : [target];
            let at: ProposalStatus = 'drafting';
            for (const next of path) {
              expect(canMove(at, next)).toBe(true);
              await h.store.move(id, at, next, {
                kind: 'ai_patch',
                prNumber: 99,
                prUrl: 'https://github.com/o/r/pull/99',
                branch: 'exorcist/x',
                baseBranch: 'incident/x',
                headSha: 'a'.repeat(40),
                mergeSha: 'b'.repeat(40),
                mergedBy: 'octocat',
                baseSha: 'c'.repeat(40),
                failReason: next === 'failed' || next === 'checks_failed' ? 'internal' : undefined,
              });
              at = next;
            }
            ids.push([id, target]);
          }
          const orig = h.store.sweepDrafting.bind(h.store);
          h.store.sweepDrafting = async (now) => (order.push('sweep'), orig(now));
          await h.runner.start();
          await new Promise((r) => setTimeout(r, 120));
          expect(order.slice(0, 2)).toEqual(['reap', 'sweep']);
          for (const [id, was] of ids) {
            const now = (await h.store.byId(id))?.status as ProposalStatus;
            if (was === 'drafting') expect(now).toBe('failed');
            else if (was === 'open') expect(now).toBe('open');
            else if (was === 'merged') expect(['merged', 'deployed', 'failed']).toContain(now);
            else if (isFinalProposalStatus(was)) expect(now).toBe(was);
          }
          expect(h.store.rows.filter((r) => r.status === 'failed' && r.failReason === 'api_restart').length).toBe(statuses.filter((s) => s === 'drafting').length);
        } finally {
          await h.cleanup();
        }
      }),
      { numRuns: 12 },
    );
  }, 240_000);
});
