import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { SERVICE_NAMES, type ServiceName } from '@haunted-ops/shared';
import { insideConvex, insideDiamond, rectCorners, rectGap, rectInside, separation } from '../test/geometry.js';
import { COMPACT_BELOW, computeLayout, mountHeight, type LayoutRoom, type Pt, type RoomLayout } from './layout.js';
import { corridorLight, toSceneModel } from './model.js';
import { isNavKey, nextRoom, tabOrder, type NavKey } from './selection.js';
import { serviceStateArb } from '../test/arbs.js';
import { huntBadgeMaxWidth, huntBadgeRect } from './shapes.js';

/** The hunt badge of every room (at its widest text) is clear of every chip, from 364 px up (a 390 px phone). */
function expectBadgesClear(layout: ReturnType<typeof computeLayout>): void {
  if (layout.width < 364) return;
  const font = layout.labelPx;
  for (const r of layout.rooms) {
    const badge = huntBadgeRect(r.hit, layout.width, huntBadgeMaxWidth(font), font, layout.rooms.map((o) => o.chipBox));
    expect(badge.x).toBeGreaterThanOrEqual(0);
    expect(badge.x + badge.w).toBeLessThanOrEqual(layout.width + 1e-6);
    for (const other of layout.rooms) expect(rectGap(badge, other.chipBox), `${r.name} badge over the ${other.name} chip`).toBeGreaterThan(0);
  }
}

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
          // The hunt slot is inside the room (on its left back wall) and clear of the chip.
          for (const c of rectCorners(r.huntRect)) expect(insideConvex(r.silhouette, c)).toBeGreaterThanOrEqual(-eps);
          expect(rectGap(r.huntRect, r.chipBox)).toBeGreaterThan(0);
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
  }, 30_000);
});

const HOUSE: LayoutRoom[] = [
  { name: 'gate', grid: { x: 0, y: 0 } },
  { name: 'orders', grid: { x: 1, y: 0 } },
  { name: 'payments', grid: { x: 0, y: 1 } },
  { name: 'ledger', grid: { x: 1, y: 1 } },
];

// Feature: scene-engine, Property 15
describe('Property 15: the chip stays under its room', () => {
  it('keeps the chip of every room in the band under it, clear of the hunt slot, for every gallery size', () => {
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
          expect(rectInside(r.chipBox, r.chipBand)).toBe(true);
          expect(rectGap(r.huntRect, r.chipBox)).toBeGreaterThan(0);
          // The chip is centred under its room.
          expect(r.chipBox.x + r.chipBox.w / 2).toBeCloseTo(r.center.x, 3);
        }
        expectBadgesClear(layout);
      }),
      RUNS,
    );
  }, 30_000);
});

// Feature: visual-refresh, Property 7
describe('Property 7: one chip per room, in the band under it, and no two chips overlap', () => {
  it('holds for any room set of the 3 by 3 grid and any viewport width from 320 to 1920', () => {
    const aspect = computeLayout(HOUSE, { width: 1000, height: 1000, dpr: 1 }).aspect;
    const arb = fc.record({ rooms: fewRooms, width: fc.integer({ min: 320, max: 1920 }), windowHeight: fc.integer({ min: 560, max: 1200 }) });
    fc.assert(
      fc.property(arb, ({ rooms, width, windowHeight }) => {
        const layout = computeLayout(rooms, { width, height: mountHeight(width, aspect, windowHeight), dpr: 1 });
        const eps = 1e-6;
        expect(layout.rooms).toHaveLength(rooms.length);
        // Under 640 px the chip text is 14 px or more; from 640 px the 11 px rule stays.
        expect(layout.labelPx).toBe(width < 640 ? 14 : 12);
        for (const r of layout.rooms) {
          const band = { x: r.center.x - 3.2 * layout.scale, w: 6.4 * layout.scale, y: r.hit.y + 0.8 * r.hit.h, h: 0 };
          // Inside the column of its room, and starting in the bottom 20 % of the room's screen rect.
          expect(r.chipBox.x).toBeGreaterThanOrEqual(band.x - eps);
          expect(r.chipBox.x + r.chipBox.w).toBeLessThanOrEqual(band.x + band.w + eps);
          expect(r.chipBox.y).toBeGreaterThanOrEqual(band.y - eps);
          // It covers at most the bottom 20 % of the room: the rest hangs below the front corner.
          const covered = Math.max(0, Math.min(r.chipBox.y + r.chipBox.h, r.hit.y + r.hit.h) - r.chipBox.y);
          expect(covered).toBeLessThanOrEqual(0.2 * r.hit.h + eps);
          expect(rectInside(r.chipBox, r.chipBand)).toBe(true);
        }
        for (let i = 0; i < layout.rooms.length; i++) {
          for (let j = i + 1; j < layout.rooms.length; j++) {
            expect(rectGap(layout.rooms[i]!.chipBox, layout.rooms[j]!.chipBox)).toBeGreaterThan(0);
          }
        }
        expectBadgesClear(layout);
      }),
      RUNS,
    );
  }, 30_000);
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
  }, 30_000);

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
  }, 30_000);
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
  }, 30_000);
});
