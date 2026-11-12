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

export interface ServiceState {
  name: ServiceName;
  room: RoomPosition;
  hauntLevel: HauntLevel;
  /** ISO 8601 timestamp in UTC. */
  updatedAt: string;
}

/** Validator result: the typed value, or the list of failing paths. Never thrown. */
export type Result<T> = { ok: true; value: T } | { ok: false; errors: string[] };
