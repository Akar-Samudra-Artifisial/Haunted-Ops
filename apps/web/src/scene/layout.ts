import { SERVICE_NAMES, type RoomPosition, type ServiceName } from '@haunted-ops/shared';

/** Iso units: a room is a square of this edge on the floor. */
export const ROOM_SIZE = 2.0;
/** Distance between the origins of two neighbouring cells. */
export const ROOM_STRIDE = 3.2;
export const WALL_HEIGHT = 1.0;
export const MAX_SCALE = 160;
export const MIN_FONT_PX = 11;
/** Under this width (40rem at 16 px) the room name is drawn at `MIN_FONT_NARROW_PX` or more. */
export const NARROW_BELOW = 640;
export const MIN_FONT_NARROW_PX = 14;
/** Below this many pixels per iso unit the badge uses its short form. */
export const COMPACT_BELOW = 26;
export const MAX_DPR = 2;
/** Width of a corridor in iso units. */
export const CORRIDOR_WIDTH = 0.3;

// --- the house around the rooms (iso units) ---
/** Floor margin of the house around the outer rooms. */
export const HOUSE_MARGIN = 0.3;
/** Height of the outer walls (taller than a room wall, so they show behind the back rooms). */
export const HOUSE_WALL = 1.2;
/** Height of the roof peak above the back corner of the outer walls. */
export const ROOF_RISE = 0.9;
/** Thickness of the ground plinth under the front edges. */
export const PLINTH = 0.15;

// --- the chip (one per room, under the room) ---
/** The chip may cover at most this share of the room's screen height (its bottom part); the rest hangs below the front corner. */
export const CHIP_BAND = 0.2;
/** Height of a room's screen rect in iso units: the floor (2) and the back wall (1). */
export const ROOM_SCREEN_H = ROOM_SIZE + WALL_HEIGHT;
/** Chip height as a share of the font size: the text and a padding of 0.3 of it above and below. */
export const CHIP_H = 1.6;
/** Characters of the chip text counted for its width: the level mark, a space, the name, a space and the "!" marker. */
export const CHIP_EXTRA_CHARS = 4;
/** Average width of a character of the chip, in font sizes. */
export const CHIP_CHAR_W = 0.55;
/** Horizontal padding of the chip, in font sizes. */
export const CHIP_PAD_X = 0.45;
/** The figure stands right of the centre of the floor, above the chip. */
const FIGURE_X = 0.55;

const A = 1;
const B = 0.5;
const GAP = ROOM_STRIDE - ROOM_SIZE;

export interface Pt {
  x: number;
  y: number;
}
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RoomLayout {
  name: ServiceName;
  grid: RoomPosition;
  /** Top, right, bottom, left corner of the floor, in CSS pixels. */
  floor: [Pt, Pt, Pt, Pt];
  /** Floor plus the two back walls: left, left-up, top-up, right-up, right, bottom. */
  silhouette: Pt[];
  center: Pt;
  /** Centre of the room's chip: the level mark, the name and, when an incident is open, a "!" marker. */
  chipAt: Pt;
  /** The chip, in CSS pixels, under the room: its top is in the bottom 20 % of the room's screen rect, the rest hangs below the front corner. */
  chipBox: Rect;
  /** The band under the room the chip stays in: the width of the room's own column and the bottom 20 % of the room plus the overhang. */
  chipBand: Rect;
  /** Top (y) of the chip: ghosts keep their feet above it. */
  textTop: number;
  hit: Rect;
  /** The silhouette relative to `hit`, for a CSS clip-path. */
  hitPolygon: Pt[];
  /** Reserved for the hunt overlay: on the left back wall, clear of the chip. */
  huntRect: Rect;
  /** The feet of the Exorcist figure, at the right corner of the floor. */
  exorcistAt: Pt;
  /** The box of the figure: inside the silhouette, above the chip, clear of the clock. */
  exorcistBox: Rect;
  /** Midpoints of the floor edges facing +x, -x, +y, -y neighbours. */
  doors: { px: Pt; mx: Pt; py: Pt; my: Pt };
}

export interface CorridorLayout {
  from: ServiceName;
  to: ServiceName;
  points: Pt[];
  /** In CSS pixels. */
  width: number;
}

export interface SceneLayout {
  width: number;
  height: number;
  dpr: number;
  scale: number;
  offset: Pt;
  compact: boolean;
  labelPx: number;
  badgePx: number;
  /** Overhang of the chips below the lowest room, in CSS pixels: the fit leaves this room at the bottom. */
  chipReserve: number;
  rooms: RoomLayout[];
  corridors: CorridorLayout[];
  /** The house drawn behind the rooms; null when there is no room. */
  house: HouseLayout | null;
  /** Width over height of the house at any scale. */
  aspect: number;
}

/** The outline of the house around the rooms, in CSS pixels. No text. */
export interface HouseLayout {
  /** Floor slab: top, right, bottom, left. */
  footprint: [Pt, Pt, Pt, Pt];
  backLeft: Pt[];
  backRight: Pt[];
  /** The pitched roof above the back walls: left eave, peak, right eave. */
  roof: [Pt, Pt, Pt];
  chimney: Pt[];
  atticWindow: { center: Pt; radius: number };
  /** The band under the front edges, and its bottom line on the ground. */
  plinth: Pt[];
  groundLine: Pt[];
}

export interface LayoutRoom {
  name: ServiceName;
  grid: RoomPosition;
}
export interface Viewport {
  width: number;
  height: number;
  dpr: number;
}

const proj = (u: number, v: number): Pt => ({ x: (u - v) * A, y: (u + v) * B });

/** Reading order: row (y), then column (x), then the fixed service order. */
export function readingOrder<T extends LayoutRoom>(rooms: readonly T[]): T[] {
  return [...rooms].sort(
    (a, b) => a.grid.y - b.grid.y || a.grid.x - b.grid.x || SERVICE_NAMES.indexOf(a.name) - SERVICE_NAMES.indexOf(b.name),
  );
}

interface Unit {
  name: ServiceName;
  grid: RoomPosition;
  floor: [Pt, Pt, Pt, Pt];
  silhouette: Pt[];
  center: Pt;
  doors: { px: Pt; mx: Pt; py: Pt; my: Pt };
}

function unitRoom(r: LayoutRoom): Unit {
  const u0 = r.grid.x * ROOM_STRIDE;
  const v0 = r.grid.y * ROOM_STRIDE;
  const T = proj(u0, v0);
  const R = proj(u0 + ROOM_SIZE, v0);
  const Bt = proj(u0 + ROOM_SIZE, v0 + ROOM_SIZE);
  const L = proj(u0, v0 + ROOM_SIZE);
  const up = (p: Pt): Pt => ({ x: p.x, y: p.y - WALL_HEIGHT });
  const mid = ROOM_SIZE / 2;
  return {
    name: r.name,
    grid: r.grid,
    floor: [T, R, Bt, L],
    silhouette: [L, up(L), up(T), up(R), R, Bt],
    center: proj(u0 + mid, v0 + mid),
    doors: {
      px: proj(u0 + ROOM_SIZE, v0 + mid),
      mx: proj(u0, v0 + mid),
      py: proj(u0 + mid, v0 + ROOM_SIZE),
      my: proj(u0 + mid, v0),
    },
  };
}

// --- corridors: shortest path over the street lattice (the gaps between cells) ---

interface GNode {
  u: number;
  v: number;
  edges: number[];
}

const key = (u: number, v: number): string => `${u.toFixed(5)},${v.toFixed(5)}`;

/** Centre line of the street right of cell k (and left of cell k + 1). */
const street = (k: number): number => k * ROOM_STRIDE + ROOM_SIZE + GAP / 2;

function routeCorridor(a: LayoutRoom, b: LayoutRoom, rooms: readonly LayoutRoom[]): Pt[] {
  const nodes: GNode[] = [];
  const index = new Map<string, number>();
  const node = (u: number, v: number): number => {
    const k = key(u, v);
    let id = index.get(k);
    if (id === undefined) {
      id = nodes.length;
      nodes.push({ u, v, edges: [] });
      index.set(k, id);
    }
    return id;
  };
  const link = (p: number, q: number): void => {
    if (p === q) return;
    (nodes[p] as GNode).edges.push(q);
    (nodes[q] as GNode).edges.push(p);
  };

  const xs = rooms.map((r) => r.grid.x);
  const ys = rooms.map((r) => r.grid.y);
  const kMin = Math.min(...xs) - 1;
  const kMax = Math.max(...xs);
  const mMin = Math.min(...ys) - 1;
  const mMax = Math.max(...ys);
  const mid = ROOM_SIZE / 2;

  // Points on each street line, to chain in order.
  const onU = new Map<number, number[]>(); // u-street k: nodes with varying v
  const onV = new Map<number, number[]>(); // v-street m: nodes with varying u
  const addU = (k: number, id: number): void => void onU.set(k, [...(onU.get(k) ?? []), id]);
  const addV = (m: number, id: number): void => void onV.set(m, [...(onV.get(m) ?? []), id]);
  for (let k = kMin; k <= kMax; k++) {
    for (let m = mMin; m <= mMax; m++) {
      const id = node(street(k), street(m));
      addU(k, id);
      addV(m, id);
    }
  }

  const doorOf = new Map<string, number[]>(); // room key -> door node ids
  for (const r of rooms) {
    const u0 = r.grid.x * ROOM_STRIDE;
    const v0 = r.grid.y * ROOM_STRIDE;
    const specs: Array<{ door: [number, number]; approach: [number, number]; axis: 'u' | 'v'; line: number }> = [
      { door: [u0 + ROOM_SIZE, v0 + mid], approach: [street(r.grid.x), v0 + mid], axis: 'u', line: r.grid.x },
      { door: [u0, v0 + mid], approach: [street(r.grid.x - 1), v0 + mid], axis: 'u', line: r.grid.x - 1 },
      { door: [u0 + mid, v0 + ROOM_SIZE], approach: [u0 + mid, street(r.grid.y)], axis: 'v', line: r.grid.y },
      { door: [u0 + mid, v0], approach: [u0 + mid, street(r.grid.y - 1)], axis: 'v', line: r.grid.y - 1 },
    ];
    const ids: number[] = [];
    for (const s of specs) {
      const approach = node(s.approach[0], s.approach[1]);
      if (s.axis === 'u') addU(s.line, approach);
      else addV(s.line, approach);
      // A door node is private to its room and has one edge, so a path never passes through a room.
      const doorId = nodes.length;
      nodes.push({ u: s.door[0], v: s.door[1], edges: [] });
      link(doorId, approach);
      ids.push(doorId);
    }
    doorOf.set(`${r.grid.x},${r.grid.y},${r.name}`, ids);
  }

  for (const ids of onU.values()) {
    const sorted = [...new Set(ids)].sort((p, q) => (nodes[p] as GNode).v - (nodes[q] as GNode).v);
    for (let i = 1; i < sorted.length; i++) link(sorted[i - 1] as number, sorted[i] as number);
  }
  for (const ids of onV.values()) {
    const sorted = [...new Set(ids)].sort((p, q) => (nodes[p] as GNode).u - (nodes[q] as GNode).u);
    for (let i = 1; i < sorted.length; i++) link(sorted[i - 1] as number, sorted[i] as number);
  }

  const sources = doorOf.get(`${a.grid.x},${a.grid.y},${a.name}`) as number[];
  const targets = new Set(doorOf.get(`${b.grid.x},${b.grid.y},${b.name}`) as number[]);
  const dist = new Array<number>(nodes.length).fill(Infinity);
  const prev = new Array<number>(nodes.length).fill(-1);
  const done = new Array<boolean>(nodes.length).fill(false);
  for (const s of sources) dist[s] = 0;
  for (;;) {
    let best = -1;
    for (let i = 0; i < nodes.length; i++) {
      if (!done[i] && (dist[i] as number) < Infinity && (best === -1 || (dist[i] as number) < (dist[best] as number))) best = i;
    }
    if (best === -1) break;
    done[best] = true;
    if (targets.has(best)) {
      const path: number[] = [];
      for (let at = best; at !== -1; at = prev[at] as number) path.push(at);
      return path.reverse().map((id) => proj((nodes[id] as GNode).u, (nodes[id] as GNode).v));
    }
    const n = nodes[best] as GNode;
    for (const e of n.edges) {
      const m = nodes[e] as GNode;
      const w = Math.abs(n.u - m.u) + Math.abs(n.v - m.v);
      if ((dist[best] as number) + w < (dist[e] as number) - 1e-12) {
        dist[e] = (dist[best] as number) + w;
        prev[e] = best;
      }
    }
  }
  return [proj(a.grid.x, a.grid.y), proj(b.grid.x, b.grid.y)]; // unreachable in practice
}

// --- the house ---

/** The house outline in iso units: an outer floor slab, two tall back walls, a pitched roof with a chimney and an attic window, and a plinth. */
function unitHouse(rooms: readonly LayoutRoom[]): HouseLayout {
  const uMin = Math.min(...rooms.map((r) => r.grid.x)) * ROOM_STRIDE - HOUSE_MARGIN;
  const uMax = Math.max(...rooms.map((r) => r.grid.x)) * ROOM_STRIDE + ROOM_SIZE + HOUSE_MARGIN;
  const vMin = Math.min(...rooms.map((r) => r.grid.y)) * ROOM_STRIDE - HOUSE_MARGIN;
  const vMax = Math.max(...rooms.map((r) => r.grid.y)) * ROOM_STRIDE + ROOM_SIZE + HOUSE_MARGIN;
  const T = proj(uMin, vMin);
  const R = proj(uMax, vMin);
  const Bt = proj(uMax, vMax);
  const L = proj(uMin, vMax);
  const up = (p: Pt, h: number): Pt => ({ x: p.x, y: p.y - h });
  const lUp = up(L, HOUSE_WALL);
  const tUp = up(T, HOUSE_WALL);
  const rUp = up(R, HOUSE_WALL);
  const peak: Pt = { x: (lUp.x + rUp.x) / 2, y: Math.min(lUp.y, tUp.y, rUp.y) - ROOF_RISE };
  // The chimney stands on the right slope of the roof.
  const onSlope = (t: number): Pt => ({ x: peak.x + (rUp.x - peak.x) * t, y: peak.y + (rUp.y - peak.y) * t });
  const c0 = onSlope(0.55);
  const c1 = onSlope(0.68);
  const chimneyTop = Math.min(c0.y, c1.y) - 0.6;
  const band = Math.max(0, tUp.y - peak.y);
  const down = (p: Pt): Pt => ({ x: p.x, y: p.y + PLINTH });
  return {
    footprint: [T, R, Bt, L],
    backLeft: [L, lUp, tUp, T],
    backRight: [T, tUp, rUp, R],
    roof: [lUp, peak, rUp],
    chimney: [c0, { x: c0.x, y: chimneyTop }, { x: c1.x, y: chimneyTop }, c1],
    atticWindow: { center: { x: peak.x, y: peak.y + band * 0.5 }, radius: Math.min(0.3, band * 0.3) },
    plinth: [L, Bt, R, down(R), down(Bt), down(L)],
    groundLine: [down(L), down(Bt), down(R)],
  };
}

function housePoints(h: HouseLayout): Pt[] {
  const w = h.atticWindow;
  return [
    ...h.footprint,
    ...h.backLeft,
    ...h.backRight,
    ...h.roof,
    ...h.chimney,
    ...h.plinth,
    { x: w.center.x - w.radius, y: w.center.y - w.radius },
    { x: w.center.x + w.radius, y: w.center.y + w.radius },
  ];
}

// --- the Exorcist figure ---

/** Size of the figure in iso units, and its gap to the text boxes. */
export const FIGURE_W = 0.3;
export const FIGURE_H = 0.85;
/** The height of the illustrated figure, in iso units (the procedural one keeps `FIGURE_H`), and its least height in px under 40rem. */
export const FIGURE_H_SPRITE = 1.15;
export const FIGURE_MIN_PX_NARROW = 28;
export const FIGURE_GAP = 0.05;
/** The clock on the right wall, relative to the floor centre (see `buildRoomArt`). */
const CLOCK_BOX = { x0: 1.03, x1: 1.47, bottom: -0.78 };

/**
 * The feet and the box of the figure, relative to the floor centre. It stands right of `textRight`
 * (relative to the centre), at a height where its box is inside the floor and the right wall, below the
 * clock and above the chip (`textTop`, relative to the centre). When that leaves no room, it stands at the
 * back, above the chip.
 */
export function figurePlace(textRight: number, textTop: number): { feet: Pt; box: Rect } {
  const make = (cx: number, fy: number): { feet: Pt; box: Rect } => ({
    feet: { x: cx, y: fy },
    box: { x: cx - FIGURE_W / 2, y: fy - FIGURE_H, w: FIGURE_W, h: FIGURE_H },
  });
  const cx = textRight + FIGURE_GAP + FIGURE_W / 2;
  const xr = cx + FIGURE_W / 2;
  if (xr <= ROOM_SIZE - 0.02) {
    // Lower right edge of the floor, and the top edge of the right wall, at the box's right side.
    const hi = (ROOM_SIZE - xr) / 2 - 0.01;
    let lo = -2 + xr / 2 + FIGURE_H + 0.01;
    if (cx - FIGURE_W / 2 < CLOCK_BOX.x1 && xr > CLOCK_BOX.x0) lo = Math.max(lo, CLOCK_BOX.bottom + FIGURE_H + 0.02);
    const fy = Math.min((lo + hi) / 2, textTop - FIGURE_GAP);
    if (lo <= hi && fy >= lo) return make(cx, Math.min(fy, hi));
  }
  // The text boxes reach the right corner (a narrow screen): stand at the back, above the highest
  // text box, between the Hunt slot and the clock. Its box is on the floor and the back walls.
  return make(0, Math.max(textTop - FIGURE_GAP, -2 + FIGURE_W / 4 + FIGURE_H + 0.01));
}

// --- text boxes ---

/** The chip's text size in px: 14 px or more under 40rem, the 11 px rule from there up. */
const chipFont = (width: number, scale: number): number => Math.max(width < NARROW_BELOW ? MIN_FONT_NARROW_PX : MIN_FONT_PX, 0.34 * scale);
/** How far the chip hangs below the front corner of its room, in px. */
const chipOverhang = (width: number, scale: number): number => Math.max(0, CHIP_H * chipFont(width, scale) - CHIP_BAND * ROOM_SCREEN_H * scale);

/** Computes the whole layout for a viewport. Pure: no PixiJS, no DOM. */
export function computeLayout(rooms: readonly LayoutRoom[], viewport: Viewport): SceneLayout {
  const width = Math.max(0, viewport.width);
  const height = Math.max(0, viewport.height);
  const dpr = Math.min(Math.max(viewport.dpr || 1, 1), MAX_DPR);
  const ordered = readingOrder(rooms);

  const present: LayoutRoom[] = [];
  for (const n of SERVICE_NAMES) {
    const r = ordered.find((x) => x.name === n);
    if (r) present.push(r);
  }
  const corridorsUnit = present.slice(1).map((to, i) => {
    const from = present[i] as LayoutRoom;
    return { from: from.name, to: to.name, points: routeCorridor(from, to, ordered) };
  });

  const units = ordered.map(unitRoom);
  if (units.length === 0) {
    return { width, height, dpr, scale: 1, offset: { x: width / 2, y: height / 2 }, compact: true, labelPx: MIN_FONT_PX, badgePx: MIN_FONT_PX, chipReserve: 0, rooms: [], corridors: [], house: null, aspect: 1 };
  }
  const houseU = unitHouse(ordered);
  // The house (roof, chimney, plinth) is part of the fit, so it never leaves the canvas.
  const allPts: Pt[] = [...units.flatMap((u) => u.silhouette), ...corridorsUnit.flatMap((c) => c.points), ...housePoints(houseU)];
  const minX = Math.min(...allPts.map((p) => p.x));
  const maxX = Math.max(...allPts.map((p) => p.x));
  const minY = Math.min(...allPts.map((p) => p.y));
  const maxY = Math.max(...allPts.map((p) => p.y));
  const bw = Math.max(maxX - minX, 1e-6);
  const bh = Math.max(maxY - minY, 1e-6);
  const pad = Math.max(8, 0.04 * Math.min(width, height));
  // The chips hang a little below the lowest room: the fit leaves that room at the bottom (it settles in a few passes).
  const fit = (reserve: number): number => Math.max(1e-3, Math.min((width - 2 * pad) / bw, (height - 2 * pad - reserve) / bh, MAX_SCALE));
  let scale = fit(0);
  for (let k = 0; k < 4; k++) scale = fit(chipOverhang(width, scale));
  const chipReserve = chipOverhang(width, scale);
  const offset: Pt = {
    x: (width - bw * scale) / 2 - minX * scale,
    y: (height - bh * scale - chipReserve) / 2 - minY * scale,
  };
  const tx = (p: Pt): Pt => ({ x: offset.x + p.x * scale, y: offset.y + p.y * scale });

  // The chip text is 14 px or more on a narrow viewport. The reason badge keeps its 11 px rule (it sizes the Hunt slot).
  const labelPx = chipFont(width, scale);
  const badgePx = Math.max(MIN_FONT_PX, 0.28 * scale);
  const compact = scale < COMPACT_BELOW;
  const chipH = (CHIP_H * labelPx) / scale;
  const roomH = ROOM_SCREEN_H;

  const roomLayouts: RoomLayout[] = units.map((u) => {
    const c = u.center;
    // Unit space, relative to the floor centre (the front corner is +1 below it). One chip per room: its top is in
    // the bottom 20 % of the room's screen rect, so a tall chip hangs below the front corner and a short one sits on it.
    // The hunt slot is on the left back wall, far above.
    const chipW = ((u.name.length + CHIP_EXTRA_CHARS) * CHIP_CHAR_W * labelPx) / scale + (2 * CHIP_PAD_X * labelPx) / scale;
    const chipTop = 1 - Math.min(chipH, CHIP_BAND * roomH);
    const chipBoxU: Rect = { x: c.x - chipW / 2, y: c.y + chipTop, w: chipW, h: chipH };
    const huntU: Rect = { x: c.x - 1.5, y: c.y - 1.15, w: 1.0, h: 0.3 };
    const figure = figurePlace(FIGURE_X, chipTop);
    const toRect = (r: Rect): Rect => ({ x: offset.x + r.x * scale, y: offset.y + r.y * scale, w: r.w * scale, h: r.h * scale });
    const sil = u.silhouette.map(tx);
    const hx = Math.min(...sil.map((p) => p.x));
    const hy = Math.min(...sil.map((p) => p.y));
    const hw = Math.max(...sil.map((p) => p.x)) - hx;
    const hh = Math.max(...sil.map((p) => p.y)) - hy;
    return {
      name: u.name,
      grid: u.grid,
      floor: u.floor.map(tx) as [Pt, Pt, Pt, Pt],
      silhouette: sil,
      center: tx(c),
      chipAt: tx({ x: c.x, y: c.y + chipTop + chipH / 2 }),
      chipBox: toRect(chipBoxU),
      chipBand: toRect({ x: c.x - (ROOM_STRIDE * 1.0), y: c.y + 1 - CHIP_BAND * roomH, w: 2 * ROOM_STRIDE, h: CHIP_BAND * roomH + Math.max(0, chipH - CHIP_BAND * roomH) }),
      textTop: offset.y + (c.y + chipTop) * scale,
      hit: { x: hx, y: hy, w: hw, h: hh },
      hitPolygon: sil.map((p) => ({ x: p.x - hx, y: p.y - hy })),
      huntRect: toRect(huntU),
      exorcistAt: tx({ x: c.x + figure.feet.x, y: c.y + figure.feet.y }),
      exorcistBox: toRect({ x: c.x + figure.box.x, y: c.y + figure.box.y, w: figure.box.w, h: figure.box.h }),
      doors: { px: tx(u.doors.px), mx: tx(u.doors.mx), py: tx(u.doors.py), my: tx(u.doors.my) },
    };
  });

  return {
    width,
    height,
    dpr,
    scale,
    offset,
    compact,
    labelPx,
    badgePx,
    chipReserve,
    rooms: roomLayouts,
    corridors: corridorsUnit.map((c) => ({ from: c.from, to: c.to, points: c.points.map(tx), width: CORRIDOR_WIDTH * scale })),
    house: {
      footprint: houseU.footprint.map(tx) as [Pt, Pt, Pt, Pt],
      backLeft: houseU.backLeft.map(tx),
      backRight: houseU.backRight.map(tx),
      roof: houseU.roof.map(tx) as [Pt, Pt, Pt],
      chimney: houseU.chimney.map(tx),
      atticWindow: { center: tx(houseU.atticWindow.center), radius: houseU.atticWindow.radius * scale },
      plinth: houseU.plinth.map(tx),
      groundLine: houseU.groundLine.map(tx),
    },
    aspect: bw / bh,
  };
}

/** Height of the mount for a given width: the house aspect, between 220 px and 70 percent of the window. */
export function mountHeight(width: number, aspect: number, windowHeight: number): number {
  const wanted = width / Math.max(aspect, 0.1);
  return Math.round(Math.min(Math.max(wanted, 220), Math.max(220, 0.7 * windowHeight)));
}
