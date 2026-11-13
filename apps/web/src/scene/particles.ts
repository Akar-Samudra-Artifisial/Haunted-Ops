import type { HauntLevel } from '@haunted-ops/shared';
import { unit } from './rng.js';

export const GHOST_MAX = 12;
/** Fog puffs per room, in two layers: a low bank on the floor and drifting wisps above it. */
export const FOG_MAX = 20;
export const FOG_BANK_MAX = 10;
export const FOG_WISP_MAX = FOG_MAX - FOG_BANK_MAX;
/** Fog count to (bank, wisps): the bank fills first, so a thin fog hugs the floor. */
export function splitFog(count: number): { bank: number; wisps: number } {
  const n = Math.max(0, Math.min(FOG_MAX, Math.floor(count)));
  const bank = Math.min(FOG_BANK_MAX, Math.ceil(n / 2));
  return { bank, wisps: Math.min(FOG_WISP_MAX, n - bank) };
}
/** Ghosts stay in the back part of the floor: u + v (with the drift) never exceeds this, far from the nameplate at the front. */
export const GHOST_BACK_LIMIT = 0.8;
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

/**
 * Pure: the same seed and index always give the same ghost. Speeds are iso units per second.
 * Ghosts haunt the back of the room: with s = u + v and d = u - v, s is in [0.35, 0.6] and the
 * drift adds at most 0.16, so s stays under `GHOST_BACK_LIMIT`; |d| <= s - 0.3 keeps u and v
 * above 0.05 after the drift, so a ghost never leaves the floor.
 */
export function ghostSpec(seed: number, i: number): WispSpec {
  const r = (k: number): number => unit(seed, i, 100 + k);
  const s = 0.35 + 0.25 * r(1);
  const d = (r(2) * 2 - 1) * (s - 0.3);
  return {
    u: (s + d) / 2,
    v: (s - d) / 2,
    size: 0.7 + 0.4 * r(3),
    phase: r(4) * Math.PI * 2,
    speed: 0.05 + 0.1 * r(7),
    ampU: 0.03 + 0.05 * r(5),
    ampV: 0.03 + 0.05 * r(6),
  };
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
