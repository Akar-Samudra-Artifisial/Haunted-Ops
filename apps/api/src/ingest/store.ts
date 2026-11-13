import {
  SERVICE_NAMES,
  validateHauntLevel,
  validateServiceName,
  type HauntLevel,
  type HauntReason,
  type Sample,
  type ServiceMetrics,
  type ServiceName,
} from '@haunted-ops/shared';
import type { IncidentAction } from './incident-policy.js';
import type { PrismaClient } from '../prisma/client.js';

export interface StoredIncident {
  id: string;
  openedAt: Date;
  peakLevel: HauntLevel;
}

export interface StoredService {
  name: ServiceName;
  room: { x: number; y: number };
  level: HauntLevel;
  reason: HauntReason | null;
  openIncident: StoredIncident | null;
  updatedAt: Date;
}

/** One Service step to persist, in one transaction. */
export interface ServiceChange {
  name: ServiceName;
  /** Written when set: the new level and reason. */
  haunt: { level: HauntLevel; reason: HauntReason | null } | null;
  incident: IncidentAction;
  /** Id of the Incident that `raise_peak` and `close` act on. */
  incidentId: string | null;
  at: Date;
}

export interface AppliedChange {
  /** The Service `updatedAt` after the write, or null when the Service row was not written. */
  updatedAt: Date | null;
  /** The Open Incident after the write, or null when none is open. */
  incident: StoredIncident | null;
  /** True when this write created the Incident. */
  created: boolean;
  /** Set when this write closed the Incident. */
  closedAt: Date | null;
}

export interface SignalRow {
  service: ServiceName;
  kind: 'error_rate' | 'p95_ms' | 'up';
  value: number;
  at: Date;
}

/** Database access of the ingest pipeline. A fake implements it in unit tests. */
export interface IngestStore {
  loadServices(): Promise<StoredService[]>;
  insertSignals(rows: readonly SignalRow[]): Promise<void>;
  applyChange(change: ServiceChange): Promise<AppliedChange>;
  /** Latest Signal of each kind per Service with `at` not before `since`. */
  recentMetrics(since: Date): Promise<Map<ServiceName, ServiceMetrics>>;
}

/** Signal rows for the values of a Sample that are not null. */
export function signalRows(service: ServiceName, sample: Sample, at: Date): SignalRow[] {
  const rows: SignalRow[] = [];
  if (sample.errorRate !== null) rows.push({ service, kind: 'error_rate', value: sample.errorRate, at });
  if (sample.p95Ms !== null) rows.push({ service, kind: 'p95_ms', value: sample.p95Ms, at });
  if (sample.up !== null) rows.push({ service, kind: 'up', value: sample.up, at });
  return rows;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2002';
}

export class PrismaIngestStore implements IngestStore {
  constructor(private readonly prisma: PrismaClient) {}

  async loadServices(): Promise<StoredService[]> {
    const rows = await this.prisma.service.findMany({
      include: { incidents: { where: { closedAt: null }, take: 1 } },
    });
    const out: StoredService[] = [];
    for (const row of rows) {
      const name = validateServiceName(row.name);
      const level = validateHauntLevel(row.hauntLevel);
      if (!name.ok || !level.ok) continue;
      const open = row.incidents[0];
      const peak = open === undefined ? null : validateHauntLevel(open.peakLevel);
      out.push({
        name: name.value,
        room: { x: row.roomX, y: row.roomY },
        level: level.value,
        reason:
          row.reasonKind !== null && row.reasonValue !== null ? { kind: row.reasonKind, value: row.reasonValue } : null,
        openIncident:
          open !== undefined && peak?.ok === true ? { id: open.id, openedAt: open.openedAt, peakLevel: peak.value } : null,
        updatedAt: row.updatedAt,
      });
    }
    return out;
  }

  async insertSignals(rows: readonly SignalRow[]): Promise<void> {
    if (rows.length === 0) return;
    const services = await this.prisma.service.findMany({ select: { id: true, name: true } });
    const ids = new Map(services.map((s) => [s.name, s.id]));
    const data = rows.flatMap((r) => {
      const serviceId = ids.get(r.service);
      return serviceId === undefined ? [] : [{ serviceId, kind: r.kind, value: r.value, at: r.at }];
    });
    await this.prisma.signal.createMany({ data });
  }

  async applyChange(change: ServiceChange): Promise<AppliedChange> {
    try {
      return await this.runChange(change);
    } catch (err) {
      // The partial unique index "incident_one_open_per_service" rejected a second open Incident:
      // run once more, which now finds the open one and uses it.
      if (change.incident.kind === 'open' && isUniqueViolation(err)) return this.runChange(change);
      throw err;
    }
  }

  private runChange(change: ServiceChange): Promise<AppliedChange> {
    return this.prisma.$transaction(async (tx) => {
      let updatedAt: Date | null = null;
      if (change.haunt !== null) {
        const row = await tx.service.update({
          where: { name: change.name },
          data: {
            hauntLevel: change.haunt.level,
            reasonKind: change.haunt.reason?.kind ?? null,
            reasonValue: change.haunt.reason?.value ?? null,
          },
          select: { updatedAt: true },
        });
        updatedAt = row.updatedAt;
      }

      const action = change.incident;
      const service = await tx.service.findUniqueOrThrow({ where: { name: change.name }, select: { id: true } });
      let incident: StoredIncident | null = null;
      let created = false;
      let closedAt: Date | null = null;

      if (action.kind === 'open') {
        // Look first, create second; the partial unique index is the final guard.
        const existing = await tx.incident.findFirst({ where: { serviceId: service.id, closedAt: null } });
        if (existing !== null) {
          incident = { id: existing.id, openedAt: existing.openedAt, peakLevel: existing.peakLevel as HauntLevel };
          if (action.peakLevel > existing.peakLevel) {
            await tx.incident.update({ where: { id: existing.id }, data: { peakLevel: action.peakLevel } });
            incident = { ...incident, peakLevel: action.peakLevel };
          }
        } else {
          const made = await tx.incident.create({
            data: { serviceId: service.id, openedAt: change.at, peakLevel: action.peakLevel },
          });
          incident = { id: made.id, openedAt: made.openedAt, peakLevel: action.peakLevel };
          created = true;
        }
      } else if (action.kind === 'raise_peak' && change.incidentId !== null) {
        const row = await tx.incident.update({
          where: { id: change.incidentId },
          data: { peakLevel: action.peakLevel },
        });
        incident = { id: row.id, openedAt: row.openedAt, peakLevel: action.peakLevel };
      } else if (action.kind === 'close' && change.incidentId !== null) {
        await tx.incident.update({ where: { id: change.incidentId }, data: { closedAt: change.at } });
        closedAt = change.at;
      }
      return { updatedAt, incident, created, closedAt };
    });
  }

  async recentMetrics(since: Date): Promise<Map<ServiceName, ServiceMetrics>> {
    const rows = await this.prisma.$queryRaw<
      Array<{ name: string; kind: 'error_rate' | 'p95_ms' | 'up'; value: number; at: Date }>
    >`SELECT DISTINCT ON (s."serviceId", s."kind") v."name" AS name, s."kind" AS kind, s."value" AS value, s."at" AS at
        FROM "Signal" s JOIN "Service" v ON v."id" = s."serviceId"
        WHERE s."at" >= ${since}
        ORDER BY s."serviceId", s."kind", s."at" DESC`;
    const out = new Map<ServiceName, ServiceMetrics>();
    for (const name of SERVICE_NAMES) {
      const own = rows.filter((r) => r.name === name);
      if (own.length === 0) continue;
      const latest = own.reduce((a, b) => (a.at >= b.at ? a : b));
      const pick = (kind: string): number | null => own.find((r) => r.kind === kind)?.value ?? null;
      out.set(name, {
        errorRate: pick('error_rate'),
        p95Ms: pick('p95_ms'),
        up: pick('up'),
        at: latest.at.toISOString(),
      });
    }
    return out;
  }
}
