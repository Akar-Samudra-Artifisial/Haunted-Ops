import type { ServiceName } from '@haunted-ops/shared';
import type { Pt, SceneLayout } from './layout.js';
import type { SceneModel } from './model.js';

/** Why the scene could not start. The reason is never shown to the user, only a fixed message. */
export class SceneInitError extends Error {
  constructor(readonly reason: 'webgl' | 'import' | 'other') {
    super(`scene init failed: ${reason}`);
    this.name = 'SceneInitError';
  }
}

/** One class of pooled particles. `count` slots are visible; arrays are allocated once. */
export interface ParticleBuffer {
  readonly capacity: number;
  count: number;
  readonly x: Float32Array;
  readonly y: Float32Array;
  /** Sprite height in CSS pixels. */
  readonly size: Float32Array;
  readonly alpha: Float32Array;
  readonly rotation: Float32Array;
  /** Sprite variant of a slot (ghosts: calm, drift, angry); 0 for every other class. */
  readonly kind: Uint8Array;
}

/** The Exorcist and the Hunt slot of one room, as numbers the surface only has to draw. */
export interface HuntFrame {
  /** Alpha of the figure, the lantern and the seal: 0 when no figure is shown. */
  figure: number;
  /** 0 at the door, 1 at the place of the figure. */
  walk: number;
  /** Lantern brightness, 0 to 1. */
  lantern: number;
  /** Lit ticks of the floor ring, 0 to 8 (`min(steps, 8)`). */
  marks: number;
  /** The seal ring on the floor: 0 not drawn, up to 1 closed. */
  seal: number;
  /** The fizzle: 0 not started, up to 1 done (the lantern is out). */
  fizzle: number;
  /** The falling sparks of a fizzle: 0 not shown, up to 1 gone. */
  sparks: number;
  result: 'none' | 'sealed' | 'failed';
  /** Alpha of the mint glow behind the figure: 0.85 at rest, a 3 s breath between 0.7 and 0.9 (fixed under Reduced motion and in Low quality). */
  figureGlow: number;
  /** Alpha of the magnifier of the hunt badge while a hunt runs: a 2 s breath between 0.7 and 1 (fixed at 1 under Reduced motion and in Low quality). */
  badgeGlow: number;
  /** The fix of the Hunt. */
  proposal: ProposalFrame;
}

/** Alpha of the figure glow at rest, and the period of its breath (it moves between 0.7 and 0.9). */
export const FIGURE_GLOW_REST = 0.85;
export const FIGURE_GLOW_MS = 3000;

/** The magnifier of the hunt badge breathes between `BADGE_GLOW_REST - BADGE_GLOW_SWING` (0.7) and 1 over `BADGE_GLOW_MS` (2 s). */
export const BADGE_GLOW_REST = 0.85;
export const BADGE_GLOW_SWING = 0.15;
export const BADGE_GLOW_MS = 2000;

export function emptyHuntFrame(): HuntFrame {
  return { figure: 0, walk: 0, lantern: 0, marks: 0, seal: 0, fizzle: 0, sparks: 0, result: 'none', figureGlow: FIGURE_GLOW_REST, badgeGlow: 1, proposal: emptyProposalFrame() };
}

/** The fix scroll and the cleansing sweep of one room. */
export interface ProposalFrame {
  /** Alpha of the scroll: 1 drafting or pinned, dim when faded, 0 otherwise. */
  scroll: number;
  /** The scroll is beside the figure (drafting) or pinned on the wall (open, merged, faded). */
  pinned: boolean;
  /** Glow of a drafting scroll, 0 to 1. */
  glow: number;
  /** The cleansing ring: 0 not shown, up to 1 gone. */
  sweep: number;
}

export function emptyProposalFrame(): ProposalFrame {
  return { scroll: 0, pinned: false, glow: 0, sweep: 0 };
}

/** One soft noise layer of the fog of a room: its offset from the floor centre (in floor halves, -1 to 1) and alpha. */
export interface FogLayerFrame {
  x: number;
  y: number;
  alpha: number;
}
export const FOG_LAYERS = 3;

export interface RoomFrame {
  name: ServiceName;
  /** Alpha of the danger tint on floor and walls. */
  tint: number;
  /** Alpha of the cold edge light (the thin outline of a dark room). */
  edge: number;
  /** Alpha of the danger outline. */
  alarm: number;
  /** One soft pulse of the glow after the level rose: 0 at rest, up to 1 at the peak. */
  pulse: number;
  /** The green mist of a Hunt in progress: alpha 0 to 1, and its drift in floor halves. */
  mist: number;
  /** Slow breath of the mist, 0 to 1 (a cycle of 4 s); 0 under Reduced motion. */
  mistBreath: number;
  mistX: number;
  mistY: number;
  /** The fog noise layers, back to front. */
  fogLayers: FogLayerFrame[];
  hunt: HuntFrame;
  /** Displayed light, 0 to 1. */
  light: number;
  coolness: number;
  /** Alpha of the dark overlay: 0 lit, up to 0.92 dark. */
  dim: number;
  /** Multiplier around 1 for the flickering lamp. */
  flicker: number;
  /** Always 0: a room never moves, whatever its level. */
  shakeX: number;
  shakeY: number;
  /** 0 to 1, 0.5 neutral. */
  lampBreath: number;
  outlineAlpha: number;
  badgeAlpha: number;
  clock: { hour: number; minute: number };
  incident: boolean;
  /** True when the room is dark: only outline, label and badge are drawn. */
  dark: boolean;
}

export interface CorridorFrame {
  lit: number;
}

/** Everything to draw at one instant. The Animator reuses one object. */
export interface Frame {
  time: number;
  rooms: RoomFrame[];
  corridors: CorridorFrame[];
  ghosts: ParticleBuffer;
  /** Drifting fog wisps, above the bank. */
  fog: ParticleBuffer;
  /** The low fog bank that hugs the floor (a wide, flat texture). */
  fogBank: ParticleBuffer;
  motes: ParticleBuffer;
  pulses: ParticleBuffer;
  selected: ServiceName | null;
  /** Shift of the sky in pixels for the camera (the focused room); 0 when still. The far layers move less. */
  parallax: { x: number; y: number };
  /** Alpha of the roof: 1, and lower while a room is focused. */
  roofAlpha: number;
  /** False when nothing changes any more: the loop may stop. */
  moving: boolean;
}

export interface SurfaceInit {
  host: HTMLElement;
  width: number;
  height: number;
  dpr: number;
  quality: 'full' | 'low';
}

/** Draws Frames. The PixiJS implementation is the only code that imports `pixi.js`. */
export interface Surface {
  /** Rejects with `SceneInitError`. */
  init(opts: SurfaceInit): Promise<void>;
  /** Redraws the static art for a new layout (walls, floors, corridors, label and badge boxes, hunt slot). */
  applyLayout(layout: SceneLayout): void;
  /** Updates the texts and marks that follow the model (badges, labels, incident marks). */
  applyModel(model: SceneModel): void;
  draw(frame: Frame): void;
  resize(width: number, height: number, dpr: number): void;
  setQuality(quality: 'full' | 'low'): void;
  onContext(cb: (event: 'lost' | 'restored') => void): void;
  /** Idempotent. */
  destroy(): void;
}

export type { Pt };
