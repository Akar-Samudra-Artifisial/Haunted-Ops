import type { HauntLevel } from '@haunted-ops/shared';

/** A Service at this level or higher gets an Incident. */
export const INCIDENT_OPEN_AT_LEVEL = 2;
/** A Service must stay at level 0 this long, in successful Poll time, before its Incident closes. */
export const INCIDENT_CLOSE_AFTER_MS = 30_000;

export interface IncidentState {
  open: { id: string; peakLevel: HauntLevel } | null;
  /** Level-0 time counted so far, from the timestamps of consecutive Polls that had data. */
  calmMs: number;
  /** Time of the previous Poll that had data and was at level 0, or null when the stretch is broken. */
  lastCalmAt: number | null;
}

export type IncidentAction =
  | { kind: 'none' }
  | { kind: 'open'; peakLevel: HauntLevel }
  | { kind: 'raise_peak'; peakLevel: HauntLevel }
  | { kind: 'close'; peakLevel: HauntLevel };

/**
 * Pure incident policy, called once per successful Poll that had data, with the level after hysteresis.
 * - No open Incident: open one at level 2 or higher.
 * - Open Incident above level 0: keep it, raise the peak when the level exceeds it, restart the calm count.
 * - Open Incident at level 0: add the time since the previous level-0 Poll with data, and close the
 *   Incident once 30 s are counted.
 * A failed Poll or a Poll without data does not call it; the caller sets `lastCalmAt` to null so the
 * time of that Poll is not counted.
 */
export function nextIncident(
  state: IncidentState,
  level: HauntLevel,
  atMs: number,
): { calmMs: number; lastCalmAt: number | null; action: IncidentAction } {
  if (state.open === null) {
    if (level >= INCIDENT_OPEN_AT_LEVEL) return { calmMs: 0, lastCalmAt: null, action: { kind: 'open', peakLevel: level } };
    return { calmMs: 0, lastCalmAt: null, action: { kind: 'none' } };
  }
  if (level > 0) {
    const action: IncidentAction = level > state.open.peakLevel ? { kind: 'raise_peak', peakLevel: level } : { kind: 'none' };
    return { calmMs: 0, lastCalmAt: null, action };
  }
  const delta = state.lastCalmAt === null ? 0 : Math.max(0, atMs - state.lastCalmAt);
  const calmMs = state.calmMs + delta;
  const action: IncidentAction =
    calmMs >= INCIDENT_CLOSE_AFTER_MS ? { kind: 'close', peakLevel: state.open.peakLevel } : { kind: 'none' };
  return { calmMs, lastCalmAt: atMs, action };
}
