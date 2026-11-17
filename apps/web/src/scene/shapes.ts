import { PALETTE } from './palette.js';
import { CHIP_ALERT_DOT, CHIP_CHAR_W, CHIP_DOT, CHIP_GAP, CHIP_H, CHIP_PAD_PX, ROOM_SCREEN_H, WALL_HEIGHT, type HouseLayout, type Pt, type Rect, type RoomLayout } from './layout.js';
import { unit } from './rng.js';

/** Most ticks on the floor ring of a Hunt, one per step done (the same count the model caps its marks at). */
export const RING_TICKS = 8;

/** The longest text of the hunt badge counted for its estimated width ("Hunting · 99 steps"), in characters. */
export const HUNT_BADGE_CHARS = 18;

/** Share of the badge height the magnifier icon takes, and the gap after it, in font sizes. */
export const HUNT_ICON = 1.0;

/**
 * The most width in px a hunt badge of this font may take: padding, magnifier, gap and text of `HUNT_BADGE_CHARS` characters. The drawn
 * badge is measured; the layout tests keep this much free.
 */
export function huntBadgeMaxWidth(font: number): number {
  return 2 * CHIP_PAD_PX + (HUNT_ICON + CHIP_GAP) * font + HUNT_BADGE_CHARS * CHIP_CHAR_W * font;
}

/** The width of a hunt badge for a measured text width. */
export const huntBadgeWidth = (textW: number, font: number): number => 2 * CHIP_PAD_PX + (HUNT_ICON + CHIP_GAP) * font + textW;

/**
 * Where the hunt badge of a room goes: the same height as the chip (`CHIP_H` of the font), a little below the top of the room's screen rect `room`
 * (on the back wall, above the body of the figure and clear of every chip, or at the top of the canvas when a phone leaves no other gap): centred on a room of the middle column, on the outer half of a side
 * room (inner edge at the room centre), kept inside the canvas. `width` is the canvas width, `badgeW` the badge width. The slot (`huntRect`)
 * does not change. Pure. (Here and not in `layout.ts`, which the entry chunk shares.)
 */
export function huntBadgeRect(room: Rect, width: number, badgeW: number, font: number, avoid: readonly Rect[] = []): Rect {
  const h = CHIP_H * font;
  const cx = room.x + room.w / 2;
  const side = cx - width / 2;
  const at = Math.abs(side) < room.w / 4 ? cx - badgeW / 2 : side < 0 ? cx - badgeW : cx;
  const x = Math.max(0, Math.min(at, width - badgeW));
  const unit = room.h / ROOM_SCREEN_H;
  // The first height (a little below the top of the room, then higher) that clears every chip in `avoid` and stays on the canvas.
  // A badge never touches a chip: at least BADGE_GAP px of air on the side that separates them.
  const clear = (r: Rect): boolean =>
    r.y >= 0 && avoid.every((c) => c.x >= r.x + r.w + BADGE_GAP || r.x >= c.x + c.w + BADGE_GAP || c.y >= r.y + r.h + BADGE_GAP || r.y >= c.y + c.h + BADGE_GAP);
  // Then, at each height, the place of the room first and then shifted along the row by 4 px steps (nearest first), inside the canvas.
  const xs = [x];
  for (let d = 4; d <= width; d += 4) {
    for (const sign of [-1, 1]) {
      const c = x + sign * d;
      if (c >= 0 && c + badgeW <= width) xs.push(c);
    }
  }
  for (const dy of BADGE_DY) {
    for (const cx of xs) {
      const r = { x: cx, y: room.y + dy * unit, w: badgeW, h };
      if (clear(r)) return r;
    }
  }
  // On a phone the rows of chips leave no gap as high as the badge near a front room: it then takes the top of the canvas, which no chip reaches.
  for (const cx of xs) {
    const r = { x: cx, y: 0, w: badgeW, h };
    if (clear(r)) return r;
  }
  return { x, y: room.y + BADGE_DY[0] * unit, w: badgeW, h };
}

/** Heights of the hunt badge below the top of its room, in iso units, in the order they are tried. */
const BADGE_DY = [0.15, 0, -0.15, -0.3] as const;
/** Least space between a hunt badge and any chip, in CSS px. */
const BADGE_GAP = 2;

export interface RingTick {
  from: Pt;
  to: Pt;
  /** Lit: a step done. Not lit: the next step, drawn dim. */
  lit: boolean;
}
export interface HuntRingArt {
  /** The ellipse on the floor plane, centred on `centre`, as points of a closed polyline. */
  ring: Pt[];
  /** One tick per step done (lit) up to `RING_TICKS`, then the next one dim while steps remain to count. */
  ticks: RingTick[];
}

/** Strokes of the floor ring in screen px: the ring line is thin, a tick is a dash across it, at least 2 px wide and 3 times as long as it is wide. */
export interface RingStrokes {
  ring: number;
  tick: number;
  len: number;
}
export function ringStrokes(scale: number): RingStrokes {
  const ring = Math.max(1, 0.02 * scale);
  const tick = Math.max(2, 0.05 * scale);
  return { ring, tick, len: 3.2 * tick };
}
/**
 * The floor ring of a Hunt: a thin ellipse of semi-axes `rx` and `ry` around `centre` with `RING_TICKS` positions spread evenly, the first at the front
 * (the bottom) of the ellipse. Each tick is a dash of length `len` across the ring (centred on it, along its normal). The first `min(steps, RING_TICKS)`
 * are lit and the next one is dim. The count of lit ticks equals `min(steps, RING_TICKS)`; the badge shows `steps`. Pure.
 */
export function huntRingArt(centre: Pt, rx: number, ry: number, steps: number, len: number = Math.max(6, 0.3 * rx)): HuntRingArt {
  const lit = Math.max(0, Math.min(RING_TICKS, Math.floor(Number.isFinite(steps) ? steps : 0)));
  const ring: Pt[] = [];
  const N = 48;
  for (let i = 0; i <= N; i++) ring.push({ x: centre.x + rx * Math.cos((i / N) * Math.PI * 2), y: centre.y + ry * Math.sin((i / N) * Math.PI * 2) });
  const ticks: RingTick[] = [];
  const upto = lit < RING_TICKS ? lit + 1 : lit;
  for (let i = 0; i < upto; i++) ticks.push(ringTick(centre, rx, ry, i, len, i < lit));
  return { ring, ticks };
}
function ringTick(centre: Pt, rx: number, ry: number, i: number, len: number, lit: boolean): RingTick {
  const a = Math.PI / 2 + (i / RING_TICKS) * Math.PI * 2;
  const p = { x: centre.x + rx * Math.cos(a), y: centre.y + ry * Math.sin(a) };
  // The normal of the ellipse at `p`.
  const nx = ry * Math.cos(a);
  const ny = rx * Math.sin(a);
  const n = Math.hypot(nx, ny) || 1;
  const dx = ((nx / n) * len) / 2;
  const dy = ((ny / n) * len) / 2;
  return { from: { x: p.x - dx, y: p.y - dy }, to: { x: p.x + dx, y: p.y + dy }, lit };
}
/** Every point of the ring that must stay on the floor: the ellipse and both ends of all `RING_TICKS` dashes (lit or not). */
export function huntRingExtent(centre: Pt, rx: number, ry: number, len: number): Pt[] {
  const pts = huntRingArt(centre, rx, ry, RING_TICKS, len).ring.slice(0, -1);
  for (let i = 0; i < RING_TICKS; i++) {
    const t = ringTick(centre, rx, ry, i, len, true);
    pts.push(t.from, t.to);
  }
  return pts;
}
/** The smallest distance of `p` to the sides of a convex polygon, positive inside, negative outside. */
export function insideMargin(poly: readonly Pt[], p: Pt): number {
  let area = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    area += a.x * b.y - b.x * a.y;
  }
  const sign = area >= 0 ? 1 : -1;
  let least = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const d = (sign * ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x))) / (Math.hypot(b.x - a.x, b.y - a.y) || 1);
    least = Math.min(least, d);
  }
  return least;
}
export interface RingPlacement {
  centre: Pt;
  rx: number;
  ry: number;
  /** 1 when the wanted size fits, less when the ring had to shrink. */
  k: number;
}
/**
 * Fits the floor ring (ellipse and ticks) into the floor polygon with `margin` px to spare: the wanted centre `at` and size are tried first, then the
 * centre moves toward the middle of the floor, then the ring shrinks. Always ends inside a floor that is large enough for a ring of at least 5 % of the size. Pure.
 */
export function fitHuntRing(floor: readonly Pt[], at: Pt, rx: number, ry: number, len: number, margin: number): RingPlacement {
  const mid = { x: floor.reduce((s, p) => s + p.x, 0) / floor.length, y: floor.reduce((s, p) => s + p.y, 0) / floor.length };
  const fits = (c: Pt, k: number): boolean => huntRingExtent(c, rx * k, ry * k, len).every((p) => insideMargin(floor, p) >= margin);
  const toward = (t: number): Pt => ({ x: at.x + (mid.x - at.x) * t, y: at.y + (mid.y - at.y) * t });
  let k = 1;
  for (let step = 0; step < 40; step++) {
    if (fits(toward(0), k)) return { centre: toward(0), rx: rx * k, ry: ry * k, k };
    if (fits(toward(1), k)) {
      let lo = 0;
      let hi = 1;
      for (let i = 0; i < 12; i++) {
        const m = (lo + hi) / 2;
        if (fits(toward(m), k)) hi = m;
        else lo = m;
      }
      return { centre: toward(hi), rx: rx * k, ry: ry * k, k };
    }
    k *= 0.9;
  }
  return { centre: mid, rx: rx * k, ry: ry * k, k };
}
/** Pure builders of the static art: polygons and lines in CSS pixels. No PixiJS, no DOM. */
export interface Poly {
  points: Pt[];
  fill: string;
  alpha: number;
}
export interface Line {
  points: Pt[];
  color: string;
  width: number;
  alpha: number;
}
export interface Disc {
  center: Pt;
  radius: number;
  fill: string;
  alpha: number;
}
/** A small icon drawn on the back wall of a room. */
export interface RoomIcon {
  polys: Poly[];
  lines: Line[];
  discs: Disc[];
}
export interface RoomArt {
  polys: Poly[];
  /** Floor gradient strips and the darker inner wall panels: drawn right after the floor, before the rug. */
  detail: Poly[];
  /** The icon of the service, or null for a service with no icon. */
  icon: RoomIcon | null;
  lines: Line[];
  /** Where the lamp light starts, and the size of its glow. */
  lampTop: Pt;
  glowSize: number;
  clock: { center: Pt; radius: number };
}

const lerp = (a: Pt, b: Pt, t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const add = (a: Pt, dx: number, dy: number): Pt => ({ x: a.x + dx, y: a.y + dy });
/** A point on the floor from fractions of the two floor axes (top to right, top to left). */
const onFloor = (room: RoomLayout, u: number, v: number): Pt => {
  const [top, right, , left] = room.floor;
  return { x: top.x + u * (right.x - top.x) + v * (left.x - top.x), y: top.y + u * (right.y - top.y) + v * (left.y - top.y) };
};

export function wallHeightPx(scale: number): number {
  return WALL_HEIGHT * scale;
}

/** Floor, two back walls, a rug, the lamp and the outline of one room. */
export function buildRoomArt(room: RoomLayout, scale: number, name: string = room.name): RoomArt {
  const [top, right, bottom, left] = room.floor;
  const h = wallHeightPx(scale);
  const leftUp = add(left, 0, -h);
  const topUp = add(top, 0, -h);
  const rightUp = add(right, 0, -h);

  const rug: Pt[] = [onFloor(room, 0.28, 0.28), onFloor(room, 0.72, 0.28), onFloor(room, 0.72, 0.72), onFloor(room, 0.28, 0.72)];
  const lampBase = onFloor(room, 0.08, 0.86);
  const lampTop = add(lampBase, 0, -0.6 * scale);
  const shade: Pt[] = [add(lampTop, -0.14 * scale, 0.02 * scale), add(lampTop, 0.14 * scale, 0.02 * scale), add(lampTop, 0.08 * scale, -0.16 * scale), add(lampTop, -0.08 * scale, -0.16 * scale)];
  const wallCentre = lerp(lerp(top, right, 0.5), lerp(topUp, rightUp, 0.5), 0.5);

  // The floor fades from the back edge to the front: three strips of the far colour, from strong to faint.
  const strip = (v0: number, v1: number, alpha: number): Poly => ({ points: [onFloor(room, 0, v0), onFloor(room, 1, v0), onFloor(room, 1, v1), onFloor(room, 0, v1)], fill: PALETTE.floorFar, alpha });
  // A darker panel set into each back wall.
  const panel = (a: Pt, b: Pt, bUp: Pt, aUp: Pt): Poly => {
    const m = 0.1;
    const lo = (p: Pt, q: Pt): Pt => lerp(p, q, m);
    const hi = (p: Pt, q: Pt): Pt => lerp(p, q, 1 - m);
    return { points: [lerp(lo(a, b), lo(aUp, bUp), 0.12), lerp(hi(a, b), hi(aUp, bUp), 0.12), lerp(hi(a, b), hi(aUp, bUp), 0.78), lerp(lo(a, b), lo(aUp, bUp), 0.78)], fill: PALETTE.wallInner, alpha: 0.55 };
  };
  const detail: Poly[] = [strip(0, 0.34, 0.7), strip(0.34, 0.67, 0.4), strip(0.67, 1, 0.15), panel(left, top, topUp, leftUp), panel(top, right, rightUp, topUp)];

  return {
    detail,
    icon: serviceIcon(name, lerp(lerp(top, right, 0.5), lerp(topUp, rightUp, 0.5), 0.5), scale),
    polys: [
      { points: [left, leftUp, topUp, top], fill: PALETTE.wallLeft, alpha: 1 },
      { points: [top, topUp, rightUp, right], fill: PALETTE.wallRight, alpha: 1 },
      { points: [top, right, bottom, left], fill: PALETTE.floor, alpha: 1 },
      { points: rug, fill: PALETTE.trim, alpha: 0.18 },
      { points: shade, fill: PALETTE.lampWarm, alpha: 1 },
    ],
    lines: [
      { points: [left, leftUp, topUp, rightUp, right], color: PALETTE.trim, width: Math.max(1, 0.04 * scale), alpha: 0.7 },
      { points: [left, bottom, right], color: PALETTE.trim, width: Math.max(1, 0.05 * scale), alpha: 0.8 },
      { points: [top, topUp], color: PALETTE.trim, width: Math.max(1, 0.04 * scale), alpha: 0.5 },
      { points: [lampBase, add(lampBase, 0, -0.6 * scale)], color: PALETTE.trim, width: Math.max(1, 0.05 * scale), alpha: 0.9 },
    ],
    lampTop,
    glowSize: 4.4 * scale,
    clock: { center: add(wallCentre, 0.25 * scale, 0), radius: 0.22 * scale },
  };
}

const ring = (c: Pt, r: number, n = 14): Pt[] => Array.from({ length: n + 1 }, (_, i) => ({ x: c.x + r * Math.cos((i / n) * Math.PI * 2), y: c.y + r * Math.sin((i / n) * Math.PI * 2) }));
const rect = (x: number, y: number, w: number, h: number): Pt[] => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];

/**
 * One small icon per service, drawn on the back wall from simple shapes: payments a coin, orders a box,
 * ledger a book, gate a gate arch. Any other name has no icon. `wall` is the centre of the right back wall.
 */
export function serviceIcon(name: string, wall: Pt, scale: number): RoomIcon | null {
  const c = add(wall, -0.5 * scale, 0);
  const u = 0.2 * scale;
  const w = Math.max(1, 0.035 * scale);
  const line = (points: Pt[], color: string = PALETTE.lampWarm, alpha = 0.9): Line => ({ points, color, width: w, alpha });
  switch (name) {
    case 'payments':
      return {
        polys: [{ points: rect(c.x - u * 0.09, c.y - u * 0.45, u * 0.18, u * 0.9), fill: PALETTE.nightDeep, alpha: 0.7 }],
        lines: [line(ring(c, u * 0.72))],
        discs: [{ center: c, radius: u, fill: PALETTE.lampWarm, alpha: 0.75 }],
      };
    case 'orders':
      return {
        polys: [
          { points: rect(c.x - u, c.y - u * 0.55, 2 * u, 1.55 * u), fill: PALETTE.lampWarm, alpha: 0.7 },
          { points: rect(c.x - u * 1.12, c.y - u * 0.85, 2.24 * u, 0.4 * u), fill: PALETTE.trim, alpha: 0.9 },
        ],
        lines: [line([{ x: c.x, y: c.y - u * 0.85 }, { x: c.x, y: c.y + u }], PALETTE.nightDeep, 0.8)],
        discs: [],
      };
    case 'ledger':
      return {
        polys: [
          { points: rect(c.x - u, c.y - u * 0.9, u, 1.8 * u), fill: PALETTE.lampWarm, alpha: 0.75 },
          { points: rect(c.x, c.y - u * 0.9, u, 1.8 * u), fill: PALETTE.lampWarm, alpha: 0.6 },
        ],
        lines: [line([{ x: c.x, y: c.y - u * 0.9 }, { x: c.x, y: c.y + u * 0.9 }], PALETTE.nightDeep, 0.9), line([{ x: c.x - u * 0.7, y: c.y - u * 0.4 }, { x: c.x - u * 0.2, y: c.y - u * 0.4 }], PALETTE.nightDeep, 0.6), line([{ x: c.x + u * 0.2, y: c.y - u * 0.4 }, { x: c.x + u * 0.7, y: c.y - u * 0.4 }], PALETTE.nightDeep, 0.6)],
        discs: [],
      };
    case 'gate': {
      const arch: Pt[] = Array.from({ length: 13 }, (_, i) => ({ x: c.x + u * Math.cos(Math.PI + (i / 12) * Math.PI), y: c.y - u * 0.2 + u * Math.sin(Math.PI + (i / 12) * Math.PI) }));
      return {
        polys: [{ points: [{ x: c.x - u, y: c.y + u }, { x: c.x - u, y: c.y - u * 0.2 }, ...arch, { x: c.x + u, y: c.y + u }], fill: PALETTE.nightDeep, alpha: 0.8 }],
        lines: [line([{ x: c.x - u, y: c.y + u }, { x: c.x - u, y: c.y - u * 0.2 }, ...arch, { x: c.x + u, y: c.y + u }]), line([{ x: c.x, y: c.y - u * 1.2 }, { x: c.x, y: c.y + u }], PALETTE.lampWarm, 0.5)],
        discs: [],
      };
    }
    default:
      return null;
  }
}

/** Corridor strokes: the idle line is clearly visible, the lit overlay and its pulses are brighter. */
export const CORRIDOR_STYLE = {
  /** Alpha of the idle trim line (at least 0.5). */
  idleAlpha: 0.6,
  /** Alpha of the warm lit line on top, multiplied by how lit the corridor is. */
  litAlpha: 0.9,
  /** Width of the lit line as a share of the corridor width. */
  litWidth: 0.6,
  /** Alpha of a travelling pulse at full light. */
  pulseAlpha: 1,
} as const;

export interface HouseArt {
  polys: Poly[];
  lines: Line[];
  /** The roof and the chimney: solid shapes that fade out when a room is focused. Not part of `polys`. */
  roof: { polys: Poly[]; lines: Line[] };
  /** The attic window: a lit disc with a cross of bars. */
  window: { center: Pt; radius: number; fill: string; alpha: number; bars: Line[] };
}

/** The house around the rooms, drawn behind them: floor slab, outer walls, roof, chimney, attic window, plinth and ground line. No text. */
export function buildHouseArt(house: HouseLayout, scale: number): HouseArt {
  const w = Math.max(1, 0.04 * scale);
  const { center, radius } = house.atticWindow;
  const polys: Poly[] = [
      { points: house.roof, fill: PALETTE.wallRight, alpha: 1 },
      { points: house.chimney, fill: PALETTE.wallLeft, alpha: 1 },
      { points: house.backLeft, fill: PALETTE.wallLeft, alpha: 0.75 },
      { points: house.backRight, fill: PALETTE.wallRight, alpha: 0.75 },
      { points: house.footprint, fill: PALETTE.nightDeep, alpha: 0.8 },
      { points: house.plinth, fill: PALETTE.wallRight, alpha: 1 },
  ];
  const lines: Line[] = [
      { points: house.roof, color: PALETTE.trim, width: Math.max(1.5, 0.06 * scale), alpha: 0.85 },
      { points: house.chimney, color: PALETTE.trim, width: w, alpha: 0.7 },
      { points: [house.backLeft[1] as Pt, house.backLeft[2] as Pt, house.backRight[2] as Pt], color: PALETTE.trim, width: w, alpha: 0.5 },
      { points: house.groundLine, color: PALETTE.trim, width: Math.max(1.5, 0.05 * scale), alpha: 0.8 },
  ];
  return {
    polys,
    lines,
    roof: { polys: polys.slice(0, 2), lines: lines.slice(0, 2) },
    window: {
      center,
      radius,
      fill: PALETTE.lampWarm,
      alpha: 0.55,
      bars: [
        { points: [{ x: center.x - radius, y: center.y }, { x: center.x + radius, y: center.y }], color: PALETTE.wallRight, width: Math.max(1, radius * 0.18), alpha: 1 },
        { points: [{ x: center.x, y: center.y - radius }, { x: center.x, y: center.y + radius }], color: PALETTE.wallRight, width: Math.max(1, radius * 0.18), alpha: 1 },
      ],
    },
  };
}

/** The two hands of the clock on the wall (hour and minute), angles in radians from 12 o'clock. */
export function clockHands(clock: { hour: number; minute: number }, center: Pt, radius: number): Line[] {
  const hand = (angle: number, length: number, width: number): Line => ({
    points: [center, { x: center.x + Math.sin(angle) * length, y: center.y - Math.cos(angle) * length }],
    color: PALETTE.text,
    width,
    alpha: 1,
  });
  return [hand(clock.hour, radius * 0.5, Math.max(1, radius * 0.16)), hand(clock.minute, radius * 0.8, Math.max(1, radius * 0.1))];
}

/** A fixed set of stars for the night sky: positions are a pure function of the size. */
export function starField(width: number, height: number, count = 48, seed = 7): Array<Pt & { r: number; alpha: number }> {
  const out: Array<Pt & { r: number; alpha: number }> = [];
  for (let i = 0; i < count; i++) {
    out.push({
      x: unit(seed, i, 1) * width,
      y: unit(seed, i, 2) * height,
      r: 0.5 + unit(seed, i, 3) * 1.1,
      alpha: 0.25 + unit(seed, i, 4) * 0.5,
    });
  }
  return out;
}

export interface ChipInput {
  room: Pick<RoomLayout, 'chipAt'>;
  /** An incident is open: the danger dot sits at the right end. */
  open: boolean;
  /** The chip text size in px. */
  font: number;
  /** Measured widths of the name and of the level word (0 when the word is not shown, under 640 px). */
  nameW: number;
  wordW: number;
}

export interface ChipLayout {
  /** The pill, centred on `chipAt`: exactly the padding and the measured parts. */
  pill: { x: number; y: number; w: number; h: number; r: number };
  /** Level dot (centre and radius). */
  dot: { x: number; y: number; r: number };
  /** Left end (y is the middle) of the name, and of the level word (null when not shown). */
  name: Pt;
  word: Pt | null;
  /** The incident dot (centre and radius), null when no incident is open. */
  alert: { x: number; y: number; r: number } | null;
}

/** Gap before the level word, in font sizes (the name and the word are one phrase). */
export const CHIP_WORD_GAP = 0.3;

/**
 * Where the parts of the room's chip go, left to right: the level dot, the name, the level word (from 640 px up) and the danger dot (open incident).
 * The pill is exactly 8 px of padding around them, `CHIP_H` of the font high. Pure.
 */
export function chipLayout(p: ChipInput): ChipLayout {
  const { room, font } = p;
  const dotD = CHIP_DOT * font;
  const gap = CHIP_GAP * font;
  const alertD = CHIP_ALERT_DOT * font;
  const wordPart = p.wordW > 0 ? CHIP_WORD_GAP * font + p.wordW : 0;
  const inner = dotD + gap + p.nameW + wordPart + (p.open ? gap + alertD : 0);
  const pill = pillRect(room.chipAt, inner, CHIP_H * font);
  const y = room.chipAt.y;
  let x = pill.x + CHIP_PAD_PX;
  const dot = { x: x + dotD / 2, y, r: dotD / 2 };
  x += dotD + gap;
  const name = { x, y };
  x += p.nameW;
  const word = p.wordW > 0 ? { x: x + CHIP_WORD_GAP * font, y } : null;
  x += wordPart;
  const alert = p.open ? { x: x + gap + alertD / 2, y, r: alertD / 2 } : null;
  return { pill, dot, name, word, alert };
}

/** The rounded pill around content `inner` px wide: 8 px of padding on each side, the given height, radius half the height. */
export function pillRect(centre: Pt, inner: number, height: number): { x: number; y: number; w: number; h: number; r: number } {
  const w = inner + 2 * CHIP_PAD_PX;
  return { x: centre.x - w / 2, y: centre.y - height / 2, w, h: height, r: height / 2 };
}
