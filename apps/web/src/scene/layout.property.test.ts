import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { SERVICE_NAMES, type ServiceName } from '@haunted-ops/shared';
import { bounds, insideConvex, insideDiamond, rectCorners, rectGap, rectInside, separation } from '../test/geometry.js';
import { COMPACT_BELOW, computeLayout, mountHeight, type LayoutRoom, type Pt, type RoomLayout } from './layout.js';
import { corridorLight, toSceneModel } from './model.js';
import { isNavKey, nextRoom, tabOrder, type NavKey } from './selection.js';
import { serviceStateArb } from '../test/arbs.js';

const RUNS = { numRuns: 150 };
const CELLS = Array.from({ length: 9 }, (_, i) => ({ x: i % 3, y: Math.floor(i / 3) }));

const viewportArb = fc.record({
  width: fc.integer({ min: 360, max: 3840 }),
  height: fc.integer({ min: 360, max: 2160 }),
  dpr: fc.double({ min: 1, max: 4, noNaN: true }),
});

/** 1 to 9 distinct cells of the 3 by 3 grid; names cycle (so they repeat above 4 rooms). */
const manyRooms: fc.Arbitrary<LayoutRoom[]> = fc
  .subarray(CELLS, { minLength: 1, maxLength: 9 })
  .map((cells) => cells.map((grid, i) => ({ name: SERVICE_NAMES[i % 4] as ServiceName, grid })));

/** 1 to 4 distinct cells with distinct, shuffled service names. */
const fewRooms: fc.Arbitrary<LayoutRoom[]> = fc
  .tuple(fc.subarray(CELLS, { minLength: 1, maxLength: 4 }), fc.shuffledSubarray([...SERVICE_NAMES], { minLength: 4, maxLength: 4 }))
  .map(([cells, names]) => cells.map((grid, i) => ({ name: names[i] as ServiceName, grid })));

// Feature: scene-engine, Property 7
describe('Property 7: the layout fits and never overlaps', () => {
  it('holds for any grid up to 3 by 3 and any viewport from 360 by 360 to 3840 by 2160', () => {
    fc.assert(
      fc.property(manyRooms, viewportArb, (rooms, viewport) => {
        const layout = computeLayout(rooms, viewport);
        expect(computeLayout(rooms, viewport)).toEqual(layout);
        expect(layout.dpr).toBeLessThanOrEqual(2);
        expect(layout.labelPx).toBeGreaterThanOrEqual(11);
        expect(layout.badgePx).toBeGreaterThanOrEqual(11);
        expect(layout.compact).toBe(layout.scale < COMPACT_BELOW);
        const eps = 1e-6;
        for (const r of layout.rooms) {
          for (const p of r.silhouette) {
            expect(p.x).toBeGreaterThanOrEqual(-eps);
            expect(p.x).toBeLessThanOrEqual(viewport.width + eps);
            expect(p.y).toBeGreaterThanOrEqual(-eps);
            expect(p.y).toBeLessThanOrEqual(viewport.height + eps);
          }
          // The hunt slot is inside the room (on its left back wall) and clear of every text box.
          for (const c of rectCorners(r.huntRect)) expect(insideConvex(r.silhouette, c)).toBeGreaterThanOrEqual(-eps);
          expect(rectGap(r.huntRect, r.labelBox)).toBeGreaterThan(0);
          expect(rectGap(r.huntRect, r.badgeBox)).toBeGreaterThan(0);
          expect(rectGap(r.huntRect, r.incidentBox)).toBeGreaterThan(0);
          expect(rectGap(r.labelBox, r.badgeBox)).toBeGreaterThan(0);
          expect(rectGap(r.incidentBox, r.badgeBox)).toBeGreaterThan(0);
          if (!layout.compact) expect(rectGap(r.labelBox, r.incidentBox)).toBeGreaterThan(0);
        }
        for (let i = 0; i < layout.rooms.length; i++) {
          for (let j = i + 1; j < layout.rooms.length; j++) {
            expect(separation(layout.rooms[i]!.silhouette, layout.rooms[j]!.silhouette)).toBeGreaterThan(0);
          }
        }
        // The house (walls, roof, chimney, plinth) stays inside the canvas too.
        const house = layout.house!;
        for (const p of [...house.roof, ...house.chimney, ...house.backLeft, ...house.backRight, ...house.plinth]) {
          expect(p.x).toBeGreaterThanOrEqual(-eps);
          expect(p.x).toBeLessThanOrEqual(viewport.width + eps);
          expect(p.y).toBeGreaterThanOrEqual(-eps);
          expect(p.y).toBeLessThanOrEqual(viewport.height + eps);
        }
      }),
      RUNS,
    );
  });
});

const HOUSE: LayoutRoom[] = [
  { name: 'gate', grid: { x: 0, y: 0 } },
  { name: 'orders', grid: { x: 1, y: 0 } },
  { name: 'payments', grid: { x: 0, y: 1 } },
  { name: 'ledger', grid: { x: 1, y: 1 } },
];

// Feature: scene-engine, Property 15
describe('Property 15: the nameplate and the badges stay inside their room', () => {
  it('keeps label, incident and reason boxes inside the screen bounds of the floor, clear of other rooms, for every gallery size', () => {
    // The gallery range: the four-room house from 360 to 3840 px wide, at the mount height or any height.
    const galleryArb = fc
      .record({ width: fc.integer({ min: 360, max: 3840 }), windowHeight: fc.integer({ min: 360, max: 2160 }), free: fc.boolean(), height: fc.integer({ min: 360, max: 2160 }), dpr: fc.constantFrom(1, 2) })
      .map((g) => {
        const aspect = computeLayout(HOUSE, { width: 1000, height: 1000, dpr: 1 }).aspect;
        return { width: g.width, height: g.free ? g.height : mountHeight(g.width, aspect, g.windowHeight), dpr: g.dpr };
      });
    fc.assert(
      fc.property(galleryArb, (viewport) => {
        const layout = computeLayout(HOUSE, viewport);
        for (const r of layout.rooms) {
          const floorBounds = bounds(r.floor);
          for (const box of [r.labelBox, r.incidentBox, r.badgeBox]) {
            expect(rectInside(box, floorBounds)).toBe(true);
            for (const other of layout.rooms) {
              if (other !== r) expect(separation(rectCorners(box), other.silhouette)).toBeGreaterThan(0);
            }
          }
          // The incident row is never wider than the room.
          expect(r.incidentBox.w).toBeLessThanOrEqual(floorBounds.w);
        }
      }),
      RUNS,
    );
  });
});

const near = (a: Pt, b: Pt): boolean => Math.hypot(a.x - b.x, a.y - b.y) < 1e-6;

// Feature: scene-engine, Property 8
describe('Property 8: corridors follow the call chain through the gaps', () => {
  it('connects consecutive services in order, through doors, without entering a floor', () => {
    fc.assert(
      fc.property(fewRooms, viewportArb, (rooms, viewport) => {
        const layout = computeLayout(rooms, viewport);
        const present = SERVICE_NAMES.filter((n) => rooms.some((r) => r.name === n));
        expect(layout.corridors.map((c) => [c.from, c.to])).toEqual(present.slice(1).map((n, i) => [present[i], n]));
        const byName = new Map<string, RoomLayout>(layout.rooms.map((r) => [r.name, r]));
        for (const c of layout.corridors) {
          const a = byName.get(c.from)!;
          const b = byName.get(c.to)!;
          expect(Object.values(a.doors).some((d) => near(d, c.points[0] as Pt))).toBe(true);
          expect(Object.values(b.doors).some((d) => near(d, c.points[c.points.length - 1] as Pt))).toBe(true);
          for (let i = 1; i < c.points.length; i++) {
            const p = c.points[i - 1] as Pt;
            const q = c.points[i] as Pt;
            for (let s = 0; s <= 24; s++) {
              const t = s / 24;
              const pt = { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t };
              for (const room of layout.rooms) {
                // On the edge of a floor (a door) is allowed; strictly inside is not.
                expect(insideDiamond(room.floor, pt)).toBeLessThan(1e-6 * Math.max(1, layout.scale));
              }
            }
          }
        }
      }),
      RUNS,
    );
  });

  it('is as lit as the dimmer room and dark when either is dark', () => {
    fc.assert(
      fc.property(serviceStateArb, serviceStateArb, (a, b) => {
        const model = toSceneModel([a, b], 0, { reducedMotion: false, quality: 'full' });
        const [ra, rb] = model.rooms as [(typeof model.rooms)[number], (typeof model.rooms)[number]];
        const lit = corridorLight(ra, rb);
        expect(lit).toBe(corridorLight(rb, ra));
        if (ra.dark || rb.dark) expect(lit).toBe(0);
        else expect(lit).toBe(Math.min(ra.light, rb.light));
        expect(lit).toBeLessThanOrEqual(Math.min(ra.light, rb.light));
      }),
      RUNS,
    );
    expect(corridorLight(makeLight(0.5, false), makeLight(0.8, false))).toBe(0.5);
  });
});

function makeLight(light: number, dark: boolean): { light: number; dark: boolean } {
  return { light, dark };
}

// Feature: scene-engine, Property 13
describe('Property 13: keyboard navigation stays inside the house', () => {
  const keysArb = fc.constantFrom<NavKey>('ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End');

  it('lists every room once in reading order, stays in the set and moves when it can', () => {
    fc.assert(
      fc.property(fewRooms, viewportArb, keysArb, (rooms, viewport, key) => {
        const layout = computeLayout(rooms, viewport);
        const order = tabOrder(layout.rooms);
        expect(new Set(order).size).toBe(rooms.length);
        expect(order).toEqual(layout.rooms.map((r) => r.name));
        const names = new Set(order);
        for (const here of layout.rooms) {
          const next = nextRoom(layout.rooms, here.name, key);
          expect(names.has(next)).toBe(true);
          if (key === 'Home') expect(next).toBe(order[0]);
          if (key === 'End') expect(next).toBe(order[order.length - 1]);
          if (isNavKey(key) && key.startsWith('Arrow')) {
            const inDirection = layout.rooms.some((r) => {
              const dx = r.center.x - here.center.x;
              const dy = r.center.y - here.center.y;
              const along = key === 'ArrowRight' ? dx : key === 'ArrowLeft' ? -dx : key === 'ArrowDown' ? dy : -dy;
              return r !== here && along > 1e-6;
            });
            if (inDirection) expect(next).not.toBe(here.name);
            else expect(next).toBe(here.name);
          }
        }
      }),
      RUNS,
    );
  });
});
