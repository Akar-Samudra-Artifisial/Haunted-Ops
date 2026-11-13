import type { ServiceName } from '@haunted-ops/shared';
import type { Pt, RoomLayout, SceneLayout } from './layout.js';
import { approach } from './math.js';
import { corridorLight, type RoomVisual, type SceneModel } from './model.js';
import {
  FOG_BANK_MAX,
  FOG_WISP_MAX,
  GHOST_MAX,
  MOTE_MAX,
  PARTICLE_CAP,
  PULSES_PER_CORRIDOR,
  fogBankSpec,
  fogSpec,
  ghostSpec,
  moteSpec,
  splitFog,
  type WispSpec,
} from './particles.js';
import { unit } from './rng.js';
import { CORRIDOR_STYLE } from './shapes.js';
import type { Frame, ParticleBuffer, RoomFrame } from './surface.js';

/** Rooms the buffers are sized for (a 3 by 3 house). */
export const MAX_ROOMS = 9;
export const MAX_PULSES = 12;
/** A frame step is never longer than this, so a hidden tab does not make a jump. */
export const MAX_STEP_MS = 100;
export const DARK_DIM = 0.92;

export interface Animator {
  setLayout(layout: SceneLayout): void;
  setModel(model: SceneModel): void;
  select(name: ServiceName | null): void;
  /** Returns the same Frame object every time. */
  step(dtMs: number, timeMs: number): Frame;
}

function buffer(capacity: number): ParticleBuffer {
  return {
    capacity,
    count: 0,
    x: new Float32Array(capacity),
    y: new Float32Array(capacity),
    size: new Float32Array(capacity),
    alpha: new Float32Array(capacity),
    rotation: new Float32Array(capacity),
  };
}

interface RoomState {
  frame: RoomFrame;
  ghostA: Float32Array;
  fogA: Float32Array;
  bankA: Float32Array;
  moteA: Float32Array;
  /** The wisp specs depend only on the room seed: computed once, never per frame. */
  seed: number;
  ghostS: WispSpec[];
  fogS: WispSpec[];
  bankS: WispSpec[];
  moteS: WispSpec[];
}

/** Fog alpha targets for a density from 0 to 1: clearly visible from the first puff. */
export const FOG_ALPHA = {
  bank: (density: number): number => 0.3 + 0.4 * density,
  wisp: (density: number): number => 0.25 + 0.35 * density,
} as const;

/** Every visible particle of a Frame. */
export function visibleParticles(frame: Frame): number {
  return frame.ghosts.count + frame.fog.count + frame.fogBank.count + frame.motes.count + frame.pulses.count;
}

const specs = (seed: number, n: number, spec: (seed: number, i: number) => WispSpec): WispSpec[] =>
  Array.from({ length: n }, (_, i) => spec(seed, i));

const smooth = (f: number): number => f * f * (3 - 2 * f);

/** Smooth value noise in [0, 1]: changes direction at most once per unit of `t`. */
export function valueNoise(seed: number, t: number, salt: number): number {
  const i = Math.floor(t);
  const f = smooth(t - i);
  const a = unit(seed, i, salt);
  const b = unit(seed, i + 1, salt);
  return a + (b - a) * f;
}

const EPS = 1e-3;

export function createAnimator(): Animator {
  let layout: SceneLayout | null = null;
  let model: SceneModel | null = null;
  const states = new Map<ServiceName, RoomState>();
  let corridorLit: number[] = [];

  const frame: Frame = {
    time: 0,
    rooms: [],
    corridors: [],
    ghosts: buffer(MAX_ROOMS * GHOST_MAX),
    fog: buffer(MAX_ROOMS * FOG_WISP_MAX),
    fogBank: buffer(MAX_ROOMS * FOG_BANK_MAX),
    motes: buffer(MAX_ROOMS * MOTE_MAX),
    pulses: buffer(MAX_PULSES),
    selected: null,
    moving: true,
  };

  const visualOf = (name: ServiceName): RoomVisual | undefined => model?.rooms.find((r) => r.name === name);

  function stateOf(name: ServiceName, v: RoomVisual): RoomState {
    let s = states.get(name);
    if (!s) {
      s = {
        frame: {
          name,
          light: v.light,
          coolness: v.coolness,
          dim: v.dark ? DARK_DIM : 0,
          flicker: 1,
          shakeX: 0,
          shakeY: 0,
          lampBreath: 0.5,
          outlineAlpha: v.dark ? 1 : 0.35,
          badgeAlpha: v.badge === '' ? 0 : 1,
          clock: v.clock,
          incident: v.incident.open,
          dark: v.dark,
        },
        ghostA: new Float32Array(GHOST_MAX),
        fogA: new Float32Array(FOG_WISP_MAX),
        bankA: new Float32Array(FOG_BANK_MAX),
        moteA: new Float32Array(MOTE_MAX),
        seed: Number.NaN,
        ghostS: [],
        fogS: [],
        bankS: [],
        moteS: [],
      };
      states.set(name, s);
    }
    if (s.seed !== v.seed) {
      s.seed = v.seed;
      s.ghostS = specs(v.seed, GHOST_MAX, ghostSpec);
      s.fogS = specs(v.seed, FOG_WISP_MAX, fogSpec);
      s.bankS = specs(v.seed, FOG_BANK_MAX, fogBankSpec);
      s.moteS = specs(v.seed, MOTE_MAX, moteSpec);
    }
    return s;
  }

  function rebuild(): void {
    if (!layout || !model) return;
    const rooms: RoomFrame[] = [];
    for (const lr of layout.rooms) {
      const v = visualOf(lr.name);
      if (v) rooms.push(stateOf(lr.name, v).frame);
    }
    frame.rooms = rooms;
    if (corridorLit.length !== layout.corridors.length) corridorLit = layout.corridors.map(() => 0);
    frame.corridors = layout.corridors.map((_, i) => ({ lit: corridorLit[i] ?? 0 }));
    frame.moving = true;
  }

  const scratch: Pt = { x: 0, y: 0 };
  const flag = { moving: false };

  /** Writes the position of a wisp on the floor of a room, with its drift, into `scratch`. */
  function place(spec: WispSpec, room: RoomLayout, timeMs: number, motion: number): void {
    const top = room.floor[0];
    const right = room.floor[1];
    const left = room.floor[3];
    const t = timeMs / 1000;
    const u = spec.u + spec.ampU * Math.sin(spec.phase + (motion === 0 ? 0 : t * (spec.speed / spec.ampU) * motion));
    const v = spec.v + spec.ampV * Math.sin(spec.phase * 1.7 + (motion === 0 ? 0 : t * (spec.speed / spec.ampV) * motion));
    scratch.x = top.x + u * (right.x - top.x) + v * (left.x - top.x);
    scratch.y = top.y + u * (right.y - top.y) + v * (left.y - top.y);
  }

  function fill(
    buf: ParticleBuffer,
    slots: Float32Array,
    count: number,
    target: number,
    spec: readonly WispSpec[],
    room: RoomLayout,
    v: RoomVisual,
    timeMs: number,
    dt: number,
    tau: number,
    lift: number,
    sizeScale: number,
    /** Largest y of the anchor point (ghost feet stay above the text). */
    yMax: number,
  ): void {
    const motion = v.motion.drift;
    const capacity = slots.length;
    for (let i = 0; i < capacity; i++) {
      const wanted = i < count ? target : 0;
      // Slots appear in index order and leave in reverse order, which staggers them.
      const slow = i < count ? 1 + 0.12 * i : 1 + 0.12 * (capacity - 1 - i);
      const a = approach(slots[i] as number, wanted, dt, tau * slow);
      slots[i] = a;
      if (Math.abs(a - wanted) > EPS) flag.moving = true;
      if (a <= 0.004) continue;
      const k = buf.count;
      if (k >= buf.capacity) continue;
      const s = spec[i] as WispSpec;
      place(s, room, timeMs, motion);
      buf.x[k] = scratch.x;
      buf.y[k] = Math.min(scratch.y - lift * s.size * (layout as SceneLayout).scale, yMax);
      buf.size[k] = s.size * sizeScale * (layout as SceneLayout).scale;
      buf.alpha[k] = a;
      buf.rotation[k] = motion === 0 ? 0 : 0.12 * Math.sin(s.phase + (timeMs / 1000) * 1.3 * motion);
      buf.count = k + 1;
    }
  }

  /** Takes up to `excess` slots from the end of a buffer; returns what is left to drop. Allocates nothing. */
  function trim(buf: ParticleBuffer, excess: number): number {
    const take = Math.min(excess, buf.count);
    buf.count -= take;
    return excess - take;
  }

  /** Drops fading slots until the visible total fits the cap: fog wisps, the fog bank, motes, then ghosts. */
  function enforceCap(): void {
    let excess = visibleParticles(frame) - PARTICLE_CAP;
    if (excess <= 0) return;
    excess = trim(frame.fog, excess);
    excess = trim(frame.fogBank, excess);
    excess = trim(frame.motes, excess);
    trim(frame.ghosts, excess);
  }

  return {
    setLayout(next) {
      layout = next;
      rebuild();
    },
    setModel(next) {
      model = next;
      rebuild();
    },
    select(name) {
      frame.selected = name;
      frame.moving = true;
    },
    step(dtMsRaw, timeMs) {
      frame.time = timeMs;
      if (!layout || !model) {
        frame.moving = false;
        return frame;
      }
      const lay = layout;
      const dt = Math.min(Math.max(dtMsRaw, 0), MAX_STEP_MS);
      const tau = model.transitionMs / 3;
      const reduced = model.reducedMotion;
      flag.moving = false;
      frame.ghosts.count = 0;
      frame.fog.count = 0;
      frame.fogBank.count = 0;
      frame.motes.count = 0;
      frame.pulses.count = 0;

      for (const room of layout.rooms) {
        const v = visualOf(room.name);
        if (!v) continue;
        const st = stateOf(room.name, v);
        const f = st.frame;
        f.light = approach(f.light, v.light, dt, tau);
        f.coolness = approach(f.coolness, v.coolness, dt, tau);
        f.dim = approach(f.dim, v.dark ? DARK_DIM : 0, dt, tau);
        f.outlineAlpha = approach(f.outlineAlpha, v.dark ? 1 : 0.35, dt, tau);
        f.badgeAlpha = approach(f.badgeAlpha, v.badge === '' ? 0 : 1, dt, tau);
        f.dark = v.dark;
        f.clock = v.clock;
        f.incident = v.incident.open;
        if (
          Math.abs(f.light - v.light) > EPS ||
          Math.abs(f.coolness - v.coolness) > EPS ||
          Math.abs(f.dim - (v.dark ? DARK_DIM : 0)) > EPS ||
          Math.abs(f.outlineAlpha - (v.dark ? 1 : 0.35)) > EPS ||
          Math.abs(f.badgeAlpha - (v.badge === '' ? 0 : 1)) > EPS
        ) {
          flag.moving = true;
        }

        const m = v.motion;
        f.flicker = m.flicker > 0 ? 1 - m.flicker * valueNoise(v.seed, timeMs / 500, 11) : 1;
        const tremble = m.tremble * layout.scale;
        f.shakeX = tremble > 0 ? tremble * (valueNoise(v.seed, timeMs / 80, 21) * 2 - 1) : 0;
        f.shakeY = tremble > 0 ? tremble * (valueNoise(v.seed, timeMs / 80, 22) * 2 - 1) : 0;
        f.lampBreath = reduced ? 0.5 : 0.5 + 0.5 * Math.sin((timeMs / 1000) * Math.PI * 0.4 + v.seed);
        if (!reduced) flag.moving = true; // idle motion: lamp, motes, wisps, pulses

        const hide = v.dark ? 0 : 1;
        // Ghost feet stay above the highest text pill, so ghosts never cover the nameplate or the badges.
        const ghostFeet = room.textTop - 0.04 * layout.scale;
        fill(frame.ghosts, st.ghostA, v.ghostCount, v.ghostOpacity * hide, st.ghostS, room, v, timeMs, dt, tau, 0.3, 1, ghostFeet);
        const fog = splitFog(v.fogCount);
        fill(frame.fogBank, st.bankA, fog.bank, FOG_ALPHA.bank(v.fogDensity) * hide, st.bankS, room, v, timeMs, dt, tau, 0, 1, Infinity);
        fill(frame.fog, st.fogA, fog.wisps, FOG_ALPHA.wisp(v.fogDensity) * hide, st.fogS, room, v, timeMs, dt, tau, 0.35, 1, Infinity);
        fill(frame.motes, st.moteA, v.moteCount, 0.55 * hide, st.moteS, room, v, timeMs, dt, tau, 0, 1, Infinity);
      }

      layout.corridors.forEach((c, i) => {
        const a = visualOf(c.from);
        const b = visualOf(c.to);
        const target = a && b ? corridorLight(a, b) : 0;
        const lit = approach(corridorLit[i] ?? 0, target, dt, tau);
        corridorLit[i] = lit;
        const cf = frame.corridors[i];
        if (cf) cf.lit = lit;
        if (Math.abs(lit - target) > EPS) flag.moving = true;
        if (lit > 0.004 && c.points.length >= 2) {
          for (let k = 0; k < PULSES_PER_CORRIDOR; k++) {
            const slot = frame.pulses.count;
            if (slot >= frame.pulses.capacity) break;
            const phase = reduced ? k / PULSES_PER_CORRIDOR : (k / PULSES_PER_CORRIDOR + timeMs / 6000) % 1;
            const p = along(c.points, phase);
            frame.pulses.x[slot] = p.x;
            frame.pulses.y[slot] = p.y;
            frame.pulses.size[slot] = lay.scale * 0.22;
            frame.pulses.alpha[slot] = CORRIDOR_STYLE.pulseAlpha * lit;
            frame.pulses.rotation[slot] = 0;
            frame.pulses.count = slot + 1;
          }
        }
      });

      enforceCap();
      frame.moving = flag.moving;
      return frame;
    },
  };
}

/** A point at fraction `t` (0 to 1) of the length of a polyline. Allocates nothing but the result. */
const pointOut: Pt = { x: 0, y: 0 };
function along(points: readonly Pt[], t: number): Pt {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += Math.hypot((points[i] as Pt).x - (points[i - 1] as Pt).x, (points[i] as Pt).y - (points[i - 1] as Pt).y);
  let want = t * total;
  for (let i = 1; i < points.length; i++) {
    const p = points[i - 1] as Pt;
    const q = points[i] as Pt;
    const len = Math.hypot(q.x - p.x, q.y - p.y);
    if (want <= len || i === points.length - 1) {
      const f = len === 0 ? 0 : Math.min(1, want / len);
      pointOut.x = p.x + (q.x - p.x) * f;
      pointOut.y = p.y + (q.y - p.y) * f;
      return pointOut;
    }
    want -= len;
  }
  pointOut.x = (points[0] as Pt).x;
  pointOut.y = (points[0] as Pt).y;
  return pointOut;
}
