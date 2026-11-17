import { describe, expect, it } from 'vitest';
import { SERVICE_NAMES } from '@haunted-ops/shared';
import { insideConvex, insideDiamond, rectCorners, rectGap, separation } from '../test/geometry.js';
import { COMPACT_BELOW, FIGURE_H_SPRITE, FIGURE_MIN_PX_NARROW, MIN_FONT_NARROW_PX, ROOM_STRIDE, computeLayout, mountHeight, readingOrder, type LayoutRoom } from './layout.js';
import { huntBadgeMaxWidth, huntBadgeRect } from './shapes.js';
import { nextRoom, selectionReducer, tabOrder } from './selection.js';

const HOUSE: LayoutRoom[] = [
  { name: 'gate', grid: { x: 0, y: 0 } },
  { name: 'orders', grid: { x: 1, y: 0 } },
  { name: 'payments', grid: { x: 0, y: 1 } },
  { name: 'ledger', grid: { x: 1, y: 1 } },
];
const view = (width: number, height: number, dpr = 1) => ({ width, height, dpr });

describe('computeLayout', () => {
  it('keeps a clearance of at least 0.17 iso units between the silhouettes of a 3 by 3 grid', () => {
    const nine: LayoutRoom[] = Array.from({ length: 9 }, (_, i) => ({ name: SERVICE_NAMES[i % 4] as LayoutRoom['name'], grid: { x: i % 3, y: Math.floor(i / 3) } }));
    const layout = computeLayout(nine, view(1600, 900));
    let min = Infinity;
    for (let i = 0; i < layout.rooms.length; i++) {
      for (let j = i + 1; j < layout.rooms.length; j++) {
        min = Math.min(min, separation(layout.rooms[i]!.silhouette, layout.rooms[j]!.silhouette));
      }
    }
    expect(min / layout.scale).toBeGreaterThan(0.17);
    expect(ROOM_STRIDE).toBe(3.2);
  });

  it.each([
    [360, 360],
    [1280, 720],
    [3840, 2160],
  ])('fits the 2 by 2 house in %i by %i, centred, with the rooms in reading order', (w, h) => {
    const layout = computeLayout(HOUSE, view(w, h));
    expect(layout.rooms.map((r) => r.name)).toEqual(['gate', 'orders', 'payments', 'ledger']);
    for (const r of layout.rooms) {
      for (const p of r.silhouette) {
        expect(p.x).toBeGreaterThanOrEqual(0);
        expect(p.x).toBeLessThanOrEqual(w);
        expect(p.y).toBeGreaterThanOrEqual(0);
        expect(p.y).toBeLessThanOrEqual(h);
      }
    }
    const xs = layout.rooms.flatMap((r) => r.silhouette.map((p) => p.x));
    expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeCloseTo(w / 2, 3);
    expect(layout.compact).toBe(layout.scale < COMPACT_BELOW);
  });

  it('uses the full scale cap on a 4K screen, and the 360 px layout is not compact for four rooms', () => {
    expect(computeLayout(HOUSE, view(3840, 2160)).scale).toBe(160);
    const small = computeLayout(HOUSE, view(360, 360));
    // The house outline (roof, chimney, plinth) takes some room, so the rooms are a little smaller.
    expect(small.scale).toBeGreaterThan(COMPACT_BELOW);
    expect(small.compact).toBe(false);
    expect(small.labelPx).toBeGreaterThanOrEqual(11);
  });

  it('is compact for nine rooms at 360 px, draws the room name at 14 px and keeps the reason badge at 11 px', () => {
    const nine: LayoutRoom[] = Array.from({ length: 9 }, (_, i) => ({ name: SERVICE_NAMES[i % 4] as LayoutRoom['name'], grid: { x: i % 3, y: Math.floor(i / 3) } }));
    const layout = computeLayout(nine, view(360, 360));
    expect(layout.compact).toBe(true);
    // Under 40rem the name is at least 14 px; the badge keeps its 11 px minimum.
    expect(layout.labelPx).toBe(14);
    expect(layout.badgePx).toBe(11);
  });

  it('fixes the chip text at 12 px from 640 px up (not scaled by the zoom) and 14 px below', () => {
    expect(computeLayout(HOUSE, view(1280, 720)).labelPx).toBe(12);
    expect(computeLayout(HOUSE, view(1920, 1080)).labelPx).toBe(12);
    expect(computeLayout(HOUSE, view(3840, 2160)).labelPx).toBe(12);
    const nine: LayoutRoom[] = Array.from({ length: 9 }, (_, i) => ({ name: SERVICE_NAMES[i % 4] as LayoutRoom['name'], grid: { x: i % 3, y: Math.floor(i / 3) } }));
    expect(computeLayout(nine, view(639, 640)).labelPx).toBe(MIN_FONT_NARROW_PX);
    expect(computeLayout(nine, view(640, 640)).labelPx).toBe(12);
    expect(computeLayout(HOUSE, view(390, 560)).labelPx).toBe(14);
    // The level word shows from 640 px up when it fits the column of its room, never under 640 px.
    expect(computeLayout(HOUSE, view(1440, 900)).levelWord).toBe(true);
    expect(computeLayout(HOUSE, view(390, 844)).levelWord).toBe(false);
  });

  it('caps the device pixel ratio at 2 and handles a house with gaps and a single room', () => {
    expect(computeLayout(HOUSE, view(800, 600, 3)).dpr).toBe(2);
    expect(computeLayout(HOUSE, view(800, 600, 1.5)).dpr).toBe(1.5);
    const gaps = computeLayout([{ name: 'gate', grid: { x: 0, y: 0 } }, { name: 'payments', grid: { x: 2, y: 2 } }], view(800, 600));
    expect(gaps.rooms).toHaveLength(2);
    expect(gaps.corridors).toHaveLength(1);
    const one = computeLayout([{ name: 'ledger', grid: { x: 2, y: 1 } }], view(800, 600));
    expect(one.rooms).toHaveLength(1);
    expect(one.corridors).toEqual([]);
    expect(computeLayout([], view(800, 600)).rooms).toEqual([]);
  });

  it('routes gate to orders straight and orders to payments through the junction', () => {
    const layout = computeLayout(HOUSE, view(1280, 720));
    const [gateOrders, ordersPayments, paymentsLedger] = layout.corridors;
    expect(layout.corridors.map((c) => `${c.from}>${c.to}`)).toEqual(['gate>orders', 'orders>payments', 'payments>ledger']);
    expect(gateOrders!.points).toHaveLength(3);
    expect(paymentsLedger!.points).toHaveLength(3);
    expect(ordersPayments!.points.length).toBeGreaterThanOrEqual(4);
    const centreX = layout.rooms.reduce((n, r) => n + r.center.x, 0) / 4;
    expect(ordersPayments!.points.some((p) => Math.abs(p.x - centreX) < 1e-6)).toBe(true);
  });

  it('puts the hunt badge in the hunt slot rules: 12 px from 640 px up and 14 px below, 1.9 of the font high, clear of every chip and inside the canvas', () => {
    for (const w of [390, 768, 1024, 1440, 364, 320, 639, 640]) {
      const layout = computeLayout(HOUSE, view(w, w < 640 ? 844 : 900));
      const font = w < 640 ? 14 : 12;
      for (const r of layout.rooms) {
        const badge = huntBadgeRect(r.hit, w, huntBadgeMaxWidth(font), font, layout.rooms.map((o) => o.chipBox));
        expect(badge.h).toBeCloseTo(1.9 * font);
        expect(badge.x).toBeGreaterThanOrEqual(0);
        expect(badge.x + badge.w).toBeLessThanOrEqual(w + 1e-6);
        expect(badge.y + badge.h).toBeLessThanOrEqual(layout.height);
        // Clear of its own chip at every width, and of every chip from 364 px (a 390 px phone) up; at 320 px the ledger badge touches
        // the chips around it by a few px (no free place of its size there; the chips are drawn above it).
        expect(rectGap(badge, r.chipBox)).toBeGreaterThan(0);
        for (const other of layout.rooms) {
          if (w >= 364 || r.name !== 'ledger') expect(rectGap(badge, other.chipBox), `${r.name} badge over the ${other.name} chip at ${w}`).toBeGreaterThan(0);
          else expect(rectGap(badge, other.chipBox)).toBeGreaterThan(-6);
        }
        // Above the body of the working figure (its glow is centred at half its height; the figure layer is drawn over the badge).
        const figureH = Math.max(FIGURE_H_SPRITE * layout.scale, w < 640 ? FIGURE_MIN_PX_NARROW : 0);
        expect(badge.y + badge.h).toBeLessThanOrEqual(r.exorcistAt.y - 0.5 * figureH + 1e-6);
        // The slot itself does not change: it stays clear of the chip.
        expect(rectGap(r.huntRect, r.chipBox)).toBeGreaterThan(0);
      }
    }
  });
  it('puts one chip under each room, in its bottom 20 % and below the front corner, and the hunt slot on the back wall', () => {
    for (const [w, h] of [[1440, 900], [390, 844]] as const) {
      const layout = computeLayout(HOUSE, view(w, h));
      for (const r of layout.rooms) {
        for (const c of rectCorners(r.huntRect)) expect(insideConvex(r.silhouette, c)).toBeGreaterThanOrEqual(0);
        // On the wall, not on the floor: the hunt slot sits above the back corner of the floor.
        expect(r.huntRect.y + r.huntRect.h).toBeLessThanOrEqual(r.center.y);
        expect(rectGap(r.huntRect, r.chipBox)).toBeGreaterThan(0);
        // The chip starts in the bottom fifth of the room's screen rect and never above it.
        const front = r.floor[2].y;
        const fifth = r.hit.y + 0.8 * r.hit.h;
        expect(r.chipBox.y).toBeGreaterThanOrEqual(fifth - 1e-6);
        expect(r.chipBox.y).toBeLessThan(front);
        // It is as large as the text rule says, in front of the floor edge: its middle is lower than the floor centre.
        expect(r.chipBox.h).toBeGreaterThanOrEqual(layout.labelPx);
        expect(r.chipAt.y).toBeGreaterThan(r.center.y);
        expect(r.chipAt.x).toBeCloseTo(r.center.x);
        // The part inside the room is at most 20 % of its height; the rest hangs below the front corner.
        const inside = Math.min(r.chipBox.y + r.chipBox.h, r.hit.y + r.hit.h) - r.chipBox.y;
        expect(inside).toBeLessThanOrEqual(0.2 * r.hit.h + 1e-6);
        expect(r.textTop).toBeCloseTo(r.chipBox.y);
        expect(insideDiamond(r.floor, r.chipAt)).toBeGreaterThan(0);
        expect(r.hitPolygon).toHaveLength(6);
        expect(r.hit.w).toBeGreaterThan(0);
      }
      for (let i = 0; i < layout.rooms.length; i++) {
        for (let j = i + 1; j < layout.rooms.length; j++) expect(rectGap(layout.rooms[i]!.chipBox, layout.rooms[j]!.chipBox)).toBeGreaterThan(0);
      }
      // The chips hang below the lowest room: the fit left that room inside the canvas.
      for (const r of layout.rooms) expect(r.chipBox.y + r.chipBox.h).toBeLessThanOrEqual(h + 1e-6);
    }
  });

  it('is the same for the same input and gives the mount a height from the aspect', () => {
    expect(computeLayout(HOUSE, view(900, 500))).toEqual(computeLayout(HOUSE, view(900, 500)));
    const aspect = computeLayout(HOUSE, view(900, 500)).aspect;
    expect(aspect).toBeGreaterThan(1.3);
    expect(mountHeight(900, aspect, 1000)).toBe(Math.round(900 / aspect));
    expect(mountHeight(200, aspect, 1000)).toBe(220);
    expect(mountHeight(3000, aspect, 800)).toBe(560);
  });

  it('sorts rooms in reading order', () => {
    const shuffled = [HOUSE[3]!, HOUSE[0]!, HOUSE[2]!, HOUSE[1]!];
    expect(readingOrder(shuffled).map((r) => r.name)).toEqual(['gate', 'orders', 'payments', 'ledger']);
  });
});

describe('selection', () => {
  const rooms = computeLayout(HOUSE, view(1280, 720)).rooms;

  it('moves to the nearest room in the direction of an arrow key and stays when there is none', () => {
    expect(nextRoom(rooms, 'gate', 'ArrowRight')).toBe('orders');
    expect(nextRoom(rooms, 'gate', 'ArrowDown')).toBe('ledger');
    expect(nextRoom(rooms, 'orders', 'ArrowLeft')).toBe('payments');
    expect(nextRoom(rooms, 'payments', 'ArrowUp')).toBe('gate');
    expect(nextRoom(rooms, 'gate', 'ArrowUp')).toBe('gate');
    expect(nextRoom(rooms, 'gate', 'ArrowLeft')).toBe('payments');
    expect(nextRoom(rooms, 'ledger', 'ArrowDown')).toBe('ledger');
  });

  it('goes to the first and the last room with Home and End, and lists the tab order', () => {
    expect(nextRoom(rooms, 'orders', 'Home')).toBe('gate');
    expect(nextRoom(rooms, 'orders', 'End')).toBe('ledger');
    expect(tabOrder(rooms)).toEqual(['gate', 'orders', 'payments', 'ledger']);
    expect(nextRoom([], 'gate', 'ArrowRight')).toBe('gate');
  });

  it('selects, toggles and clears', () => {
    expect(selectionReducer(null, { type: 'select', name: 'gate' })).toBe('gate');
    expect(selectionReducer('gate', { type: 'toggle', name: 'gate' })).toBeNull();
    expect(selectionReducer('gate', { type: 'toggle', name: 'orders' })).toBe('orders');
    expect(selectionReducer('gate', { type: 'clear' })).toBeNull();
  });
});
