import type { ServiceName, ServiceState } from '@haunted-ops/shared';
import { diffServices } from '../components/changes.js';
import { isDark } from '../scene/model.js';

/** The eight sound cues, one file each in `public/sfx/<cue>.mp3`. */
export type CueName = 'ghost-appear' | 'possessed' | 'room-dark' | 'calm-restored' | 'hunt-start' | 'hunt-step' | 'diagnosed' | 'fix-merged';

/** Highest priority first: when two cues compete inside the window, the earlier one in this list plays. */
export const CUE_PRIORITY: readonly CueName[] = ['room-dark', 'possessed', 'ghost-appear', 'diagnosed', 'fix-merged', 'hunt-start', 'calm-restored', 'hunt-step'];

/** At most one cue in this many ms; `hunt-step` at most once in `STEP_GAP_MS`; the same cue for the same room at most once in `ROOM_GAP_MS`. */
export const CUE_GAP_MS = 700;
export const STEP_GAP_MS = 3000;
export const ROOM_GAP_MS = 5000;

export interface SoundCue {
  cue: CueName;
  room: ServiceName;
}

const rank = (cue: CueName): number => CUE_PRIORITY.indexOf(cue);

/**
 * The cues for the change from `prev` to `next`, in priority order, with no repeat of the same cue for the same room. Pure. It reads the same changes as
 * the announcer (`diffServices`): a room's level rises to haunted (`ghost-appear`) or possessed (`possessed`); a room turns dark (`room-dark`); a
 * room is back to calm from haunted or worse, or from dark (`calm-restored`); a hunt starts (`hunt-start`), takes a step (`hunt-step`) or is
 * diagnosed (`diagnosed`); a fix is merged (`fix-merged`). A service seen for the first time makes no cue.
 */
export function soundCues(prev: readonly ServiceState[], next: readonly ServiceState[]): SoundCue[] {
  const changes = diffServices(prev, next);
  const out: SoundCue[] = [];
  const add = (cue: CueName, room: ServiceName): void => {
    if (!out.some((c) => c.cue === cue && c.room === room)) out.push({ cue, room });
  };
  for (const c of changes.levels) {
    if (c.to > c.from && c.to === 2) add('ghost-appear', c.name);
    else if (c.to > c.from && c.to === 3) add('possessed', c.name);
  }
  for (const c of changes.dark) {
    if (c.dark) add('room-dark', c.name);
    else if (c.level === 0) add('calm-restored', c.name);
  }
  // A room that is lit again at level 0 after a level of haunted or worse (a dark room has the level it had, or 4).
  const nowDark = new Set(changes.dark.filter((c) => c.dark).map((c) => c.name));
  const nextByName = new Map(next.map((s) => [s.name, s]));
  for (const c of changes.levels) {
    const s = nextByName.get(c.name);
    if (c.to === 0 && c.from >= 2 && s !== undefined && !nowDark.has(c.name) && !isDark(s)) add('calm-restored', c.name);
  }
  for (const c of changes.hunts) {
    if (c.kind === 'started') add('hunt-start', c.name);
    else if (c.kind === 'step') add('hunt-step', c.name);
    else if (c.kind === 'diagnosed') add('diagnosed', c.name);
  }
  for (const c of changes.proposals) {
    const merged = c.proposal.status === 'merged' || c.proposal.status === 'deployed';
    const wasMerged = c.statusBefore === 'merged' || c.statusBefore === 'deployed';
    if (merged && !wasMerged) add('fix-merged', c.name);
  }
  return out.sort((a, b) => rank(a.cue) - rank(b.cue));
}

/** What the limiter remembers between snapshots. */
export interface CueGate {
  /** The list of Services of the last snapshot, or null before the first one. */
  prev: readonly ServiceState[] | null;
  /** When the last cue played, and when the last `hunt-step` did (-Infinity: never). */
  lastAt: number;
  stepAt: number;
  /** When each cue last played for each room, keyed `cue:room`. */
  played: Readonly<Record<string, number>>;
}

export function createCueGate(): CueGate {
  return { prev: null, lastAt: Number.NEGATIVE_INFINITY, stepAt: Number.NEGATIVE_INFINITY, played: {} };
}

/**
 * The next snapshot of Services at time `now` (ms). Returns the new gate and the one cue to play, or null. The first snapshot gives none (it only
 * becomes the state to compare with). A cue is dropped when another played less than 700 ms ago, when it is `hunt-step` and one played less than
 * 3 s ago, or when the same cue played for the same room less than 5 s ago; of the cues left, the highest priority plays. A dropped cue is
 * not counted as played. Pure.
 */
export function nextCue(gate: CueGate, services: readonly ServiceState[], now: number): { gate: CueGate; play: SoundCue | null } {
  if (gate.prev === null) return { gate: { ...gate, prev: services }, play: null };
  const candidates = soundCues(gate.prev, services).filter((c) => {
    if (now - (gate.played[`${c.cue}:${c.room}`] ?? Number.NEGATIVE_INFINITY) < ROOM_GAP_MS) return false;
    if (c.cue === 'hunt-step' && now - gate.stepAt < STEP_GAP_MS) return false;
    return true;
  });
  const play = now - gate.lastAt < CUE_GAP_MS ? null : (candidates[0] ?? null);
  if (play === null) return { gate: { ...gate, prev: services }, play: null };
  return {
    gate: {
      prev: services,
      lastAt: now,
      stepAt: play.cue === 'hunt-step' ? now : gate.stepAt,
      played: { ...gate.played, [`${play.cue}:${play.room}`]: now },
    },
    play,
  };
}
