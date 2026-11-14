import { PROPOSAL_BRANCH_PATTERN, isFinalProposalStatus, type ProposalStatus } from '@haunted-ops/shared';
import type { JsonLogger } from '../security/logger.js';
import type { GithubClient } from './github-client.js';
import { errorCodeOf } from './proposal-error.js';
import type { ProposalRecord, ProposalStore } from './proposal-store.js';

export const CLEANUP_EVERY_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** The hunt id of a proposal branch name, or null for any other name. */
export function huntIdOfBranch(name: string): string | null {
  return PROPOSAL_BRANCH_PATTERN.test(name) ? (name.split('/')[1] as string) : null;
}

export interface CleanupFacts {
  /** Every branch of the two proposal prefixes, with the commit it points at. */
  branches: ReadonlyArray<{ name: string; sha: string }>;
  /** Head and base of every open pull request. */
  openPulls: ReadonlyArray<{ head: string; base: string }>;
  /** The latest Proposal of each Hunt that has one: its status and when it was created. */
  proposals: ReadonlyMap<string, { status: ProposalStatus; createdAt: Date }>;
  /** The date of the commit of a branch, for a branch whose Hunt has no Proposal row. */
  commitDates: ReadonlyMap<string, Date>;
  now: Date;
  ttlDays: number;
}

/**
 * Which branches the cleanup deletes: a name that is exactly `incident/<cuid>` or `exorcist/<cuid>` (so `main`, every
 * `scenario/*` and every other name is never a candidate), that is the head or base of no open pull request, whose
 * Proposal is final (or does not exist), and that is older than the TTL (by the Proposal, or by the commit when there is none).
 */
export function selectBranchesToDelete(f: CleanupFacts): string[] {
  const referenced = new Set(f.openPulls.flatMap((p) => [p.head, p.base]));
  const ttl = f.ttlDays * DAY_MS;
  const out: string[] = [];
  for (const b of f.branches) {
    const huntId = huntIdOfBranch(b.name);
    if (huntId === null || referenced.has(b.name)) continue;
    const proposal = f.proposals.get(huntId);
    if (proposal !== undefined && !isFinalProposalStatus(proposal.status)) continue;
    const born = proposal?.createdAt ?? f.commitDates.get(b.sha);
    if (born === undefined || f.now.getTime() - born.getTime() <= ttl) continue;
    out.push(b.name);
  }
  return out;
}

export interface CleanupDeps {
  github: Pick<GithubClient, 'listProposalBranches' | 'listOpenPullRefs' | 'commitDate' | 'deleteBranch'>;
  proposals: Pick<ProposalStore, 'latestOfHunts'>;
  ttlDays: number;
  logger: JsonLogger;
  now?: () => Date;
}

export interface CleanupResult {
  listed: number;
  deleted: number;
  failed: number;
}

/** One pass: list, decide, delete one branch at a time. An error on one branch does not stop the others. Only counts are logged. */
export async function runBranchCleanup(d: CleanupDeps): Promise<CleanupResult> {
  const now = (d.now ?? (() => new Date()))();
  const branches = await d.github.listProposalBranches();
  const openPulls = await d.github.listOpenPullRefs();
  const huntIds = [...new Set(branches.flatMap((b) => huntIdOfBranch(b.name) ?? []))];
  const rows: Map<string, ProposalRecord> = await d.proposals.latestOfHunts(huntIds);
  const proposals = new Map([...rows].map(([id, r]) => [id, { status: r.status, createdAt: r.createdAt }]));
  const commitDates = new Map<string, Date>();
  for (const b of branches) {
    const id = huntIdOfBranch(b.name);
    if (id === null || proposals.has(id) || commitDates.has(b.sha)) continue;
    try {
      commitDates.set(b.sha, await d.github.commitDate(b.sha));
    } catch {
      // Unknown age: the branch stays.
    }
  }
  const doomed = selectBranchesToDelete({ branches, openPulls, proposals, commitDates, now, ttlDays: d.ttlDays });
  let deleted = 0;
  let failed = 0;
  for (const name of doomed) {
    try {
      await d.github.deleteBranch(name);
      deleted++;
    } catch (err) {
      failed++;
      d.logger.log('warn', 'branch cleanup failed', { code: errorCodeOf(err) });
    }
  }
  d.logger.log('info', 'branch cleanup', { listed: branches.length, deleted, failed });
  return { listed: branches.length, deleted, failed };
}

/** Runs the cleanup at start and every hour. A failed pass is logged by code and tried again at the next hour. */
export class BranchCleanup {
  private timer: NodeJS.Timeout | null = null;
  /** The pass in flight: a tick while one runs is skipped, and `stop` waits for it. */
  private current: Promise<void> | null = null;
  private stopped = false;

  constructor(private readonly deps: CleanupDeps) {}

  start(everyMs: number = CLEANUP_EVERY_MS): void {
    this.stopped = false;
    const pass = (): void => {
      if (this.stopped || this.current !== null) return;
      this.current = this.run()
        .then(() => undefined)
        .catch((err: unknown) => this.deps.logger.log('warn', 'branch cleanup failed', { code: errorCodeOf(err) }))
        .finally(() => {
          this.current = null;
        });
    };
    pass();
    this.timer = setInterval(pass, everyMs);
    this.timer.unref();
  }

  run(): Promise<CleanupResult> {
    return runBranchCleanup(this.deps);
  }

  /** Stops the timer and waits for a pass in flight, so nothing runs or logs after it returns. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    await this.current;
  }
}
