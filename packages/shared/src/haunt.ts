import type { HauntLevel, HauntReason, Sample } from './types.js';

/** Error ratio thresholds for levels 1, 2 and 3. */
export const ERROR_RATE_THRESHOLDS = [0.05, 0.2, 0.5] as const;
/** p95 thresholds in milliseconds for levels 1, 2 and 3. */
export const P95_MS_THRESHOLDS = [500, 1000, 3000] as const;
/** An `up` average below this value means the service is down (level 4). */
export const UP_DOWN_BELOW = 0.5;
/** Consecutive polls with a higher raw level before the level rises. */
export const RAISE_AFTER_POLLS = 2;
/** Consecutive polls with a lower raw level before the level falls. */
export const LOWER_AFTER_POLLS = 3;

export interface Scored {
  level: HauntLevel;
  reason: HauntReason | null;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function levelFor(value: number | null, thresholds: readonly number[]): HauntLevel {
  if (value === null) return 0;
  let level = 0;
  for (const t of thresholds) if (value >= t) level += 1;
  return level as HauntLevel;
}

/**
 * Maps one Sample to a raw haunt level and the reason for it. Pure and total.
 * A value that is not a finite number counts as `null`; a negative error ratio or p95 counts as 0.
 * Among signals at the same level the reason prefers `down`, then `error_rate`, then `p95`.
 */
export function scoreSample(sample: Sample): Scored {
  const errorRaw = finiteOrNull(sample.errorRate);
  const p95Raw = finiteOrNull(sample.p95Ms);
  const up = finiteOrNull(sample.up);
  const errorRate = errorRaw === null ? null : Math.max(0, errorRaw);
  const p95Ms = p95Raw === null ? null : Math.max(0, p95Raw);

  const candidates: Array<{ level: HauntLevel; reason: HauntReason | null }> = [
    {
      level: up !== null && up < UP_DOWN_BELOW ? 4 : 0,
      reason: up === null ? null : { kind: 'down', value: up },
    },
    {
      level: levelFor(errorRate, ERROR_RATE_THRESHOLDS),
      reason: errorRate === null ? null : { kind: 'error_rate', value: errorRate },
    },
    {
      level: levelFor(p95Ms, P95_MS_THRESHOLDS),
      reason: p95Ms === null ? null : { kind: 'p95', value: p95Ms },
    },
  ];
  let best: Scored = { level: 0, reason: null };
  for (const c of candidates) {
    if (c.level > best.level) best = { level: c.level, reason: c.reason };
  }
  return best;
}

/** A Sample with no value at all: the service has no series this poll. */
export function isNoData(sample: Sample): boolean {
  return (
    finiteOrNull(sample.errorRate) === null && finiteOrNull(sample.p95Ms) === null && finiteOrNull(sample.up) === null
  );
}

export interface Pending {
  count: number;
  /** Candidate level: the lowest raw level of a rising streak, the highest of a falling one. */
  level: HauntLevel;
  /** Reason of the Sample that gave the candidate level (the later one on a tie). */
  reason: HauntReason | null;
}

export interface HauntState {
  level: HauntLevel;
  reason: HauntReason | null;
  /** Consecutive polls with a raw level above `level`. */
  higher: Pending | null;
  /** Consecutive polls with a raw level below `level`. */
  lower: Pending | null;
}

export function initialHauntState(level: HauntLevel, reason: HauntReason | null): HauntState {
  return { level, reason, higher: null, lower: null };
}

/**
 * Hysteresis. The level rises after RAISE_AFTER_POLLS consecutive higher raw levels (to the lowest of them)
 * and falls after LOWER_AFTER_POLLS consecutive lower ones (to the highest of them). Pure.
 */
export function stepHaunt(state: HauntState, sample: Sample): HauntState {
  if (isNoData(sample)) return state;
  const raw = scoreSample(sample);

  if (raw.level === state.level) {
    return { level: state.level, reason: raw.reason, higher: null, lower: null };
  }

  if (raw.level > state.level) {
    const prev = state.higher;
    const next: Pending =
      prev === null
        ? { count: 1, level: raw.level, reason: raw.reason }
        : {
            count: prev.count + 1,
            level: raw.level <= prev.level ? raw.level : prev.level,
            reason: raw.level <= prev.level ? raw.reason : prev.reason,
          };
    if (next.count >= RAISE_AFTER_POLLS) {
      return { level: next.level, reason: next.reason, higher: null, lower: null };
    }
    return { level: state.level, reason: state.reason, higher: next, lower: null };
  }

  const prev = state.lower;
  const next: Pending =
    prev === null
      ? { count: 1, level: raw.level, reason: raw.reason }
      : {
          count: prev.count + 1,
          level: raw.level >= prev.level ? raw.level : prev.level,
          reason: raw.level >= prev.level ? raw.reason : prev.reason,
        };
  if (next.count >= LOWER_AFTER_POLLS) {
    return { level: next.level, reason: next.reason, higher: null, lower: null };
  }
  return { level: state.level, reason: state.reason, higher: null, lower: next };
}

/** True when the level or the reason kind differs. A change of the reason value alone does not count. */
export function hauntChanged(prev: HauntState, next: HauntState): boolean {
  return prev.level !== next.level || (prev.reason?.kind ?? null) !== (next.reason?.kind ?? null);
}
