import { canMove, isActiveProposalStatus, type ProposalStatus, type ProposalSummary, type ProposalView, type ServiceName } from '@haunted-ops/shared';
import { toProposalSummary, toProposalView, type ProposalPatch, type ProposalRecord, type ProposalStore } from '../../src/fix/proposal-store.js';

export const DUMMY_GITHUB_TOKEN = 'github_pat_DUMMYdummyDUMMYdummy0123456789';

const pad = (n: number): string => String(n).padStart(19, '0');

/** The Proposal store in memory, with the same guards as the database one. */
export class MemoryProposalStore implements ProposalStore {
  readonly rows: ProposalRecord[] = [];
  /** Every write that was applied, in order, for sequence checks. */
  readonly moves: Array<{ id: string; from: ProposalStatus; to: ProposalStatus }> = [];
  private n = 0;

  constructor(
    private readonly clock: () => Date = () => new Date(),
    /** The hunted Service of a Hunt id. */
    private readonly serviceOf: (huntId: string) => ServiceName = () => 'payments',
  ) {}

  async create(huntId: string, _now: Date): Promise<ProposalRecord | null> {
    const mine = this.rows.filter((r) => r.huntId === huntId);
    if (mine.some((r) => isActiveProposalStatus(r.status))) return null;
    const at = this.clock();
    const rec: ProposalRecord = {
      id: `cmprop${pad(++this.n)}`,
      huntId,
      service: this.serviceOf(huntId),
      attempt: Math.max(0, ...mine.map((r) => r.attempt)) + 1,
      kind: null,
      status: 'drafting',
      failReason: null,
      aiFailReason: null,
      prNumber: null,
      prUrl: null,
      branch: null,
      baseBranch: null,
      baseSha: null,
      headSha: null,
      mergeSha: null,
      mergedBy: null,
      checks: [],
      patchFiles: null,
      patchLines: null,
      agentStarted: false,
      credits: 0,
      creditsEstimated: false,
      etag: null,
      createdAt: at,
      updatedAt: at,
      openedAt: null,
      mergedAt: null,
      deployedAt: null,
      finishedAt: null,
    };
    this.rows.push(rec);
    return { ...rec };
  }

  private find(id: string): ProposalRecord | undefined {
    return this.rows.find((r) => r.id === id);
  }

  async byId(id: string): Promise<ProposalRecord | null> {
    const r = this.find(id);
    return r === undefined ? null : { ...r, checks: [...r.checks] };
  }

  async latestOfHunt(huntId: string): Promise<ProposalRecord | null> {
    const mine = this.rows.filter((r) => r.huntId === huntId).sort((a, b) => b.attempt - a.attempt);
    return mine[0] === undefined ? null : { ...mine[0] };
  }

  async latestOfHunts(huntIds: readonly string[]): Promise<Map<string, ProposalRecord>> {
    const out = new Map<string, ProposalRecord>();
    for (const id of huntIds) {
      const r = await this.latestOfHunt(id);
      if (r !== null) out.set(id, r);
    }
    return out;
  }

  async listByStatus(statuses: readonly ProposalStatus[]): Promise<ProposalRecord[]> {
    return this.rows.filter((r) => statuses.includes(r.status)).map((r) => ({ ...r }));
  }

  private apply(r: ProposalRecord, patch: ProposalPatch): void {
    for (const [key, value] of Object.entries(patch)) if (value !== undefined) (r as unknown as Record<string, unknown>)[key] = value;
    r.updatedAt = this.clock();
  }

  async move(id: string, from: ProposalStatus, to: ProposalStatus, patch: ProposalPatch = {}): Promise<boolean> {
    const r = this.find(id);
    if (r === undefined || r.status !== from || !canMove(from, to)) return false;
    this.apply(r, patch);
    r.status = to;
    this.moves.push({ id, from, to });
    return true;
  }

  async patch(id: string, status: ProposalStatus, patch: ProposalPatch): Promise<boolean> {
    const r = this.find(id);
    if (r === undefined || r.status !== status) return false;
    this.apply(r, patch);
    return true;
  }

  async fixerStartsToday(now: Date): Promise<number> {
    const day = now.toISOString().slice(0, 10);
    return this.rows.filter((r) => r.agentStarted && r.createdAt.toISOString().slice(0, 10) === day).length;
  }

  async sweepDrafting(now: Date): Promise<number> {
    let n = 0;
    for (const r of this.rows) {
      if (r.status === 'drafting') {
        r.status = 'failed';
        r.failReason = 'api_restart';
        r.finishedAt = now;
        n++;
      }
    }
    return n;
  }

  async latestPerService(): Promise<Map<ServiceName, ProposalSummary>> {
    const out = new Map<ServiceName, ProposalSummary>();
    // Rows are in creation order, so the last one of a Service is its latest.
    for (const r of this.rows) out.set(r.service, toProposalSummary(r));
    return out;
  }

  async view(id: string): Promise<ProposalView | null> {
    const r = this.find(id);
    return r === undefined ? null : toProposalView(r);
  }
}
