import { Assets, type Texture } from 'pixi.js';
import type { ServiceName } from '@haunted-ops/shared';
import type { Pt } from './layout.js';

/**
 * The illustrated sprites of the scene: the one place that loads image files. The files are the team's own art (generated
 * with Seedream 5.5 via Runware and curated by hand) in `apps/web/public/scene/`, served from the scene folder of the site. Any failure
 * gives `null` and the scene keeps its procedural art.
 */
export const SPRITE_MANIFEST = {
  roomPayments: '/scene/room-payments.webp',
  roomOrders: '/scene/room-orders.webp',
  roomLedger: '/scene/room-ledger.webp',
  roomGate: '/scene/room-gate.webp',
  ghostCalm: '/scene/ghost-calm.webp',
  ghostDrift: '/scene/ghost-drift.webp',
  ghostAngry: '/scene/ghost-angry.webp',
  exorcistWalk: '/scene/exorcist-walk.webp',
  exorcistScan: '/scene/exorcist-scan.webp',
  fogWisp: '/scene/fog-wisp.webp',
} as const;
export type SpriteKey = keyof typeof SPRITE_MANIFEST;
export const SPRITE_KEYS = Object.keys(SPRITE_MANIFEST) as SpriteKey[];

/** The room file of a service. A service not listed here has no sprite and keeps the procedural room. */
export const ROOM_SPRITE: Readonly<Partial<Record<ServiceName, SpriteKey>>> = {
  payments: 'roomPayments',
  orders: 'roomOrders',
  ledger: 'roomLedger',
  gate: 'roomGate',
};

/** The content box of a room image (768 by 768), as a fraction of the image; the same for the four room files. */
export const ROOM_BOX = { x0: 0.0605, x1: 0.941, y0: 0.078, y1: 0.93 } as const;
export const ROOM_IMAGE_PX = 768;

/** Time allowed for all the files together. */
export const LOAD_TIMEOUT_MS = 8000;

export interface SpriteSet {
  rooms: Partial<Record<ServiceName, Texture>>;
  /** calm, drift, angry. */
  ghosts: readonly [Texture, Texture, Texture];
  fog: Texture;
  exorcist: { walk: Texture; scan: Texture };
}

export interface SpriteFit {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Where the room image goes (top left, size) so its content box is as wide as the floor diamond and the bottom centre
 * of the box sits on the front corner of the floor. Pure. `floor` is top, right, bottom, left.
 */
export function roomSpriteFit(floor: readonly [Pt, Pt, Pt, Pt]): SpriteFit {
  const [, right, bottom, left] = floor;
  const boxW = right.x - left.x;
  const size = boxW / (ROOM_BOX.x1 - ROOM_BOX.x0);
  const cx = (ROOM_BOX.x0 + ROOM_BOX.x1) / 2;
  return { x: bottom.x - cx * size, y: bottom.y - ROOM_BOX.y1 * size, width: size, height: size };
}

/**
 * The outline of the room image (left floor corner, left wall top, back corner, right wall top, right floor corner, front
 * corner): what the outlines of a sprite room follow. The floor diamond is half as high as it is wide, and the back wall
 * stands as high as the box minus the floor.
 */
export function spriteSilhouette(fit: SpriteFit): Pt[] {
  const at = (u: number, v: number): Pt => ({ x: fit.x + u * fit.width, y: fit.y + v * fit.height });
  const cx = (ROOM_BOX.x0 + ROOM_BOX.x1) / 2;
  const floorLeftY = ROOM_BOX.y1 - (ROOM_BOX.x1 - ROOM_BOX.x0) / 4;
  const wallH = ROOM_BOX.y1 - (ROOM_BOX.x1 - ROOM_BOX.x0) / 2 - ROOM_BOX.y0;
  return [at(ROOM_BOX.x0, floorLeftY), at(ROOM_BOX.x0, floorLeftY - wallH), at(cx, ROOM_BOX.y0), at(ROOM_BOX.x1, floorLeftY - wallH), at(ROOM_BOX.x1, floorLeftY), at(cx, ROOM_BOX.y1)];
}

/**
 * How bright the room picture is, 0 to 1 (the sprite is tinted with this grey): a floor of 0.32 for a lantern-only room,
 * rising with the displayed light to 1 for a possessed one, and times what the dark overlay leaves (`dim` is 0 lit, up
 * to 0.92 dark). Pure: non-decreasing in `light`, non-increasing in `dim`.
 */
export function spriteBrightness(light: number, dim: number): number {
  const l = Math.min(1, Math.max(0, light));
  const d = Math.min(1, Math.max(0, dim));
  return (0.32 + 0.68 * l) * (1 - d);
}

/** True when the value is a texture that decoded to a picture. */
function decoded(t: unknown): t is Texture {
  const tex = t as { width?: unknown; height?: unknown } | null | undefined;
  return !!tex && typeof tex.width === 'number' && typeof tex.height === 'number' && tex.width > 1 && tex.height > 1;
}

/** Loads the ten files in parallel. `null` on any error, on the timeout, or when a file is not a picture. */
export async function loadSprites(timeoutMs: number = LOAD_TIMEOUT_MS): Promise<SpriteSet | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
    });
    const all = Promise.all(SPRITE_KEYS.map((k) => Assets.load<Texture>(SPRITE_MANIFEST[k])));
    const list = await Promise.race([all, timeout]);
    const by = {} as Record<SpriteKey, Texture>;
    for (let i = 0; i < SPRITE_KEYS.length; i++) {
      const t = list[i];
      if (!decoded(t)) return null;
      by[SPRITE_KEYS[i] as SpriteKey] = t;
    }
    const rooms: Partial<Record<ServiceName, Texture>> = {};
    for (const [name, key] of Object.entries(ROOM_SPRITE)) rooms[name as ServiceName] = by[key as SpriteKey];
    return { rooms, ghosts: [by.ghostCalm, by.ghostDrift, by.ghostAngry], fog: by.fogWisp, exorcist: { walk: by.exorcistWalk, scan: by.exorcistScan } };
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Drops the files from the PixiJS cache (after the scene is destroyed, so a new scene loads fresh textures). */
export function unloadSprites(): void {
  try {
    void Promise.resolve(Assets.unload(SPRITE_KEYS.map((k) => SPRITE_MANIFEST[k]))).catch(() => undefined);
  } catch {
    /* nothing cached */
  }
}
