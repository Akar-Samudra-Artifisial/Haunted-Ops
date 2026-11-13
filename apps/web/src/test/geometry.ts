import type { Pt, Rect } from '../scene/layout.js';

function axes(poly: readonly Pt[]): Pt[] {
  return poly.map((p, i) => {
    const q = poly[(i + 1) % poly.length] as Pt;
    return { x: -(q.y - p.y), y: q.x - p.x };
  });
}

/**
 * Separating axis test for two convex polygons. Returns the gap along the best axis in pixels:
 * above 0 they are apart, 0 they touch, below 0 they overlap.
 */
export function separation(p: readonly Pt[], q: readonly Pt[]): number {
  let best = -Infinity;
  for (const ax of [...axes(p), ...axes(q)]) {
    const n = Math.hypot(ax.x, ax.y);
    if (n === 0) continue;
    const a = p.map((pt) => (pt.x * ax.x + pt.y * ax.y) / n);
    const b = q.map((pt) => (pt.x * ax.x + pt.y * ax.y) / n);
    const gap = Math.max(Math.min(...b) - Math.max(...a), Math.min(...a) - Math.max(...b));
    best = Math.max(best, gap);
  }
  return best;
}

/** Distance by which `pt` is inside the diamond floor (top, right, bottom, left); negative outside. */
export function insideDiamond(floor: readonly [Pt, Pt, Pt, Pt], pt: Pt): number {
  const [top, right, bottom, left] = floor;
  const cx = (left.x + right.x) / 2;
  const cy = (top.y + bottom.y) / 2;
  const hw = (right.x - left.x) / 2;
  const hh = (bottom.y - top.y) / 2;
  // |dx|/hw + |dy|/hh <= 1, expressed as a margin in pixels along the shorter half axis.
  const k = Math.abs(pt.x - cx) / hw + Math.abs(pt.y - cy) / hh;
  return (1 - k) * Math.min(hw, hh);
}

export function rectCorners(r: Rect): Pt[] {
  return [
    { x: r.x, y: r.y },
    { x: r.x + r.w, y: r.y },
    { x: r.x + r.w, y: r.y + r.h },
    { x: r.x, y: r.y + r.h },
  ];
}

/** Gap between two rectangles: above 0 apart, 0 touching, below 0 overlapping. */
export function rectGap(a: Rect, b: Rect): number {
  return Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w), b.y - (a.y + a.h), a.y - (b.y + b.h));
}

/** Distance by which `pt` is inside a convex polygon (any winding); negative outside. */
export function insideConvex(poly: readonly Pt[], pt: Pt): number {
  let area = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i] as Pt;
    const q = poly[(i + 1) % poly.length] as Pt;
    area += p.x * q.y - q.x * p.y;
  }
  const sign = area >= 0 ? 1 : -1;
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i] as Pt;
    const q = poly[(i + 1) % poly.length] as Pt;
    const len = Math.hypot(q.x - p.x, q.y - p.y);
    if (len === 0) continue;
    // Positive on the inner side of the edge p -> q.
    const d = (sign * ((q.x - p.x) * (pt.y - p.y) - (q.y - p.y) * (pt.x - p.x))) / len;
    best = Math.min(best, d);
  }
  return best;
}

/** Axis-aligned bounds of some points. */
export function bounds(points: readonly Pt[]): Rect {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/** True when the rectangle lies inside the bounds, within `eps`. */
export function rectInside(r: Rect, outer: Rect, eps = 1e-6): boolean {
  return r.x >= outer.x - eps && r.y >= outer.y - eps && r.x + r.w <= outer.x + outer.w + eps && r.y + r.h <= outer.y + outer.h + eps;
}
