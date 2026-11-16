import { PALETTE } from './palette.js';
import { WALL_HEIGHT, type HouseLayout, type Pt, type RoomLayout } from './layout.js';
import { unit } from './rng.js';

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

export interface PlaqueInput {
  room: Pick<RoomLayout, 'labelAt' | 'incidentAt' | 'incidentBox'>;
  compact: boolean;
  open: boolean;
  /** Size of the incident mark (the badge font size). */
  markPx: number;
  /** Measured text sizes. */
  labelW: number;
  labelH: number;
  wordW: number;
}

export interface PlaqueLayout {
  /** The nameplate behind the name and, when open, the incident mark. */
  plate: { x: number; y: number; w: number; h: number; r: number };
  /** "⚠ incident" (long) or the triangle with "!" only (short); null when no incident is open. */
  mark: null | { form: 'long' | 'short'; tri: Pt; word: Pt | null };
}

/**
 * Where the nameplate and the incident mark go. The long form "⚠ incident" is used only when its
 * measured width fits the incident row of the room; otherwise, and always in compact mode, it falls
 * back to the short "!" mark. Pure.
 */
export function plaqueLayout(p: PlaqueInput): PlaqueLayout {
  const { room, markPx: s } = p;
  const labelPill = pillRect(room.labelAt, p.labelW, p.labelH);
  if (!p.open) return { plate: labelPill, mark: null };
  const triW = 1.1 * s;
  const gap = 0.3 * s;
  if (p.compact) {
    // Left of the name, against the measured text.
    const tri = { x: room.labelAt.x - p.labelW / 2 - gap - triW / 2, y: room.labelAt.y };
    const markPill = pillRect(tri, triW, s);
    return { plate: union(labelPill, markPill), mark: { form: 'short', tri, word: null } };
  }
  const longW = triW + gap + p.wordW;
  const long = longW <= room.incidentBox.w;
  const width = long ? longW : triW;
  const left = room.incidentAt.x - width / 2;
  const tri = { x: left + triW / 2, y: room.incidentAt.y };
  const word = long ? { x: left + triW + gap, y: room.incidentAt.y } : null;
  const markPill = pillRect(room.incidentAt, width, s);
  return { plate: union(labelPill, markPill), mark: { form: long ? 'long' : 'short', tri, word } };
}

function union(a: { x: number; y: number; w: number; h: number; r: number }, b: { x: number; y: number; w: number; h: number; r: number }) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const w = Math.max(a.x + a.w, b.x + b.w) - x;
  const h = Math.max(a.y + a.h, b.y + b.h) - y;
  return { x, y, w, h, r: Math.min(a.r, b.r) };
}

/** Rounded pill around a text box, as a polygon (for hit tests and for tests). */
export function pillRect(centre: Pt, textWidth: number, textHeight: number): { x: number; y: number; w: number; h: number; r: number } {
  const padX = Math.max(5, textHeight * 0.45);
  const padY = Math.max(2, textHeight * 0.2);
  const w = textWidth + 2 * padX;
  const h = textHeight + 2 * padY;
  return { x: centre.x - w / 2, y: centre.y - h / 2, w, h, r: h / 2 };
}
