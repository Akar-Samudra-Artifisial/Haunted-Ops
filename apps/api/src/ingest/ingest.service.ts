import {
  SERVICE_NAMES,
  initialHauntState,
  isNoData,
  stepHaunt,
  type DomainEventName,
  type DomainEventPayloads,
  type HauntLevel,
  type HauntReasonKind,
  type HauntState,
  type IngestStatus,
  type ServiceMetrics,
  type ServiceName,
  type ServiceState,
  type HuntSummary,
  type ProposalSummary,
} from '@haunted-ops/shared';
import type { JsonLogger } from '../security/logger.js';
import { nextIncident, type IncidentState } from './incident-policy.js';
import type { PollErrorCode, PollResult } from './prometheus-client.js';
import { signalRows, type IngestStore, type ServiceChange, type StoredService } from './store.js';

/** The part of the event bus the pipeline uses. */
export interface IngestBus {
  publish<K extends DomainEventName>(name: K, payload: DomainEventPayloads[K]): unknown;
}

export type IngestState = 'unknown' | 'ok' | 'stale';

/** How long after a start the Signals of the database may stand in for the last Sample. */
export const RECENT_METRICS_WINDOW_MS = 60_000;

/** `ingest.polled` goes to every SSE client, so it is sent at most this often (and on a change of ingest status). */
export const POLLED_MIN_INTERVAL_MS = 30_000;

interface ServiceRecord {
  name: ServiceName;
  room: { x: number; y: number };
  /** In memory: level, reason and hysteresis streaks. Kept when a database write fails. */
  haunt: HauntState;
  /** What the database holds. It differs from `haunt` only after a failed write, which the next Poll retries. */
  persistedLevel: HauntLevel;
  persistedKind: HauntReasonKind | null;
  incident: IncidentState;
  openedAt: Date | null;
  updatedAt: Date;
  metrics: ServiceMetrics | null;
}

export interface IngestServiceDeps {
  store: IngestStore;
  bus: IngestBus;
  logger: JsonLogger;
  now?: () => Date;
}

/**
 * Turns Polls into Signals, haunt levels, Incidents and events. One Poll runs at a time (the Poller
 * guarantees it), so Service steps never interleave. Events are published only after the commit.
 */
export class IngestService {
  private readonly store: IngestStore;
  private readonly bus: IngestBus;
  private readonly logger: JsonLogger;
  private readonly now: () => Date;
  private readonly records = new Map<ServiceName, ServiceRecord>();
  private state: IngestState = 'unknown';
  private changedAt: Date;
  private lastSuccessAt: Date | null = null;
  private lastPolledAt: number | null = null;
  /** Latest Hunt of a Service, set by the hunts module; `null` until then. */
  private huntLookup: (name: ServiceName) => HuntSummary | null = () => null;

  /** The hunts module registers where `service.updated` reads the latest Hunt summary. */
  setHuntLookup(lookup: (name: ServiceName) => HuntSummary | null): void {
    this.huntLookup = lookup;
  }

  /** Latest Proposal (fix) of a Service's latest Hunt, set by the fix module; `null` until then. */
  private proposalLookup: (name: ServiceName) => ProposalSummary | null = () => null;
  setProposalLookup(lookup: (name: ServiceName) => ProposalSummary | null): void {
    this.proposalLookup = lookup;
  }
  private proposalOf(name: ServiceName): ProposalSummary | null {
    try {
      return this.proposalLookup(name);
    } catch {
      return null;
    }
  }
  private huntOf(name: ServiceName): HuntSummary | null {
    try {
      return this.huntLookup(name);
    } catch {
      return null;
    }
  }

  constructor(deps: IngestServiceDeps) {
    this.store = deps.store;
    this.bus = deps.bus;
    this.logger = deps.logger;
    this.now = deps.now ?? (() => new Date());
    this.changedAt = this.now();
  }

  /** Loads the stored level, reason and Open Incident of each Service. Streaks start empty. */
  async init(): Promise<void> {
    const services = await this.store.loadServices();
    this.records.clear();
    for (const s of services) this.records.set(s.name, this.fromStored(s));
  }

  private fromStored(s: StoredService): ServiceRecord {
    return {
      name: s.name,
      room: s.room,
      haunt: initialHauntState(s.level, s.reason),
      persistedLevel: s.level,
      persistedKind: s.reason?.kind ?? null,
      incident: {
        open: s.openIncident === null ? null : { id: s.openIncident.id, peakLevel: s.openIncident.peakLevel },
        calmMs: 0,
        lastCalmAt: null,
      },
      openedAt: s.openIncident?.openedAt ?? null,
      updatedAt: s.updatedAt,
      metrics: null,
    };
  }

  status(): IngestStatus {
    return {
      state: this.state === 'ok' ? 'ok' : 'stale',
      at: this.changedAt.toISOString(),
      lastSuccessAt: this.lastSuccessAt?.toISOString() ?? null,
    };
  }

  /** The metrics of every Service: the last Sample, or the Signals of the last 60 s before the first Poll. */
  async metrics(): Promise<Map<ServiceName, ServiceMetrics>> {
    const out = new Map<ServiceName, ServiceMetrics>();
    let missing = false;
    for (const name of SERVICE_NAMES) {
      const m = this.records.get(name)?.metrics;
      if (m) out.set(name, m);
      else missing = true;
    }
    if (!missing) return out;
    try {
      const recent = await this.store.recentMetrics(new Date(this.now().getTime() - RECENT_METRICS_WINDOW_MS));
      for (const [name, m] of recent) {
        if (!out.has(name)) out.set(name, m);
      }
    } catch (err) {
      this.logError('metrics_read_failed', err);
    }
    return out;
  }

  /** A failed Poll changes nothing but the ingest state, and its time never counts toward closing an Incident. */
  pollFailed(at: Date, code: PollErrorCode): void {
    this.logger.log('warn', 'poll_failed', { code });
    for (const rec of this.records.values()) this.breakCalm(rec);
    if (this.state === 'stale') return;
    this.state = 'stale';
    this.changedAt = at;
    this.publish('ingest.status', this.status());
  }

  async applyPoll(at: Date, result: PollResult): Promise<void> {
    // The database may have been down at start: load the Services on the first Poll that can.
    if (this.records.size === 0) {
      try {
        await this.init();
      } catch (err) {
        this.logError('init_failed', err);
      }
    }
    const rows = SERVICE_NAMES.flatMap((name) => signalRows(name, result[name], at));
    try {
      await this.store.insertSignals(rows);
    } catch (err) {
      this.logError('signal_insert_failed', err);
    }

    const atIso = at.toISOString();
    for (const name of SERVICE_NAMES) {
      const rec = this.records.get(name);
      if (!rec) continue;
      const sample = result[name];
      rec.metrics = { ...sample, at: atIso };
      if (isNoData(sample)) {
        // No data: the Service keeps its state, and this Poll does not count toward closing an Incident.
        this.breakCalm(rec);
        continue;
      }
      await this.step(rec, sample, at);
    }

    const due = this.lastPolledAt === null || at.getTime() - this.lastPolledAt >= POLLED_MIN_INTERVAL_MS;
    if (due || this.state !== 'ok') {
      this.lastPolledAt = at.getTime();
      this.publish('ingest.polled', {
        at: atIso,
        samples: SERVICE_NAMES.map((service) => ({ service, ...result[service] })),
      });
    }

    this.lastSuccessAt = at;
    if (this.state !== 'ok') {
      this.state = 'ok';
      this.changedAt = at;
      this.publish('ingest.status', this.status());
    }
  }

  /** The next level-0 Poll starts a new stretch of time toward closing; the calm already counted stays. */
  private breakCalm(rec: ServiceRecord): void {
    rec.incident = { ...rec.incident, lastCalmAt: null };
  }

  private async step(rec: ServiceRecord, sample: PollResult[ServiceName], at: Date): Promise<void> {
    const next = stepHaunt(rec.haunt, sample);
    const policy = nextIncident(rec.incident, next.level, at.getTime());
    // Compared with what the database holds, so a write that failed is retried by the next Poll.
    const changed = next.level !== rec.persistedLevel || (next.reason?.kind ?? null) !== rec.persistedKind;
    const action = policy.action;
    const timing = { calmMs: policy.calmMs, lastCalmAt: policy.lastCalmAt };

    if (!changed && action.kind === 'none') {
      rec.haunt = next;
      rec.incident = { open: rec.incident.open, ...timing };
      return;
    }

    const change: ServiceChange = {
      name: rec.name,
      haunt: changed ? { level: next.level, reason: next.reason } : null,
      incident: action,
      incidentId: rec.incident.open?.id ?? null,
      at,
    };
    let applied;
    try {
      applied = await this.store.applyChange(change);
    } catch (err) {
      // Keep the new hysteresis state, so the streak does not start over; the database keeps the old
      // level and the next Poll writes it again. Nothing is published.
      this.logError('service_write_failed', err);
      rec.haunt = next;
      rec.incident = { open: rec.incident.open, ...timing };
      return;
    }

    const previousLevel = rec.persistedLevel;
    rec.haunt = next;
    rec.persistedLevel = next.level;
    rec.persistedKind = next.reason?.kind ?? null;
    if (applied.updatedAt !== null) rec.updatedAt = applied.updatedAt;
    if (action.kind === 'close' || applied.closedAt !== null) {
      rec.incident = { open: null, calmMs: 0, lastCalmAt: null };
      rec.openedAt = null;
    } else if (applied.incident !== null) {
      rec.incident = { open: { id: applied.incident.id, peakLevel: applied.incident.peakLevel }, ...timing };
      rec.openedAt = applied.incident.openedAt;
    } else {
      rec.incident = { open: rec.incident.open, ...timing };
    }

    if (changed) this.publish('service.updated', { service: this.toState(rec), previousLevel });
    if (action.kind === 'open' && applied.created && applied.incident !== null) {
      this.publish('incident.opened', {
        incidentId: applied.incident.id,
        service: rec.name,
        openedAt: applied.incident.openedAt.toISOString(),
        level: next.level,
        reason: next.reason,
      });
    }
    if (action.kind === 'close' && change.incidentId !== null) {
      this.publish('incident.closed', {
        incidentId: change.incidentId,
        service: rec.name,
        closedAt: (applied.closedAt ?? at).toISOString(),
        peakLevel: action.peakLevel,
      });
    }
  }

  private toState(rec: ServiceRecord): ServiceState {
    const open = rec.incident.open;
    return {
      name: rec.name,
      room: rec.room,
      hauntLevel: rec.haunt.level,
      reason: rec.haunt.reason,
      metrics: rec.metrics,
      openIncident:
        open === null || rec.openedAt === null
          ? null
          : { id: open.id, openedAt: rec.openedAt.toISOString(), peakLevel: open.peakLevel },
      updatedAt: rec.updatedAt.toISOString(),
      hunt: this.huntOf(rec.name),
      proposal: this.proposalOf(rec.name),
    };
  }

  private publish<K extends DomainEventName>(name: K, payload: DomainEventPayloads[K]): void {
    try {
      this.bus.publish(name, payload);
    } catch (err) {
      this.logError('publish_failed', err);
    }
  }

  private logError(msg: string, err: unknown): void {
    this.logger.log('error', msg, { error: err instanceof Error ? err.name : 'unknown' });
  }
}
