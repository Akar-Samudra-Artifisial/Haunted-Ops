import {
  PROPOSAL_EDGES,
  canMove,
  checkProposalCheck,
  isActiveProposalStatus,
  validateServiceName,
  type AiFailReason,
  type ProposalCheck,
  type ProposalFailReason,
  type ProposalKind,
  type ProposalStatus,
  type ProposalSummary,
  type ProposalView,
  type ServiceName,
} from '@haunted-ops/shared';
import type { PrismaClient } from '../prisma/client.js';
import { utcDayStart } from '../hunts/hunt-store.js';

/** One fix for one succeeded Hunt, as the runner reads it. `service` is the hunted Service (the Room it is shown in). */
export interface ProposalRecord {
  id: string;
  huntId: string;
  service: ServiceName;
  attempt: number;
  kind: ProposalKind | null;
  status: ProposalStatus;
  failReason: ProposalFailReason | null;
  aiFailReason: AiFailReason | null;
  prNumber: number | null;
  prUrl: string | null;
  branch: string | null;
  baseBranch: string | null;
  baseSha: string | null;
  headSha: string | null;
  mergeSha: string | null;
  mergedBy: string | null;
  checks: ProposalCheck[];
  patchFiles: number | null;
  patchLines: number | null;
  agentStarted: boolean;
  credits: number;
  creditsEstimated: boolean;
  etag: string | null;
  createdAt: Date;
  updatedAt: Date;
  openedAt: Date | null;
  mergedAt: Date | null;
  deployedAt: Date | null;
  finishedAt: Date | null;
}

/** The fields a runner may change besides the status. */
export type ProposalPatch = Partial<
  Pick<
    ProposalRecord,
    | 'kind'
    | 'failReason'
    | 'aiFailReason'
    | 'prNumber'
    | 'prUrl'
    | 'branch'
    | 'baseBranch'
    | 'baseSha'
    | 'headSha'
    | 'mergeSha'
    | 'mergedBy'
    | 'checks'
    | 'patchFiles'
    | 'patchLines'
    | 'agentStarted'
    | 'credits'
    | 'creditsEstimated'
    | 'etag'
    | 'openedAt'
    | 'mergedAt'
    | 'deployedAt'
    | 'finishedAt'
  >
>;

/** Database access of the Proposal runner. A memory fake implements it in unit tests. */
export interface ProposalStore {
  /** A new attempt for the Hunt, `drafting`. Null when a Proposal of the Hunt is still active. */
  create(huntId: string, now: Date): Promise<ProposalRecord | null>;
  byId(id: string): Promise<ProposalRecord | null>;
  /** The Proposal with the highest attempt of the Hunt. */
  latestOfHunt(huntId: string): Promise<ProposalRecord | null>;
  /** The latest Proposal of each of these Hunts (a Hunt with none is absent). */
  latestOfHunts(huntIds: readonly string[]): Promise<Map<string, ProposalRecord>>;
  listByStatus(statuses: readonly ProposalStatus[]): Promise<ProposalRecord[]>;
  /**
   * Moves the status along the graph and sets `patch` in the same write, only while the row is still in `from`.
   * False (and nothing changed) when the move is not an edge of the graph or the row is no longer in `from`.
   */
  move(id: string, from: ProposalStatus, to: ProposalStatus, patch?: ProposalPatch): Promise<boolean>;
  /** Sets fields of a row that is still in `status`, with no change of status. False when it is not. */
  patch(id: string, status: ProposalStatus, patch: ProposalPatch): Promise<boolean>;
  /** Fixer runs created on the UTC day of `now` whose agent started. */
  fixerStartsToday(now: Date): Promise<number>;
  /** Marks every `drafting` Proposal `failed` with `api_restart`. Returns how many. */
  sweepDrafting(now: Date): Promise<number>;
  /** The latest Proposal of the latest Hunt of each Service. */
  latestPerService(): Promise<Map<ServiceName, ProposalSummary>>;
  /** The Proposal as `GET /api/proposals/:id` shows it. */
  view(id: string): Promise<ProposalView | null>;
}

export const toProposalSummary = (r: ProposalRecord): ProposalSummary => ({
  id: r.id,
  huntId: r.huntId,
  attempt: r.attempt,
  kind: r.kind,
  status: r.status,
  prNumber: r.prNumber,
  prUrl: r.prUrl,
  mergedBy: r.mergedBy,
  checks: r.checks,
  failReason: r.failReason,
  aiFailReason: r.aiFailReason,
  updatedAt: r.updatedAt.toISOString(),
});

export const toProposalView = (r: ProposalRecord): ProposalView => ({
  ...toProposalSummary(r),
  service: r.service,
  credits: r.credits,
  creditsEstimated: r.creditsEstimated,
  createdAt: r.createdAt.toISOString(),
  openedAt: r.openedAt?.toISOString() ?? null,
  mergedAt: r.mergedAt?.toISOString() ?? null,
  deployedAt: r.deployedAt?.toISOString() ?? null,
});

/** Reads the stored `checks` back: only well-formed entries, at most 12. */
export function parseChecks(value: unknown): ProposalCheck[] {
  if (!Array.isArray(value)) return [];
  const out: ProposalCheck[] = [];
  for (const item of value.slice(0, 12)) {
    const errors: string[] = [];
    checkProposalCheck(item, '$', errors);
    if (errors.length === 0) out.push(item as ProposalCheck);
  }
  return out;
}

interface Row {
  id: string;
  huntId: string;
  attempt: number;
  kind: ProposalKind | null;
  status: ProposalStatus;
  failReason: string | null;
  aiFailReason: string | null;
  prNumber: number | null;
  prUrl: string | null;
  branch: string | null;
  baseBranch: string | null;
  baseSha: string | null;
  headSha: string | null;
  mergeSha: string | null;
  mergedBy: string | null;
  checks: unknown;
  patchFiles: number | null;
  patchLines: number | null;
  agentStarted: boolean;
  credits: number;
  creditsEstimated: boolean;
  etag: string | null;
  createdAt: Date;
  updatedAt: Date;
  openedAt: Date | null;
  mergedAt: Date | null;
  deployedAt: Date | null;
  finishedAt: Date | null;
  hunt: { service: { name: string } };
}

export function toRecord(row: Row): ProposalRecord | null {
  const service = validateServiceName(row.hunt.service.name);
  if (!service.ok) return null;
  const { hunt: _hunt, checks, failReason, aiFailReason, ...rest } = row;
  return {
    ...rest,
    service: service.value,
    failReason: failReason as ProposalFailReason | null,
    aiFailReason: aiFailReason as AiFailReason | null,
    checks: parseChecks(checks),
  };
}

const INCLUDE = { hunt: { select: { service: { select: { name: true } } } } } as const;

/** A Prisma error code, `P2002` for a unique violation. */
const isUniqueViolation = (err: unknown): boolean => typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2002';

export class PrismaProposalStore implements ProposalStore {
  constructor(private readonly prisma: PrismaClient) {}

  async create(huntId: string, _now: Date): Promise<ProposalRecord | null> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const rows = await this.prisma.proposal.findMany({ where: { huntId }, select: { attempt: true, status: true }, orderBy: { attempt: 'desc' } });
      if (rows.some((r) => isActiveProposalStatus(r.status))) return null;
      const next = (rows[0]?.attempt ?? 0) + 1;
      try {
        const row = await this.prisma.proposal.create({ data: { huntId, attempt: next }, include: INCLUDE });
        return toRecord(row);
      } catch (err) {
        // The unique indexes (one active Proposal per Hunt, one number per attempt) decide a race.
        if (!isUniqueViolation(err)) throw err;
      }
    }
    return null;
  }

  async byId(id: string): Promise<ProposalRecord | null> {
    const row = await this.prisma.proposal.findUnique({ where: { id }, include: INCLUDE });
    return row === null ? null : toRecord(row);
  }

  async latestOfHunt(huntId: string): Promise<ProposalRecord | null> {
    const row = await this.prisma.proposal.findFirst({ where: { huntId }, orderBy: { attempt: 'desc' }, include: INCLUDE });
    return row === null ? null : toRecord(row);
  }

  async latestOfHunts(huntIds: readonly string[]): Promise<Map<string, ProposalRecord>> {
    const out = new Map<string, ProposalRecord>();
    if (huntIds.length === 0) return out;
    const rows = await this.prisma.proposal.findMany({ where: { huntId: { in: [...huntIds] } }, orderBy: { attempt: 'asc' }, include: INCLUDE });
    for (const row of rows) {
      const rec = toRecord(row);
      if (rec !== null) out.set(rec.huntId, rec);
    }
    return out;
  }

  async listByStatus(statuses: readonly ProposalStatus[]): Promise<ProposalRecord[]> {
    const rows = await this.prisma.proposal.findMany({ where: { status: { in: [...statuses] } }, orderBy: { createdAt: 'asc' }, include: INCLUDE });
    return rows.flatMap((r) => {
      const rec = toRecord(r);
      return rec === null ? [] : [rec];
    });
  }

  async move(id: string, from: ProposalStatus, to: ProposalStatus, patch: ProposalPatch = {}): Promise<boolean> {
    if (!canMove(from, to)) return false;
    const r = await this.prisma.proposal.updateMany({ where: { id, status: from }, data: { ...dataOf(patch), status: to } });
    return r.count === 1;
  }

  async patch(id: string, status: ProposalStatus, patch: ProposalPatch): Promise<boolean> {
    const r = await this.prisma.proposal.updateMany({ where: { id, status }, data: dataOf(patch) });
    return r.count === 1;
  }

  async fixerStartsToday(now: Date): Promise<number> {
    const start = utcDayStart(now);
    return this.prisma.proposal.count({ where: { agentStarted: true, createdAt: { gte: start, lt: new Date(start.getTime() + 86_400_000) } } });
  }

  async sweepDrafting(now: Date): Promise<number> {
    const r = await this.prisma.proposal.updateMany({
      where: { status: 'drafting' },
      data: { status: 'failed', failReason: 'api_restart', finishedAt: now },
    });
    return r.count;
  }

  async latestPerService(): Promise<Map<ServiceName, ProposalSummary>> {
    const out = new Map<ServiceName, ProposalSummary>();
    const services = await this.prisma.service.findMany({ select: { id: true, name: true } });
    for (const s of services) {
      const name = validateServiceName(s.name);
      if (!name.ok) continue;
      const hunt = await this.prisma.hunt.findFirst({ where: { serviceId: s.id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true } });
      if (hunt === null) continue;
      const rec = await this.latestOfHunt(hunt.id);
      if (rec !== null) out.set(name.value, toProposalSummary(rec));
    }
    return out;
  }

  async view(id: string): Promise<ProposalView | null> {
    const rec = await this.byId(id);
    return rec === null ? null : toProposalView(rec);
  }
}

/** Prisma data of a patch: `checks` is JSON, `undefined` keys are dropped. */
function dataOf(patch: ProposalPatch): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) if (value !== undefined) out[key] = key === 'checks' ? (value as ProposalCheck[]) : value;
  return out;
}

/** The statuses a Proposal may move to from `from`. Exposed for tests. */
export const edgesFrom = (from: ProposalStatus): readonly ProposalStatus[] => PROPOSAL_EDGES[from];
