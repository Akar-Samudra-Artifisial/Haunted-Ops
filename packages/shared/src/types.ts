/** The four lab services, in fixed room order. */
export const SERVICE_NAMES = ['gate', 'orders', 'payments', 'ledger'] as const;
export type ServiceName = (typeof SERVICE_NAMES)[number];

/** 0 calm ... 4 dark room. */
export const HAUNT_LEVELS = [0, 1, 2, 3, 4] as const;
export type HauntLevel = (typeof HAUNT_LEVELS)[number];

export const SIGNAL_KINDS = ['error_rate', 'p95_ms', 'up'] as const;
export type SignalKind = (typeof SIGNAL_KINDS)[number];

export interface RoomPosition {
  x: number;
  y: number;
}

/** Which signal sets the haunt level: a high error ratio, a slow p95, or a service that is down. */
export const HAUNT_REASON_KINDS = ['error_rate', 'p95', 'down'] as const;
export type HauntReasonKind = (typeof HAUNT_REASON_KINDS)[number];

/** `value` is the error ratio, the p95 in milliseconds, or the `up` average. */
export interface HauntReason {
  kind: HauntReasonKind;
  value: number;
}

/** The values of one Service from one successful poll. `null` means no value. */
export interface Sample {
  errorRate: number | null;
  p95Ms: number | null;
  up: number | null;
}

export interface ServiceMetrics extends Sample {
  /** ISO 8601 timestamp in UTC of the poll. */
  at: string;
}

export interface OpenIncident {
  id: string;
  openedAt: string;
  peakLevel: HauntLevel;
}

export interface ServiceState {
  name: ServiceName;
  room: RoomPosition;
  hauntLevel: HauntLevel;
  reason: HauntReason | null;
  /** `null` when nothing was recorded yet. */
  metrics: ServiceMetrics | null;
  openIncident: OpenIncident | null;
  /** ISO 8601 timestamp in UTC. */
  updatedAt: string;
}

/** Ingest status as sent on the wire. */
export interface IngestStatus {
  state: 'ok' | 'stale';
  /** Time of the last change of state (boot time before the first poll). */
  at: string;
  lastSuccessAt: string | null;
}

/** Validator result: the typed value, or the list of failing paths. Never thrown. */
export type Result<T> = { ok: true; value: T } | { ok: false; errors: string[] };
