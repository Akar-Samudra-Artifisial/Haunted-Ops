import type { HauntLevel, HauntReason, IngestStatus, OpenIncident, ServiceMetrics } from '@haunted-ops/shared';

export const NO_DATA = 'no data';

export const LEVEL_TEXT: Record<HauntLevel, string> = {
  0: 'calm',
  1: 'uneasy',
  2: 'haunted',
  3: 'possessed',
  4: 'dark',
};

/** One shape per level, so the level never depends on colour alone. */
export const LEVEL_MARKER: Record<HauntLevel, string> = {
  0: '○',
  1: '◔',
  2: '◑',
  3: '◕',
  4: '●',
};

/** `0.22` is "22%"; below 10% one decimal is kept ("1.2%"). */
export function formatErrorRatio(ratio: number | null): string {
  if (ratio === null) return NO_DATA;
  const pct = ratio * 100;
  return `${Number(pct.toFixed(pct < 10 ? 1 : 0))}%`;
}

/** Milliseconds below 1000 ("640 ms"), seconds from 1000 ("2.2 s"). */
export function formatP95(ms: number | null): string {
  if (ms === null) return NO_DATA;
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** `up` is an average over 30 s: 0.5 or more reads as up. */
export function formatUp(up: number | null): string {
  if (up === null) return NO_DATA;
  return up >= 0.5 ? 'up' : 'down';
}

/**
 * The reason as text. The stored reason value is the one at the last change of level or reason kind,
 * so while the same signal is still the cause, the live value from `metrics` is shown instead.
 */
export function formatReason(reason: HauntReason | null, metrics: ServiceMetrics | null = null): string {
  if (reason === null) return 'none';
  switch (reason.kind) {
    case 'error_rate':
      return `error rate ${formatErrorRatio(metrics?.errorRate ?? reason.value)}`;
    case 'p95':
      return `p95 ${formatP95(metrics?.p95Ms ?? reason.value)}`;
    case 'down':
      return 'service down';
  }
}

/** `HH:MM:SS UTC` from an ISO 8601 UTC timestamp. */
export function formatClock(iso: string): string {
  return `${iso.slice(11, 19)} UTC`;
}

export function formatIncident(incident: OpenIncident | null): string {
  if (incident === null) return 'none';
  return `opened ${formatClock(incident.openedAt)}, peak ${incident.peakLevel} (${LEVEL_TEXT[incident.peakLevel]})`;
}

export function formatStaleNotice(status: IngestStatus): string {
  return status.lastSuccessAt === null
    ? 'Metrics are stale. No update received yet.'
    : `Metrics are stale. Last update ${formatClock(status.lastSuccessAt)}.`;
}
