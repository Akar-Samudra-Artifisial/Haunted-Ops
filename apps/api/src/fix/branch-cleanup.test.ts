import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { PROPOSAL_STATUSES, isFinalProposalStatus, type ProposalStatus } from '@haunted-ops/shared';
import { startFakeGithub } from '../../../../tools/fake-kiro-cli/fake-github.mjs';
import { JsonLogger } from '../security/logger.js';
import { MemoryProposalStore, DUMMY_GITHUB_TOKEN } from '../../test/support/fix.js';
import { BranchCleanup, huntIdOfBranch, runBranchCleanup, selectBranchesToDelete, type CleanupFacts } from './branch-cleanup.js';
import { GithubClient } from './github-client.js';

const NOW = new Date('2026-11-20T10:00:00.000Z');
const DAY = 86_400_000;
const ID = (n: number): string => `cmhunt${String(n).padStart(19, '0')}`;
const sha = (n: number): string => String(n).padStart(40, '0');
const ago = (days: number): Date => new Date(NOW.getTime() - days * DAY);

// Feature: fix-proposal-flow, Property 10: cleanup deletes only old, final, unreferenced proposal branches
describe('Property 10: cleanup deletes only old, final, unreferenced proposal branches', () => {
  const prefix = fc.constantFrom('incident', 'exorcist');
  const name = fc.oneof(
    fc.tuple(prefix, fc.integer({ min: 1, max: 6 })).map(([p, n]) => `${p}/${ID(n)}`),
    fc.constantFrom('main', 'scenario/error-spike', 'scenario/fog', 'incident/short', `incident/${ID(1)}/x`, `other/${ID(1)}`, `exorcist/${ID(1).toUpperCase()}`, 'incident/', 'release/1.0'),
  );
  const branches = fc.array(fc.tuple(name, fc.integer({ min: 1, max: 6 })), { maxLength: 12 }).map((xs) => {
    const seen = new Set<string>();
    return xs.filter(([n]) => !seen.has(n) && seen.add(n)).map(([n, s]) => ({ name: n, sha: sha(s) }));
  });
  const facts: fc.Arbitrary<CleanupFacts> = fc.record({
    branches,
    openPulls: fc.array(fc.record({ head: name, base: name }), { maxLength: 3 }),
    proposals: fc
      .array(fc.tuple(fc.integer({ min: 1, max: 6 }), fc.constantFrom(...PROPOSAL_STATUSES), fc.integer({ min: 0, max: 20 })), { maxLength: 6 })
      .map((xs) => new Map(xs.map(([n, status, days]) => [ID(n), { status, createdAt: ago(days) }] as const))),
    commitDates: fc.array(fc.tuple(fc.integer({ min: 1, max: 6 }), fc.integer({ min: 0, max: 20 })), { maxLength: 6 }).map((xs) => new Map(xs.map(([n, days]) => [sha(n), ago(days)] as const))),
    now: fc.constant(NOW),
    ttlDays: fc.integer({ min: 1, max: 14 }),
  });

  it('holds for any branches, pull requests, Proposals and clock', () => {
    fc.assert(
      fc.property(facts, (f) => {
        const out = selectBranchesToDelete(f);
        const open = new Set(f.openPulls.flatMap((p) => [p.head, p.base]));
        for (const b of out) {
          // Only the two exact name forms: never main, a scenario branch or any other name.
          expect(/^(incident|exorcist)\/[a-z0-9]{20,32}$/.test(b), b).toBe(true);
          expect(b === 'main' || b.startsWith('scenario/')).toBe(false);
          expect(open.has(b), b).toBe(false);
          const id = huntIdOfBranch(b) as string;
          const proposal = f.proposals.get(id);
          if (proposal !== undefined) expect(isFinalProposalStatus(proposal.status as ProposalStatus), b).toBe(true);
          const sha1 = f.branches.find((x) => x.name === b)?.sha as string;
          const born = proposal?.createdAt ?? f.commitDates.get(sha1);
          expect(born).toBeDefined();
          expect(NOW.getTime() - (born as Date).getTime()).toBeGreaterThan(f.ttlDays * DAY);
        }
        // And it deletes every branch that meets all four conditions.
        for (const b of f.branches) {
          const id = huntIdOfBranch(b.name);
          if (id === null || open.has(b.name)) continue;
          const proposal = f.proposals.get(id);
          if (proposal !== undefined && !isFinalProposalStatus(proposal.status as ProposalStatus)) continue;
          const born = proposal?.createdAt ?? f.commitDates.get(b.sha);
          if (born !== undefined && NOW.getTime() - born.getTime() > f.ttlDays * DAY) expect(out).toContain(b.name);
        }
      }),
      { numRuns: 500 },
    );
  });
});

describe('selectBranchesToDelete', () => {
  const base: Omit<CleanupFacts, 'branches' | 'proposals'> = { openPulls: [], commitDates: new Map(), now: NOW, ttlDays: 7 };
  const b = (n: number, p = 'incident'): { name: string; sha: string } => ({ name: `${p}/${ID(n)}`, sha: sha(n) });

  it('deletes the old branches of a final Proposal and keeps young ones, open ones and moving ones', () => {
    const proposals = new Map<string, { status: ProposalStatus; createdAt: Date }>([
      [ID(1), { status: 'deployed', createdAt: ago(8) }],
      [ID(2), { status: 'rejected', createdAt: ago(3) }],
      [ID(3), { status: 'open', createdAt: ago(30) }],
      [ID(4), { status: 'failed', createdAt: ago(9) }],
      [ID(5), { status: 'merged', createdAt: ago(30) }],
    ]);
    const branches = [b(1), b(1, 'exorcist'), b(2), b(3), b(4), b(5)];
    const out = selectBranchesToDelete({ ...base, branches, proposals, openPulls: [{ head: `exorcist/${ID(4)}`, base: `incident/${ID(4)}` }] });
    expect(out).toEqual([`incident/${ID(1)}`, `exorcist/${ID(1)}`]);
  });

  it('uses the age of the commit for a branch with no Proposal, and keeps a branch of unknown age', () => {
    const out = selectBranchesToDelete({ ...base, branches: [b(7), b(8), b(9)], proposals: new Map(), commitDates: new Map([[sha(7), ago(10)], [sha(8), ago(1)]]) });
    expect(out).toEqual([`incident/${ID(7)}`]);
  });

  it('never selects main, a scenario branch or any name of another form', () => {
    const odd = ['main', 'scenario/error-spike', 'incident/x', `incident/${ID(1)}/y`, `feature/${ID(1)}`].map((name) => ({ name, sha: sha(1) }));
    expect(selectBranchesToDelete({ ...base, branches: odd, proposals: new Map(), commitDates: new Map([[sha(1), ago(100)]]) })).toEqual([]);
  });
});

describe('runBranchCleanup (fake GitHub)', () => {
  const REPO = 'Akar-Samudra-Artifisial/Haunted-Lab';

  async function rig() {
    const fake = await startFakeGithub({ repo: REPO, token: DUMMY_GITHUB_TOKEN });
    const github = new GithubClient({ token: DUMMY_GITHUB_TOKEN, repo: REPO, baseUrl: fake.url, sleep: async () => undefined });
    const store = new MemoryProposalStore(() => ago(10));
    const lines: string[] = [];
    const logger = new JsonLogger((l) => lines.push(l), () => NOW);
    return { fake, github, store, lines, logger };
  }

  it('deletes old branches of final Proposals one at a time, spares everything else, and logs only counts', async () => {
    const { fake, github, store, lines, logger } = await rig();
    for (const n of [1, 2, 3, 4]) for (const p of ['incident', 'exorcist']) fake.refs.set(`${p}/${ID(n)}`, sha(n));
    fake.refs.set('main', sha(90));
    fake.refs.set('scenario/error-spike', sha(91));
    // 1: deployed, old. 2: open (moving). 3: failed but has an open pull request. 4: no Proposal, old commit.
    const p1 = await store.create(ID(1), NOW);
    await store.move((p1 as { id: string }).id, 'drafting', 'failed', { failReason: 'internal' });
    await store.create(ID(2), NOW);
    const p3 = await store.create(ID(3), NOW);
    await store.move((p3 as { id: string }).id, 'drafting', 'failed', { failReason: 'internal' });
    fake.pulls.push({ number: 1, title: 't', body: '', head: `exorcist/${ID(3)}`, base: `incident/${ID(3)}`, labels: [], state: 'open', merged: false, mergeSha: null, mergedBy: null, headSha: sha(3), version: 1 });
    fake.commitDates.set(sha(4), ago(20).toISOString());
    const out = await runBranchCleanup({ github, proposals: store, ttlDays: 7, logger, now: () => NOW });
    expect(out).toEqual({ listed: 8, deleted: 4, failed: 0 });
    expect([...fake.refs.keys()].sort()).toEqual(['main', `exorcist/${ID(2)}`, `exorcist/${ID(3)}`, `incident/${ID(2)}`, `incident/${ID(3)}`, 'scenario/error-spike'].sort());
    const deletes = fake.requests.filter((r) => r.method === 'DELETE').map((r) => r.path);
    expect(deletes.every((p) => /\/git\/refs\/heads\/(incident|exorcist)\/cmhunt\d+$/.test(p))).toBe(true);
    expect(deletes).toHaveLength(4);
    // Only counts are logged, never a branch name.
    const text = lines.join('');
    expect(text).toContain('"deleted":4');
    expect(text).not.toContain('cmhunt');
    await fake.close();
  });

  it('survives an error on one branch and goes on with the others', async () => {
    const { fake, github, store, logger, lines } = await rig();
    for (const n of [1, 2]) fake.refs.set(`incident/${ID(n)}`, sha(n));
    for (const n of [1, 2]) fake.commitDates.set(sha(n), ago(20).toISOString());
    let first = true;
    const flaky = {
      listProposalBranches: () => github.listProposalBranches(),
      listOpenPullRefs: () => github.listOpenPullRefs(),
      commitDate: (s: string) => github.commitDate(s),
      deleteBranch: async (n: string) => {
        if (first) {
          first = false;
          throw new Error(`boom with ${DUMMY_GITHUB_TOKEN}`);
        }
        await github.deleteBranch(n);
      },
    };
    const out = await runBranchCleanup({ github: flaky, proposals: store, ttlDays: 7, logger, now: () => NOW });
    expect(out).toEqual({ listed: 2, deleted: 1, failed: 1 });
    expect(lines.join('')).not.toContain(DUMMY_GITHUB_TOKEN);
    await fake.close();
  });

  it('runs at start and on its timer, and stops', async () => {
    const { fake, github, store, logger, lines } = await rig();
    const cleanup = new BranchCleanup({ github, proposals: store, ttlDays: 7, logger, now: () => NOW });
    cleanup.start(30);
    await new Promise((r) => setTimeout(r, 200));
    await cleanup.stop();
    const passes = lines.filter((l) => l.includes('"msg":"branch cleanup"')).length;
    expect(passes).toBeGreaterThanOrEqual(2);
    await new Promise((r) => setTimeout(r, 100));
    expect(lines.filter((l) => l.includes('"msg":"branch cleanup"')).length).toBe(passes);
    await fake.close();
  });
});
