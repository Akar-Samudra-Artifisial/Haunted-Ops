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
}

export interface RoomFrame {
  name: ServiceName;
  /** Displayed light, 0 to 1. */
  light: number;
  coolness: number;
  /** Alpha of the dark overlay: 0 lit, up to 0.92 dark. */
  dim: number;
  /** Multiplier around 1 for the flickering lamp. */
  flicker: number;
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
