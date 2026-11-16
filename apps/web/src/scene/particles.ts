import type { HauntLevel } from '@haunted-ops/shared';
import { unit } from './rng.js';

export const GHOST_MAX = 12;
/** Fog puffs per room, in two layers: a low bank on the floor and drifting wisps above it. */
export const FOG_MAX = 20;
/** The three ghost sprites (`visual-refresh` part 4): calm, drift, angry. */
export type GhostKind = 0 | 1 | 2;
export const GHOST_KINDS = 3;
/**
 * The sprite of ghost slot `i` of a room at `level`: haunted and uneasy rooms alternate calm and drift, a possessed (or
 * darker) room shows mostly angry with every fourth slot drifting. The slots of a room are shared out, never added to.
 */
export function ghostKind(level: number, i: number): GhostKind {
  if (level >= 3) return i % 4 === 3 ? 1 : 2;
  return level <= 0 ? 0 : i % 2 === 0 ? 0 : 1;
}
/** The most slots of one room that one variant pool ever holds (over every level), so a pool is sized once. */
export const GHOST_KIND_MAX: readonly [number, number, number] = (() => {
  const max = [0, 0, 0];
  for (let level = 0; level <= 4; level++) {
    const n = [0, 0, 0];
    for (let i = 0; i < GHOST_MAX; i++) n[ghostKind(level, i)] = (n[ghostKind(level, i)] as number) + 1;
    for (let k = 0; k < GHOST_KINDS; k++) max[k] = Math.max(max[k] as number, n[k] as number);
  }
  return [max[0] as number, max[1] as number, max[2] as number];
})();
export const FOG_BANK_MAX = 10;
export const FOG_WISP_MAX = FOG_MAX - FOG_BANK_MAX;
/** Fog count to (bank, wisps): the bank fills first, so a thin fog hugs the floor. */
export function splitFog(count: number): { bank: number; wisps: number } {
  const n = Math.max(0, Math.min(FOG_MAX, Math.floor(count)));
  const bank = Math.min(FOG_BANK_MAX, Math.ceil(n / 2));
  return { bank, wisps: Math.min(FOG_WISP_MAX, n - bank) };
}
export const MOTE_MAX = 6;
/** Pulses on the corridors, counted in the total. */
export const PULSE_MAX = 12;
export const PULSES_PER_CORRIDOR = 3;
export const PARTICLE_CAP = 200;
/** What the rooms may use together. */
export const ROOM_PARTICLE_BUDGET = PARTICLE_CAP - PULSE_MAX;

export interface RoomCounts {
  level: HauntLevel;
  ghosts: number;
  fog: number;
  motes: number;
}

/**
 * Trims the wanted counts to the budget. Order: ambient motes first, then fog puffs, then ghosts;
 * inside a class, from the room with the lowest level up (ties by room order). Pure. Nothing is
 * trimmed when the wanted total fits, and no count ever grows.
 */
export function allocateParticles(wanted: readonly RoomCounts[], budget: number = ROOM_PARTICLE_BUDGET): RoomCounts[] {
  const out = wanted.map((r) => ({ ...r }));
  let excess = out.reduce((n, r) => n + r.ghosts + r.fog + r.motes, 0) - budget;
  if (excess <= 0) return out;
  const order = out.map((_, i) => i).sort((a, b) => (out[a] as RoomCounts).level - (out[b] as RoomCounts).level || a - b);
  for (const key of ['motes', 'fog', 'ghosts'] as const) {
    for (const i of order) {
      if (excess <= 0) return out;
      const room = out[i] as RoomCounts;
      const take = Math.min(excess, room[key]);
      room[key] -= take;
      excess -= take;
    }
  }
  return out;
}

/** Normalised position (u, v in the iso square of the floor), size and path of one wisp. */
export interface WispSpec {
  u: number;
  v: number;
  size: number;
  phase: number;
  speed: number;
  ampU: number;
  ampV: number;
}

function wisp(seed: number, i: number, salt: number, sizeLo: number, sizeHi: number, speedLo: number, speedHi: number): WispSpec {
  const r = (k: number): number => unit(seed, i, salt + k);
  const ampU = 0.04 + 0.1 * r(5);
  const ampV = 0.04 + 0.1 * r(6);
  return {
    // Centre plus amplitude stays inside [0.05, 0.95], so a wisp never leaves the floor.
    u: 0.2 + 0.6 * r(1),
    v: 0.2 + 0.6 * r(2),
    size: sizeLo + (sizeHi - sizeLo) * r(3),
    phase: r(4) * Math.PI * 2,
    speed: speedLo + (speedHi - speedLo) * r(7),
    ampU,
    ampV,
  };
}

/** Width over height of the ghost texture (96 by 144). */
export const GHOST_ASPECT = 96 / 144;
/** Ghosts rest inside this band of the floor on both axes (u and v in 0..1). */
export const GHOST_BAND = { lo: 0.25, hi: 0.8 } as const;
/** Smallest distance between two ghosts of a room, as a share of the wider ghost's width. */
export const GHOST_GAP = 0.6;
/** Height of a ghost in iso units. */
export const GHOST_SIZE = { lo: 0.5, hi: 0.8 } as const;
/** The floor edge in iso units: the unit of the distance above. */
const FLOOR_UNITS = 2;
/** Spacing of the resting sites in u and v: a little more than 0.6 of the widest ghost (0.8 · 96/144) over the floor edge. */
const SITE_SPACING = 0.165;
const SITE_ROW = SITE_SPACING * 0.866;
const SITE_ROWS = 4;

/**
 * The resting sites of the ghosts of one room: a hex lattice (rows of 4 and 3 sites, 14 in all) whose spacing is
 * above the minimum distance, shifted inside the band by the seed. Every pair of sites is at least `SITE_SPACING` apart.
 */
function ghostSites(seed: number): Array<{ u: number; v: number }> {
  const r = (k: number): number => unit(seed, 0, 100 + k);
  const u0 = GHOST_BAND.lo + (GHOST_BAND.hi - GHOST_BAND.lo - (SITE_ROWS - 1) * SITE_ROW) * r(1);
  const v0 = GHOST_BAND.lo + (GHOST_BAND.hi - GHOST_BAND.lo - 3 * SITE_SPACING) * r(2);
  const sites: Array<{ u: number; v: number }> = [];
  for (let row = 0; row < SITE_ROWS; row++) {
    const odd = row % 2 === 1;
    for (let k = 0; k < (odd ? 3 : 4); k++) sites.push({ u: u0 + row * SITE_ROW, v: v0 + (k + (odd ? 0.5 : 0)) * SITE_SPACING });
  }
  return sites;
}

/**
 * Pure: the same seed and index always give the same ghost. Speeds are iso units per second.
 * Ghosts are spread over the room: slot i takes site `order[i]` of a lattice inside `GHOST_BAND`, with the order
 * shuffled by the seed, so any first n slots are at least `GHOST_GAP` of a ghost width apart and the slots appear
 * in index order without ever sharing a spot. The drift is small (at most 0.027), so a ghost never leaves the floor.
 */
export function ghostSpec(seed: number, i: number): WispSpec {
  const r = (k: number): number => unit(seed, i, 100 + k);
  const sites = ghostSites(seed);
  const order = sites.map((_, k) => k);
  for (let k = order.length - 1; k > 0; k--) {
    const j = Math.floor(unit(seed, k, 150) * (k + 1));
    [order[k], order[j]] = [order[j] as number, order[k] as number];
  }
  const site = sites[order[i % sites.length] as number] as { u: number; v: number };
  return {
    u: site.u,
    v: site.v,
    size: GHOST_SIZE.lo + (GHOST_SIZE.hi - GHOST_SIZE.lo) * r(3),
    phase: r(4) * Math.PI * 2,
    speed: 0.05 + 0.1 * r(7),
    ampU: 0.012 + 0.015 * r(5),
    ampV: 0.012 + 0.015 * r(6),
  };
}

/** The distance two ghosts of a room need at rest, in iso units: `GHOST_GAP` of the wider one. */
export function ghostMinDistance(a: WispSpec, b: WispSpec): number {
  return GHOST_GAP * GHOST_ASPECT * Math.max(a.size, b.size);
}
/** The distance of two ghosts at rest, in iso units. */
export function ghostDistance(a: WispSpec, b: WispSpec): number {
  return FLOOR_UNITS * Math.hypot(a.u - b.u, a.v - b.v);
}

/** Pure: a drifting fog wisp above the floor bank. */
export function fogSpec(seed: number, i: number): WispSpec {
  return wisp(seed, i, 200, 1.2, 2.0, 0.02, 0.05);
}

/** Pure: a puff of the low fog bank that hugs the floor (wide, flat texture, slow). */
export function fogBankSpec(seed: number, i: number): WispSpec {
  const r = (k: number): number => unit(seed, i, 400 + k);
  return {
    u: 0.2 + 0.6 * r(1),
    v: 0.2 + 0.6 * r(2),
    size: 0.55 + 0.3 * r(3),
    phase: r(4) * Math.PI * 2,
    speed: 0.01 + 0.02 * r(7),
    ampU: 0.03 + 0.06 * r(5),
    ampV: 0.03 + 0.06 * r(6),
  };
}

/** Pure: a calm-room dust mote. */
export function moteSpec(seed: number, i: number): WispSpec {
  return wisp(seed, i, 300, 0.12, 0.3, 0.03, 0.08);
}
