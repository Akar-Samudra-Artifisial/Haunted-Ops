import { describe, expect, it } from 'vitest';
import { SERVICE_NAMES } from '@haunted-ops/shared';
import { insideConvex, insideDiamond, rectCorners, rectGap, separation } from '../test/geometry.js';
import { COMPACT_BELOW, ROOM_STRIDE, computeLayout, mountHeight, readingOrder, type LayoutRoom } from './layout.js';
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

  it('is compact for nine rooms at 360 px and keeps text at 11 px', () => {
    const nine: LayoutRoom[] = Array.from({ length: 9 }, (_, i) => ({ name: SERVICE_NAMES[i % 4] as LayoutRoom['name'], grid: { x: i % 3, y: Math.floor(i / 3) } }));
    const layout = computeLayout(nine, view(360, 360));
    expect(layout.compact).toBe(true);
    expect(layout.labelPx).toBe(11);
    expect(layout.badgePx).toBe(11);
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

  it('puts the nameplate at the front, the incident row above it, the reason behind, and the hunt slot on the back wall', () => {
    const layout = computeLayout(HOUSE, view(1280, 720));
    for (const r of layout.rooms) {
      for (const c of rectCorners(r.huntRect)) expect(insideConvex(r.silhouette, c)).toBeGreaterThanOrEqual(0);
      // On the wall, not on the floor: the hunt slot sits above the back corner of the floor.
      expect(r.huntRect.y + r.huntRect.h).toBeLessThanOrEqual(r.center.y);
      expect(rectGap(r.huntRect, r.labelBox)).toBeGreaterThan(0);
      expect(rectGap(r.huntRect, r.badgeBox)).toBeGreaterThan(0);
      expect(rectGap(r.huntRect, r.incidentBox)).toBeGreaterThan(0);
      expect(rectGap(r.labelBox, r.badgeBox)).toBeGreaterThan(0);
      expect(rectGap(r.labelBox, r.incidentBox)).toBeGreaterThan(0);
      expect(rectGap(r.incidentBox, r.badgeBox)).toBeGreaterThan(0);
      // Front to back: name, incident, reason. The name sits in the front half, near the front corner.
      const front = r.floor[2].y;
      expect(r.labelBox.y).toBeGreaterThan(r.center.y);
      expect(r.labelBox.y + r.labelBox.h).toBeLessThan(front);
      expect(front - (r.labelBox.y + r.labelBox.h)).toBeLessThan(0.15 * layout.scale);
      expect(r.incidentBox.y).toBeLessThan(r.labelBox.y);
      expect(r.badgeBox.y).toBeLessThan(r.incidentBox.y);
      expect(r.textTop).toBeLessThanOrEqual(r.badgeBox.y);
      expect(insideDiamond(r.floor, r.labelAt)).toBeGreaterThan(0);
      expect(r.hitPolygon).toHaveLength(6);
      expect(r.hit.w).toBeGreaterThan(0);
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
