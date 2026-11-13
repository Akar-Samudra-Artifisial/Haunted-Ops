import {
  HUNT_TOOLS,
  validateServiceName,
  type DiagnosisCheck,
  type EvidenceKindName,
  type HauntReasonKind,
  type HuntDetail,
  type HuntEndReason,
  type HuntFinalStatus,
  type HuntStatus,
  type HuntSummary,
  type HuntStepView,
  type HuntTool,
  type HuntTrigger,
  type ServiceName,
} from '@haunted-ops/shared';
import type { PrismaClient } from '../prisma/client.js';

/** What the prompt of a Hunt is built from: validated facts of an Incident, no text from the lab or the model. */
export interface IncidentFacts {
  incidentId: string;
  serviceId: string;
  service: ServiceName;
  /** The peak level of the Incident, limited to 2..4. */
  level: 2 | 3 | 4;
  reasonKind: HauntReasonKind | null;
  openedAt: Date;
  closedAt: Date | null;
}

export interface NewHunt {
  incidentId: string;
  serviceId: string;
  trigger: HuntTrigger;
  model: string;
  /** Set when the request is recorded as cancelled at once (busy, cooldown, disabled, daily cap). */
  cancelled?: { reason: HuntEndReason; at: Date; diagnosedBy?: ServiceName | null; linkedHuntId?: string | null };
}

export interface ValidDiagnosisRecord {
  culpritDeploy: string;
  /** The full 40-character SHA of the Deploy record. */
  culpritSha: string;
  /** The Service of that Deploy record: the hunted Service or one it depends on. */
  culpritService: ServiceName;
  summary: string;
  fixHint: string;
  /** The Evidence handles the diagnosis cites. */
  cited: readonly string[];
}

export interface HuntFinish {
  status: HuntFinalStatus;
  reason: HuntEndReason;
  invalidCheck: DiagnosisCheck | null;
  /** What stopped the Hunt (for `foreign_tool`, the refused tool title); at most 200 characters. */
  stopDetail?: string | null;
  /** True when `credits` is an estimate (the Hunt ended before Kiro reported its Credits). */
  creditsEstimated?: boolean;
  /** For `diagnosed_upstream`: the Service and the id of the Hunt that diagnosed the cause. */
  diagnosedBy?: ServiceName | null;
  linkedHuntId?: string | null;
  credits: number;
  toolCalls: number;
  durationMs: number | null;
  finishedAt: Date;
  diagnosis: ValidDiagnosisRecord | null;
}

export interface CreatedHunt {
  id: string;
  createdAt: Date;
}

/** Database access of the Hunt runner. A fake implements it in unit tests. */
export interface HuntStore {
  incidentFacts(incidentId: string): Promise<IncidentFacts | null>;
  openIncidentOf(service: ServiceName): Promise<IncidentFacts | null>;
  /** Every Incident that is open now, one per Service at most. */
  openIncidents(): Promise<IncidentFacts[]>;
  /** True when an `auto` Hunt was already requested for the Incident. */
  hasAutoHunt(incidentId: string): Promise<boolean>;
  create(hunt: NewHunt): Promise<CreatedHunt>;
  /** queued -> running. False when the Hunt is not queued any more. */
  markRunning(huntId: string, startedAt: Date): Promise<boolean>;
  addStep(huntId: string, step: HuntStepView): Promise<void>;
  addEvidence(huntId: string, evidence: { order: number; kind: EvidenceKindName; ref: string; detail: string }): Promise<void>;
  /** Writes the running totals while a Hunt runs. */
  setProgress(huntId: string, progress: { credits: number; toolCalls: number }): Promise<void>;
  /** Ends a queued or running Hunt. False when it had already ended. */
  finish(huntId: string, finish: HuntFinish): Promise<boolean>;
  /** Credits of the Hunts that started on the UTC day of `now`. */
  creditsToday(now: Date): Promise<number>;
  /** How many Hunts started on the UTC day of `now`. */
  startedToday(now: Date): Promise<number>;
  /** The time the last Hunt that ran for the Service finished, or null. */
  lastRunFinishedAt(serviceId: string): Promise<Date | null>;
  /** Marks every queued or running Hunt as failed with `api_restart`. Returns how many. */
  sweepStale(now: Date): Promise<number>;
  get(huntId: string): Promise<HuntDetail | null>;
  /** The latest Hunt of each Service that has one. */
  latestPerService(): Promise<Map<ServiceName, HuntSummary>>;
}

// --- pure mapping from rows to the shared types ---

const isTool = (v: string): v is HuntTool => (HUNT_TOOLS as readonly string[]).includes(v);

export interface HuntRowLike {
  id: string;
  incidentId: string;
  status: HuntStatus;
  trigger: HuntTrigger;
  endReason: HuntEndReason | null;
  invalidCheck: string | null;
  stopDetail: string | null;
  creditsEstimated: boolean;
  diagnosedBy: string | null;
  linkedHuntId: string | null;
  model: string;
  credits: number;
  toolCalls: number;
  culpritDeploy: string | null;
  culpritSha: string | null;
  culpritService: string | null;
  summary: string | null;
  fixHint: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  durationMs: number | null;
  createdAt: Date;
  service: { name: string };
  steps: ReadonlyArray<{ index: number; tool: string; summary: string; at: Date }>;
  evidence?: ReadonlyArray<{ order: number; kind: EvidenceKindName; ref: string; detail: string; cited: boolean }>;
  _count: { steps: number; evidence: number };
}

const toStepView = (s: { index: number; tool: string; summary: string; at: Date }): HuntStepView[] =>
  isTool(s.tool) ? [{ index: s.index, tool: s.tool, summary: s.summary, at: s.at.toISOString() }] : [];

/** The summary of the Hunt: the last `limit` steps (oldest first) and the diagnosis only when it succeeded. */
export function toHuntSummary(row: HuntRowLike): HuntSummary | null {
  const service = validateServiceName(row.service.name);
  if (!service.ok) return null;
  const diagnosedBy = row.diagnosedBy === null ? null : validateServiceName(row.diagnosedBy);
  const culpritService = row.culpritService === null ? null : validateServiceName(row.culpritService);
  const succeeded =
    row.status === 'succeeded' && row.culpritDeploy !== null && row.culpritSha !== null && row.summary !== null && culpritService?.ok === true;
  return {
    id: row.id,
    incidentId: row.incidentId,
    service: service.value,
    trigger: row.trigger,
    status: row.status,
    reason: row.endReason,
    steps: [...row.steps].sort((a, b) => a.index - b.index).flatMap(toStepView),
    stepCount: row._count.steps,
    evidenceCount: row._count.evidence,
    diagnosis: succeeded
      ? {
          culpritDeploy: row.culpritDeploy as string,
          culpritSha: row.culpritSha as string,
          culpritService: (culpritService as { ok: true; value: ServiceName }).value,
          summary: row.summary as string,
        }
      : null,
    credits: row.credits,
    queuedAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    diagnosedBy: diagnosedBy?.ok === true ? diagnosedBy.value : null,
  };
}

export function toHuntDetail(row: HuntRowLike, allSteps: HuntRowLike['steps']): HuntDetail | null {
  const base = toHuntSummary(row);
  if (base === null) return null;
  return {
    ...base,
    model: row.model,
    toolCalls: row.toolCalls,
    durationMs: row.durationMs,
    invalidCheck: (row.invalidCheck as DiagnosisCheck | null) ?? null,
    stopDetail: row.stopDetail,
    creditsEstimated: row.creditsEstimated,
    linkedHuntId: row.linkedHuntId,
    allSteps: [...allSteps].sort((a, b) => a.index - b.index).flatMap(toStepView),
    evidence: [...(row.evidence ?? [])].sort((a, b) => a.order - b.order).map((e) => ({ index: e.order, kind: e.kind, ref: e.ref, detail: e.detail, cited: e.cited })),
    fixHint: row.status === 'succeeded' ? row.fixHint : null,
  };
}

/** UTC midnight that starts the day of `now`. */
export function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

const clampLevel = (n: number): 2 | 3 | 4 => (n >= 4 ? 4 : n === 3 ? 3 : 2);

export class PrismaHuntStore implements HuntStore {
  constructor(private readonly prisma: PrismaClient) {}

  private async facts(where: { id: string } | { serviceName: ServiceName }): Promise<IncidentFacts | null> {
    const row =
      'id' in where
        ? await this.prisma.incident.findUnique({ where: { id: where.id }, include: { service: true } })
        : await this.prisma.incident.findFirst({ where: { closedAt: null, service: { name: where.serviceName } }, orderBy: { openedAt: 'desc' }, include: { service: true } });
    if (row === null) return null;
    const service = validateServiceName(row.service.name);
    if (!service.ok) return null;
    return {
      incidentId: row.id,
      serviceId: row.serviceId,
      service: service.value,
      level: clampLevel(row.peakLevel),
      reasonKind: row.service.reasonKind,
      openedAt: row.openedAt,
      closedAt: row.closedAt,
    };
  }

  incidentFacts(incidentId: string): Promise<IncidentFacts | null> {
    return this.facts({ id: incidentId });
  }

  async openIncidents(): Promise<IncidentFacts[]> {
    const rows = await this.prisma.incident.findMany({ where: { closedAt: null }, orderBy: { openedAt: 'asc' }, include: { service: true } });
    const out: IncidentFacts[] = [];
    for (const row of rows) {
      const service = validateServiceName(row.service.name);
      if (!service.ok) continue;
      out.push({
        incidentId: row.id,
        serviceId: row.serviceId,
        service: service.value,
        level: clampLevel(row.peakLevel),
        reasonKind: row.service.reasonKind,
        openedAt: row.openedAt,
        closedAt: row.closedAt,
      });
    }
    return out;
  }

  openIncidentOf(service: ServiceName): Promise<IncidentFacts | null> {
    return this.facts({ serviceName: service });
  }

  async hasAutoHunt(incidentId: string): Promise<boolean> {
    return (await this.prisma.hunt.count({ where: { incidentId, trigger: 'auto' } })) > 0;
  }

  async create(hunt: NewHunt): Promise<CreatedHunt> {
    const row = await this.prisma.hunt.create({
      data: {
        incidentId: hunt.incidentId,
        serviceId: hunt.serviceId,
        trigger: hunt.trigger,
        model: hunt.model,
        ...(hunt.cancelled
          ? {
              status: 'cancelled' as const,
              endReason: hunt.cancelled.reason,
              finishedAt: hunt.cancelled.at,
              diagnosedBy: hunt.cancelled.diagnosedBy ?? null,
              linkedHuntId: hunt.cancelled.linkedHuntId ?? null,
            }
          : {}),
      },
      select: { id: true, createdAt: true },
    });
    return row;
  }

  async markRunning(huntId: string, startedAt: Date): Promise<boolean> {
    const r = await this.prisma.hunt.updateMany({ where: { id: huntId, status: 'queued' }, data: { status: 'running', startedAt } });
    return r.count === 1;
  }

  async addStep(huntId: string, step: HuntStepView): Promise<void> {
    await this.prisma.huntStep.createMany({
      data: [{ huntId, index: step.index, tool: step.tool, summary: step.summary, at: new Date(step.at) }],
      skipDuplicates: true,
    });
  }

  async addEvidence(huntId: string, e: { order: number; kind: EvidenceKindName; ref: string; detail: string }): Promise<void> {
    await this.prisma.evidence.createMany({ data: [{ huntId, order: e.order, kind: e.kind, ref: e.ref, detail: e.detail }], skipDuplicates: true });
  }

  async setProgress(huntId: string, progress: { credits: number; toolCalls: number }): Promise<void> {
    await this.prisma.hunt.updateMany({ where: { id: huntId, status: 'running' }, data: { credits: progress.credits, toolCalls: progress.toolCalls } });
  }

  async finish(huntId: string, f: HuntFinish): Promise<boolean> {
    const d = f.diagnosis;
    return this.prisma.$transaction(async (tx) => {
      const r = await tx.hunt.updateMany({
        where: { id: huntId, status: { in: ['queued', 'running'] } },
        data: {
          status: f.status,
          endReason: f.reason,
          invalidCheck: f.invalidCheck,
          stopDetail: f.stopDetail ?? null,
          creditsEstimated: f.creditsEstimated ?? false,
          diagnosedBy: f.diagnosedBy ?? null,
          linkedHuntId: f.linkedHuntId ?? null,
          credits: f.credits,
          toolCalls: f.toolCalls,
          durationMs: f.durationMs,
          finishedAt: f.finishedAt,
          culpritDeploy: d?.culpritDeploy ?? null,
          culpritSha: d?.culpritSha ?? null,
          culpritService: d?.culpritService ?? null,
          summary: d?.summary ?? null,
          fixHint: d?.fixHint ?? null,
        },
      });
      if (r.count !== 1) return false;
      if (d !== null && d.cited.length > 0) {
        await tx.evidence.updateMany({ where: { huntId, ref: { in: [...d.cited] } }, data: { cited: true } });
      }
      return true;
    });
  }

  async creditsToday(now: Date): Promise<number> {
    const start = utcDayStart(now);
    const end = new Date(start.getTime() + 86_400_000);
    const r = await this.prisma.hunt.aggregate({ _sum: { credits: true }, where: { startedAt: { gte: start, lt: end } } });
    return r._sum.credits ?? 0;
  }

  async startedToday(now: Date): Promise<number> {
    const start = utcDayStart(now);
    return this.prisma.hunt.count({ where: { startedAt: { gte: start, lt: new Date(start.getTime() + 86_400_000) } } });
  }

  async lastRunFinishedAt(serviceId: string): Promise<Date | null> {
    const r = await this.prisma.hunt.findFirst({
      where: { serviceId, startedAt: { not: null }, finishedAt: { not: null } },
      orderBy: { finishedAt: 'desc' },
      select: { finishedAt: true },
    });
    return r?.finishedAt ?? null;
  }

  async sweepStale(now: Date): Promise<number> {
    const r = await this.prisma.hunt.updateMany({
      where: { status: { in: ['queued', 'running'] } },
      data: { status: 'failed', endReason: 'api_restart', finishedAt: now },
    });
    return r.count;
  }

  async get(huntId: string): Promise<HuntDetail | null> {
    const row = await this.prisma.hunt.findUnique({
      where: { id: huntId },
      include: {
        service: { select: { name: true } },
        steps: { orderBy: { index: 'asc' } },
        evidence: { orderBy: { order: 'asc' } },
        _count: { select: { steps: true, evidence: true } },
      },
    });
    if (row === null) return null;
    const lastEight = row.steps.slice(-8);
    return toHuntDetail({ ...row, steps: lastEight }, row.steps);
  }

  async latestPerService(): Promise<Map<ServiceName, HuntSummary>> {
    const services = await this.prisma.service.findMany({ select: { id: true } });
    const out = new Map<ServiceName, HuntSummary>();
    const rows = await Promise.all(
      services.map((s) =>
        this.prisma.hunt.findFirst({
          where: { serviceId: s.id },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          include: {
            service: { select: { name: true } },
            steps: { orderBy: { index: 'desc' }, take: 8 },
            _count: { select: { steps: true, evidence: true } },
          },
        }),
      ),
    );
    for (const row of rows) {
      if (row === null) continue;
      const summary = toHuntSummary(row);
      if (summary !== null) out.set(summary.service, summary);
    }
    return out;
  }
}
