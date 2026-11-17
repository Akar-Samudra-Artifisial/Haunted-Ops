import type { Pt } from './layout.js';

/** The selection ring (`visual-refresh` part 8): a thin line on the room outline, 2.5 px on screen at any zoom, and a soft glow of 6 px at alpha 0.25 under it. No fill. */
export const RING_LINE_PX = 2.5;
export const RING_GLOW_PX = 6;
export const RING_GLOW_ALPHA = 0.25;
/** A focused room that is not selected gets the same ring in dashes: this long, with this gap, in px. */
export const RING_DASH_PX = 10;
export const RING_GAP_PX = 6;

/** What the ring draws: the closed outline, or open dashes of it (keyboard focus on a room that is not selected). Every point lies on the outline. */
export interface RingShape {
  closed: boolean;
  paths: Pt[][];
}

/**
 * Cuts the closed outline into dashes of `dash` px with `gap` px between them. Each edge starts with a dash at its first corner, so every corner
 * of the outline is drawn and the dashed ring has the bounds of the outline. Pure.
 */
export function dashPaths(outline: readonly Pt[], dash: number, gap: number): Pt[][] {
  const paths: Pt[][] = [];
  const n = outline.length;
  for (let i = 0; i < n; i++) {
    const a = outline[i] as Pt;
    const b = outline[(i + 1) % n] as Pt;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const at = (d: number): Pt => ({ x: a.x + ((b.x - a.x) * d) / len, y: a.y + ((b.y - a.y) * d) / len });
    for (let d = 0; d < len; d += dash + gap) paths.push([at(d), at(Math.min(d + dash, len))]);
  }
  return paths;
}

/** The ring of a room: solid when it is selected, dashed when it only has keyboard focus. */
export function ringShape(outline: readonly Pt[], selected: boolean): RingShape {
  return selected ? { closed: true, paths: [outline.map((p) => ({ x: p.x, y: p.y }))] } : { closed: false, paths: dashPaths(outline, RING_DASH_PX, RING_GAP_PX) };
}
