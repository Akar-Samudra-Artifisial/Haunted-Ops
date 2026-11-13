import {
  SERVICE_NAMES,
  type HauntLevel,
  type HauntReasonKind,
  type RoomPosition,
  type ServiceName,
  type ServiceState,
} from '@haunted-ops/shared';
import { LEVEL_TEXT, formatErrorRatio, formatP95, formatReason } from '../format.js';
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

export const LIGHT_BY_LEVEL = [1, 0.85, 0.65, 0.5, 0] as const;
export const TRANSITION_MS = 1000;
/** A tremble of this many iso units at level 3. */
export const TREMBLE_AMPLITUDE = 0.012;

/** Filled by `exorcist-agent`; absent in this spec. */
export interface HuntVisual {
  phase: string;
  label: string;
  /** 0 to 1. */
  progress: number;
}

export interface RoomVisual {
  name: ServiceName;
  grid: RoomPosition;
  level: HauntLevel;
  levelLabel: string;
  dark: boolean;
  light: number;
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
  hunt?: HuntVisual | null;
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

function roomSummary(s: ServiceState, dark: boolean, badge: string): string {
  let text = `${s.name}: ${levelLabel(s.hauntLevel)}`;
  if (dark && s.hauntLevel < 4) text += ', dark';
  if (badge !== '') text += `, ${badge}`;
  if (s.openIncident !== null) text += ', incident open';
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
    const ghostCount = Math.min(GHOST_MAX, Math.max(Math.round(e * GHOST_MAX), errorReason ? level : 0));
    // Fog grows with the level when slowness is the cause: at least 0.6 at level 2, 0.9 at level 3.
    const fogDensity = Math.min(1, Math.max(f, p95Reason ? 0.3 * level : 0));
    const motes = dark ? 0 : level === 0 ? MOTE_MAX : level === 1 ? 3 : 0;
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
    return {
      name: s.name,
      grid: { x: s.room.x, y: s.room.y },
      level,
      levelLabel: levelLabel(level),
      dark,
      light: dark ? 0 : LIGHT_BY_LEVEL[level] * (1 - 0.2 * e) * (1 - 0.3 * f),
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
      summary: roomSummary(s, dark, badge),
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
