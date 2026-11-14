import {
  SERVICE_NAMES,
  validateHauntLevel,
  validateServiceName,
  type HauntReason,
  type HauntReasonKind,
  type HuntSummary,
  type OpenIncident,
  type ProposalSummary,
  type ServiceMetrics,
  type ServiceName,
  type ServiceState,
} from '@haunted-ops/shared';
import type { HuntStore } from '../hunts/hunt-store.js';
import type { IngestService } from '../ingest/ingest.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';

export interface ServiceRow {
  name: string;
  roomX: number;
  roomY: number;
  hauntLevel: number;
  reasonKind?: HauntReasonKind | null;
  reasonValue?: number | null;
  /** The Open Incidents of the Service (at most one). */
  incidents?: ReadonlyArray<{ id: string; openedAt: Date; peakLevel: number }>;
  updatedAt: Date;
}

/**
 * Maps database rows to Service state in the fixed room order. Unknown names are dropped.
 * `metrics` come from the ingest service (last Sample); a Service without them gets `null`.
 */
export function toServiceStates(
  rows: readonly ServiceRow[],
  metrics: ReadonlyMap<ServiceName, ServiceMetrics> = new Map(),
  hunts: ReadonlyMap<ServiceName, HuntSummary> = new Map(),
  proposals: ReadonlyMap<ServiceName, ProposalSummary> = new Map(),
): ServiceState[] {
  const order = (n: ServiceName): number => SERVICE_NAMES.indexOf(n);
  const out: ServiceState[] = [];
  for (const row of rows) {
    const name = validateServiceName(row.name);
    if (!name.ok) continue;
    const level = validateHauntLevel(row.hauntLevel);
    if (!level.ok) throw new Error('haunt level out of range in database');
    const reason: HauntReason | null =
      row.reasonKind != null && row.reasonValue != null ? { kind: row.reasonKind, value: row.reasonValue } : null;
    const open = row.incidents?.[0];
    const peak = open === undefined ? null : validateHauntLevel(open.peakLevel);
    const openIncident: OpenIncident | null =
      open !== undefined && peak?.ok === true
        ? { id: open.id, openedAt: open.openedAt.toISOString(), peakLevel: peak.value }
        : null;
    out.push({
      name: name.value,
      room: { x: row.roomX, y: row.roomY },
      hauntLevel: level.value,
      reason,
      metrics: metrics.get(name.value) ?? null,
      openIncident,
      updatedAt: row.updatedAt.toISOString(),
      hunt: hunts.get(name.value) ?? null,
      proposal: proposals.get(name.value) ?? null,
    });
  }
  return out.sort((a, b) => order(a.name) - order(b.name));
}

export class ServicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ingest?: Pick<IngestService, 'metrics'>,
    private readonly hunts?: Pick<HuntStore, 'latestPerService'>,
    private readonly proposals?: { latestPerService(): Promise<Map<ServiceName, ProposalSummary>> },
  ) {}

  async list(): Promise<ServiceState[]> {
    const rows = await this.prisma.client.service.findMany({
      select: {
        name: true,
        roomX: true,
        roomY: true,
        hauntLevel: true,
        reasonKind: true,
        reasonValue: true,
        updatedAt: true,
        incidents: { where: { closedAt: null }, take: 1, select: { id: true, openedAt: true, peakLevel: true } },
      },
    });
    const metrics = this.ingest ? await this.ingest.metrics() : new Map<ServiceName, ServiceMetrics>();
    // One query per Service for its latest Hunt (indexed); a failure here must not hide the Services.
    const hunts = this.hunts ? await this.hunts.latestPerService().catch(() => new Map<ServiceName, HuntSummary>()) : new Map<ServiceName, HuntSummary>();
    const proposals = this.proposals
      ? await this.proposals.latestPerService().catch(() => new Map<ServiceName, ProposalSummary>())
      : new Map<ServiceName, ProposalSummary>();
    return toServiceStates(rows, metrics, hunts, proposals);
  }
}
