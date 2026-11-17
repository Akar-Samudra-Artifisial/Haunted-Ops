import type { Pt, RoomLayout } from './layout.js';

/** The content box of a room image (768 by 768), as a fraction of the image; the same for the four room files. */
export const ROOM_BOX = { x0: 0.0605, x1: 0.941, y0: 0.078, y1: 0.93 } as const;
export const ROOM_IMAGE_PX = 768;
/**
 * How much smaller than the floor diamond the content box is drawn, pivoting on the front corner of the floor (the bottom
 * centre stays). 0.82 is the largest value under 0.9 for which the back walls of a front room no longer cover the front
 * corner of the floor of the room behind it in the demo layout (0.83 still does).
 */
export const ROOM_SPRITE_SCALE = 0.82;

export interface SpriteFit {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Where the room image goes (top left, size) so its content box is `ROOM_SPRITE_SCALE` times as wide as the floor diamond and
 * the bottom centre of the box sits on the front corner of the floor. Pure. `floor` is top, right, bottom, left.
 */
export function roomSpriteFit(floor: readonly [Pt, Pt, Pt, Pt]): SpriteFit {
  const [, right, bottom, left] = floor;
  const boxW = (right.x - left.x) * ROOM_SPRITE_SCALE;
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
 * The one outline of a room (`visual-refresh` part 8): the ring, the room outline and the hit shape of the room button all use it. With the room
 * sprite loaded it is the outline of the picture; with the procedural fallback it is the silhouette of the layout. Pure.
 */
export function roomOutline(room: Pick<RoomLayout, 'floor' | 'silhouette'>, spriteLoaded: boolean): Pt[] {
  return spriteLoaded ? spriteSilhouette(roomSpriteFit(room.floor)) : room.silhouette;
}
