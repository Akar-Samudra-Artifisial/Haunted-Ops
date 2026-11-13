import {
  SERVICE_NAMES,
  validateSseEvent,
  type DomainEventName,
  type DomainEventPayloads,
  type HauntLevel,
  type HauntReason,
  type Sample,
  type ServiceMetrics,
  type ServiceName,
} from '@haunted-ops/shared';
import { JsonLogger } from '../../src/security/logger.js';
import type { PollResult } from '../../src/ingest/prometheus-client.js';
import type {
  AppliedChange,
  IngestStore,
  ServiceChange,
  SignalRow,
  StoredIncident,
  StoredService,
} from '../../src/ingest/store.js';

export const T0 = Date.parse('2026-11-13T10:00:00.000Z');
export const at = (offsetSeconds: number): Date => new Date(T0 + offsetSeconds * 1000);

export const CALM: Sample = { errorRate: 0, p95Ms: 120, up: 1 };
export const NO_DATA: Sample = { errorRate: null, p95Ms: null, up: null };

/** A Poll result where every Service is calm except the overrides. */
export function pollResult(overrides: Partial<Record<ServiceName, Sample>> = {}): PollResult {
  return Object.fromEntries(SERVICE_NAMES.map((n) => [n, overrides[n] ?? CALM])) as PollResult;
}

export interface Published {
  name: DomainEventName;
  payload: unknown;
}

/** Records events and validates every payload like the real bus does. */
export class RecordingBus {
  readonly events: Published[] = [];
  failWith: Error | null = null;
  publish<K extends DomainEventName>(name: K, payload: DomainEventPayloads[K]): unknown {
    if (this.failWith) throw this.failWith;
    const check = validateSseEvent(name, payload);
    if (!check.ok) throw new TypeError(`invalid payload for ${name}: ${check.errors.join(', ')}`);
    this.events.push({ name, payload });
    return undefined;
  }
  named(name: DomainEventName, service?: ServiceName): Published[] {
    return this.events.filter((e) => {
      if (e.name !== name) return false;
      if (service === undefined) return true;
      const p = e.payload as { service?: ServiceName | { name: ServiceName } };
      const s = typeof p.service === 'object' ? p.service.name : p.service;
      return s === service;
    });
  }
}

export class LogCapture {
  readonly lines: string[] = [];
  readonly logger = new JsonLogger((line) => this.lines.push(line), () => new Date(T0));
}

interface FakeIncident extends StoredIncident {
  service: ServiceName;
  closedAt: Date | null;
}

/** In-memory IngestStore with the same one-open-incident rule as the database. */
export class FakeStore implements IngestStore {
  readonly services = new Map<ServiceName, StoredService>();
  readonly incidents: FakeIncident[] = [];
  readonly signals: SignalRow[] = [];
  failApply: Error | null = null;
  failInsert: Error | null = null;
  recent = new Map<ServiceName, ServiceMetrics>();
  applyCalls = 0;
  private seq = 0;
  private clock = T0;

  constructor(seed: Partial<Record<ServiceName, { level?: HauntLevel; reason?: HauntReason | null }>> = {}) {
    SERVICE_NAMES.forEach((name, i) => {
      this.services.set(name, {
        name,
        room: { x: i % 2, y: Math.floor(i / 2) },
        level: seed[name]?.level ?? 0,
        reason: seed[name]?.reason ?? null,
        openIncident: null,
        updatedAt: new Date(T0 - 1000),
      });
    });
  }

  addOpenIncident(service: ServiceName, peakLevel: HauntLevel, openedAt = new Date(T0 - 60_000)): string {
    const id = `inc${++this.seq}`;
    this.incidents.push({ id, service, openedAt, peakLevel, closedAt: null });
    return id;
  }

  openFor(service: ServiceName): FakeIncident[] {
    return this.incidents.filter((i) => i.service === service && i.closedAt === null);
  }

  loadServices(): Promise<StoredService[]> {
    return Promise.resolve(
      [...this.services.values()].map((s) => {
        const open = this.openFor(s.name)[0];
        return { ...s, openIncident: open ? { id: open.id, openedAt: open.openedAt, peakLevel: open.peakLevel } : null };
      }),
    );
  }

  insertSignals(rows: readonly SignalRow[]): Promise<void> {
    if (this.failInsert) return Promise.reject(this.failInsert);
    this.signals.push(...rows);
    return Promise.resolve();
  }

  applyChange(change: ServiceChange): Promise<AppliedChange> {
    this.applyCalls++;
    if (this.failApply) return Promise.reject(this.failApply);
    let updatedAt: Date | null = null;
    const svc = this.services.get(change.name);
    if (!svc) return Promise.reject(new Error('no such service'));
    if (change.haunt) {
      this.clock += 1000;
      updatedAt = new Date(this.clock);
      this.services.set(change.name, { ...svc, level: change.haunt.level, reason: change.haunt.reason, updatedAt });
    }
    const action = change.incident;
    let incident: StoredIncident | null = null;
    let created = false;
    let closedAt: Date | null = null;
    if (action.kind === 'open') {
      const existing = this.openFor(change.name)[0];
      if (existing) {
        if (action.peakLevel > existing.peakLevel) existing.peakLevel = action.peakLevel;
        incident = { id: existing.id, openedAt: existing.openedAt, peakLevel: existing.peakLevel };
      } else {
        const id = `inc${++this.seq}`;
        this.incidents.push({ id, service: change.name, openedAt: change.at, peakLevel: action.peakLevel, closedAt: null });
        incident = { id, openedAt: change.at, peakLevel: action.peakLevel };
        created = true;
      }
    } else if (action.kind === 'raise_peak') {
      const row = this.incidents.find((i) => i.id === change.incidentId);
      if (row) {
        row.peakLevel = action.peakLevel;
        incident = { id: row.id, openedAt: row.openedAt, peakLevel: row.peakLevel };
      }
    } else if (action.kind === 'close') {
      const row = this.incidents.find((i) => i.id === change.incidentId);
      if (row) {
        row.closedAt = change.at;
        closedAt = change.at;
      }
    }
    return Promise.resolve({ updatedAt, incident, created, closedAt });
  }

  recentMetrics(): Promise<Map<ServiceName, ServiceMetrics>> {
    return Promise.resolve(this.recent);
  }
}
