import {
  SERVICE_NAMES,
  type HauntLevel,
  type HauntReasonKind,
  type RoomPosition,
  type ServiceName,
  type ServiceState,
} from '@haunted-ops/shared';
import { LEVEL_TEXT, formatErrorRatio, formatP95, formatReason } from '../format.js';
import { huntCellText, huntView } from '../components/hunt-text.js';
import { proposalView, type ProposalPhase } from '../components/proposal-text.js';
import { clamp } from './math.js';
import {
  FOG_MAX,
  GHOST_MAX,
  MOTE_MAX,
  PARTICLE_CAP,
  PULSES_PER_CORRIDOR,
  allocateParticles,
  type RoomCounts,
} from './particles.js';
import { hashString } from './rng.js';

export { FOG_MAX, GHOST_MAX, MOTE_MAX, PARTICLE_CAP };

/** How a room looks at one level. Pure data: the one table the model, the Animator and the surface read. */
export interface RoomLook {
  /** Lamp glow, 0 to 1: the room's light. It rises with trouble and is 0 when dark. */
  glow: number;
  /** Danger tint on floor and walls, 0 to 1. */
  danger: number;
  /** Cold light along the edge of the room, 0 to 1 (the thin outline of a dark room). */
  edge: number;
  /** Which outline is drawn: the quiet trim, none (the cold edge is the outline), or the danger outline. */
  outline: 'trim' | 'edge' | 'danger';
  /** Alpha of that outline. */
  outlineAlpha: number;
  /** Fewest ghosts of a room whose trouble is errors. */
  ghostMin: number;
}

/**
 * calm: a dim lantern and no ghost. uneasy: a faint cold edge light. haunted: a clear danger tint, ghosts
 * visible. possessed: a strong danger glow, dense ghosts, the outline in the danger colour. dark: no light
 * at all and a near-black room with a thin cold outline.
 */
export const LEVEL_LOOK: readonly [RoomLook, RoomLook, RoomLook, RoomLook, RoomLook] = [
  { glow: 0.25, danger: 0, edge: 0, outline: 'trim', outlineAlpha: 0.35, ghostMin: 0 },
  { glow: 0.4, danger: 0, edge: 0.55, outline: 'edge', outlineAlpha: 0, ghostMin: 0 },
  { glow: 0.7, danger: 0.35, edge: 0.2, outline: 'trim', outlineAlpha: 0.5, ghostMin: 0 },
  { glow: 1, danger: 0.6, edge: 0, outline: 'danger', outlineAlpha: 0.9, ghostMin: 6 },
  { glow: 0, danger: 0, edge: 1, outline: 'edge', outlineAlpha: 0, ghostMin: 0 },
];
/** The fewest ghosts of an error room at a level: the largest `ghostMin` up to that level, so it never falls as trouble grows. */
export const ghostFloor = (level: HauntLevel): number => Math.max(...LEVEL_LOOK.slice(0, level + 1).map((l) => l.ghostMin));
/** A dark room (level 4, or `up` below 0.5) uses the last row whatever its level. */
export const DARK_LOOK: RoomLook = LEVEL_LOOK[4];
/** The look of a room: its level's row, or the dark row when the room is dark. */
export const lookOf = (level: HauntLevel, dark: boolean): RoomLook => (dark ? DARK_LOOK : LEVEL_LOOK[level]);
export const TRANSITION_MS = 1000;
/** A tremble of this many iso units at level 3. */
export const TREMBLE_AMPLITUDE = 0.012;

/** The Exorcist walks in over this long after a Hunt starts. */
export const ENTER_MS = 1200;
/** The figure stays this long after a Hunt ends, then leaves; the result mark stays. */
export const FIGURE_LINGER_MS = 8000;
/** Marks of the Hunt slot: one per step, at most this many. */
export const MAX_MARKS = 8;

/** What the scene draws of a Room's latest Hunt. Built from `huntView`, the same helper the table uses. */
export interface HuntVisual {
  phase: 'queued' | 'entering' | 'working' | 'sealed' | 'fizzled';
  /** The figure is drawn: while the Hunt runs and for 8 s after it ends (if it ever started). */
  figure: boolean;
  /** Lit marks in the Hunt slot, 0 to 8. */
  marks: number;
  result: 'none' | 'sealed' | 'failed';
  /** The table's hunt cell text. */
  label: string;
  /** Start time of the Hunt in ms (0 when it has not started); an animation restarts when it changes. */
  enteredAt: number;
}

const ms = (iso: string | null): number => (iso === null ? 0 : Date.parse(iso));

/** The visual of a Service's latest Hunt at time `now`, or null when it has none. Pure. */
export function huntVisual(hunt: ServiceState['hunt'], now: number): HuntVisual | null {
  if (hunt === null) return null;
  const view = huntView(hunt);
  const startedAt = ms(hunt.startedAt);
  const finishedAt = ms(hunt.finishedAt);
  const marks = Math.min(MAX_MARKS, hunt.stepCount);
  const label = huntCellText(view);
  switch (view.phase) {
    case 'none':
      return null;
    case 'queued':
      return { phase: 'queued', figure: false, marks: 0, result: 'none', label, enteredAt: 0 };
    case 'running':
      return { phase: now - startedAt < ENTER_MS ? 'entering' : 'working', figure: true, marks, result: 'none', label, enteredAt: startedAt };
    case 'sealed':
    case 'failed':
    case 'cancelled': {
      const figure = startedAt > 0 && now - finishedAt < FIGURE_LINGER_MS;
      return {
        phase: view.phase === 'sealed' ? 'sealed' : 'fizzled',
        figure,
        marks,
        result: view.phase === 'sealed' ? 'sealed' : 'failed',
        label,
        enteredAt: startedAt,
      };
    }
  }
}

/** The cleansing sweep after a fix is deployed lasts this long. */
export const CLEANSE_MS = 2400;

/** What the scene draws of a Room's latest Proposal. Built from `proposalView`, the same helper the table uses. */
export interface ProposalVisual {
  phase: Exclude<ProposalPhase, 'none'>;
  /** The table's fix cell text. */
  label: string;
  /** Identity of the Proposal: an animation restarts when it changes. */
  key: string;
}

/** The visual of a Service's latest Proposal, or null when it has none. Pure; the phase depends on the status only. */
export function proposalVisual(proposal: ServiceState['proposal']): ProposalVisual | null {
  const view = proposalView(proposal);
  if (proposal === null || view.phase === 'none') return null;
  return { phase: view.phase, label: view.cell, key: `${proposal.id}:${proposal.attempt}` };
}

export interface RoomVisual {
  name: ServiceName;
  grid: RoomPosition;
  level: HauntLevel;
  levelLabel: string;
  dark: boolean;
  light: number;
  /** The row of `LEVEL_LOOK` this room shows (the dark row when dark). */
  look: RoomLook;
  /** The Exorcist's mist is over this room: a Hunt is entering or working here. */
  mist: boolean;
  coolness: number;
  ghostCount: number;
  ghostOpacity: number;
  fogDensity: number;
  fogCount: number;
  moteCount: number;
  motion: { drift: number; flicker: number; tremble: number };
  badge: string;
  badgeShort: string;
  badgeKind: HauntReasonKind | null;
  incident: { open: boolean; peakLevel: HauntLevel | null };
  label: string;
  clock: { hour: number; minute: number };
  seed: number;
  hunt: HuntVisual | null;
  proposal: ProposalVisual | null;
  summary: string;
}

export interface SceneModel {
  rooms: RoomVisual[];
  particles: { wanted: number; total: number; cap: number; trimmed: boolean };
  reducedMotion: boolean;
  quality: 'full' | 'low';
  transitionMs: number;
  summary: string;
}

export interface ModelOptions {
  reducedMotion: boolean;
  quality: 'full' | 'low';
}

/** Level 4, or `up` below 0.5: the room is dark. The table uses the same function. */
export function isDark(service: Pick<ServiceState, 'hauntLevel' | 'metrics'>): boolean {
  const up = service.metrics?.up;
  return service.hauntLevel === 4 || (up !== null && up !== undefined && up < 0.5);
}

export function levelLabel(level: HauntLevel): string {
  return LEVEL_TEXT[level];
}

const finite = (v: number | null | undefined): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Error ratio that drives the ghosts: the metric, or the value of an error_rate reason. */
function errorValue(s: ServiceState): number | null {
  return finite(s.metrics?.errorRate) ?? (s.reason?.kind === 'error_rate' ? finite(s.reason.value) : null);
}

function p95Value(s: ServiceState): number | null {
  return finite(s.metrics?.p95Ms) ?? (s.reason?.kind === 'p95' ? finite(s.reason.value) : null);
}

function badgeShort(s: ServiceState): string {
  const reason = s.reason;
  if (reason === null) return '';
  switch (reason.kind) {
    case 'error_rate':
      return `ERR ${formatErrorRatio(finite(s.metrics?.errorRate) ?? reason.value)}`;
    case 'p95':
      return `P95 ${formatP95(finite(s.metrics?.p95Ms) ?? reason.value)}`;
    case 'down':
      return 'DOWN';
  }
}

function roomSummary(s: ServiceState, dark: boolean, badge: string, hunt: HuntVisual | null, proposal: ProposalVisual | null): string {
  let text = `${s.name}: ${levelLabel(s.hauntLevel)}`;
  if (dark && s.hauntLevel < 4) text += ', dark';
  if (badge !== '') text += `, ${badge}`;
  if (s.openIncident !== null) text += ', incident open';
  if (hunt !== null) text += `, hunt ${hunt.label}`;
  if (proposal !== null) text += `, ${proposal.label}`;
  return text;
}

function clockFor(now: number): { hour: number; minute: number } {
  const d = new Date(Number.isFinite(now) ? now : 0);
  const minutes = d.getUTCMinutes() + d.getUTCSeconds() / 60;
  return {
    hour: (((d.getUTCHours() % 12) + minutes / 60) / 12) * Math.PI * 2,
    minute: (minutes / 60) * Math.PI * 2,
  };
}

/** A corridor is as lit as the dimmer of its two rooms, and dark when either room is dark. */
export function corridorLight(a: Pick<RoomVisual, 'light' | 'dark'>, b: Pick<RoomVisual, 'light' | 'dark'>): number {
  return a.dark || b.dark ? 0 : Math.min(a.light, b.light);
}

/** Number of corridors: links between consecutive Services of SERVICE_NAMES that are present. */
export function corridorCount(names: readonly ServiceName[]): number {
  const present = SERVICE_NAMES.filter((n) => names.includes(n));
  return Math.max(0, present.length - 1);
}

/**
 * Pure description of the house. No PixiJS, no DOM, no clock and no randomness: the same
 * arguments always give the same result. All visuals derive from it.
 */
export function toSceneModel(services: readonly ServiceState[], now: number, options: ModelOptions): SceneModel {
  const { reducedMotion, quality } = options;
  const clock = clockFor(now);
  const half = (n: number): number => (quality === 'low' ? Math.ceil(n / 2) : n);

  const drafts = services.map((s) => {
    const dark = isDark(s);
    const level = s.hauntLevel;
    const e = clamp((errorValue(s) ?? 0) / 0.5, 0, 1);
    const f = clamp(((p95Value(s) ?? 0) - 200) / 2800, 0, 1);
    const errorReason = s.reason?.kind === 'error_rate';
    const p95Reason = s.reason?.kind === 'p95';
    // A calm room has no ghost. A possessed room whose trouble is errors has a dense crowd.
    const ghostCount = level === 0 ? 0 : Math.min(GHOST_MAX, Math.max(Math.round(e * GHOST_MAX), errorReason ? Math.max(level, ghostFloor(level)) : 0));
    // Fog grows with the level when slowness is the cause: at least 0.6 at level 2, 0.9 at level 3.
    const fogDensity = Math.min(1, Math.max(f, p95Reason ? 0.3 * level : 0));
    // Dust drifts in lit rooms only, and not in low quality (the Animator also hides it under reduced motion).
    const motes = dark || quality === 'low' ? 0 : level === 0 ? MOTE_MAX : level === 1 ? 3 : 0;
    return { s, dark, level, e, f, ghostCount, fogDensity, motes };
  });

  const wantedCounts: RoomCounts[] = drafts.map((d) => ({
    level: d.level,
    ghosts: half(d.ghostCount),
    fog: half(Math.ceil(d.fogDensity * FOG_MAX)),
    motes: half(d.motes),
  }));
  const allocated = allocateParticles(wantedCounts);
  const wanted = wantedCounts.reduce((n, r) => n + r.ghosts + r.fog + r.motes, 0);
  const roomTotal = allocated.reduce((n, r) => n + r.ghosts + r.fog + r.motes, 0);
  const pulses = corridorCount(services.map((s) => s.name)) * PULSES_PER_CORRIDOR;

  const rooms: RoomVisual[] = drafts.map((d, i) => {
    const { s, dark, level, e, f } = d;
    const counts = allocated[i] as RoomCounts;
    const badge = s.reason === null ? '' : formatReason(s.reason, s.metrics);
    const peak = s.openIncident?.peakLevel ?? null;
    const hunt = huntVisual(s.hunt, now);
    const proposal = proposalVisual(s.proposal);
    return {
      name: s.name,
      grid: { x: s.room.x, y: s.room.y },
      level,
      levelLabel: levelLabel(level),
      dark,
      light: lookOf(level, dark).glow,
      look: lookOf(level, dark),
      mist: hunt !== null && (hunt.phase === 'entering' || hunt.phase === 'working'),
      coolness: dark ? 0 : Math.min(1, 0.2 * level + 0.1 * Math.max(e, f)),
      ghostCount: counts.ghosts,
      ghostOpacity: counts.ghosts > 0 ? 0.25 + 0.6 * e : 0,
      fogDensity: d.fogDensity,
      fogCount: counts.fog,
      moteCount: counts.motes,
      motion: {
        drift: reducedMotion ? 0 : 0.3 + 0.7 * Math.max(e, f),
        flicker: reducedMotion ? 0 : level === 3 ? 0.3 : level === 2 ? 0.05 : 0,
        tremble: reducedMotion ? 0 : level === 3 ? TREMBLE_AMPLITUDE : 0,
      },
      badge,
      badgeShort: badgeShort(s),
      badgeKind: s.reason?.kind ?? null,
      incident: { open: s.openIncident !== null, peakLevel: peak },
      label: s.name,
      clock,
      seed: hashString(s.name),
      hunt,
      proposal,
      summary: roomSummary(s, dark, badge, hunt, proposal),
    };
  });

  return {
    rooms,
    particles: { wanted: wanted + pulses, total: roomTotal + pulses, cap: PARTICLE_CAP, trimmed: roomTotal < wanted },
    reducedMotion,
    quality,
    transitionMs: reducedMotion ? 0 : TRANSITION_MS,
    summary: rooms.length === 0 ? 'No rooms yet' : rooms.map((r) => r.summary).join('. '),
  };
}
