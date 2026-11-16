import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { insideDiamond } from '../test/geometry.js';
import { computeLayout } from './layout.js';
import { PALETTE } from './palette.js';
import { CORRIDOR_STYLE, buildHouseArt, buildRoomArt, clockHands, chipLayout, pillRect, starField, wallHeightPx } from './shapes.js';
import { TEXTURE_NAMES, TEXTURE_RECIPES, drawTexture } from './textures.js';
import type { LayoutRoom } from './layout.js';

const HOUSE: LayoutRoom[] = [
  { name: 'gate', grid: { x: 0, y: 0 } },
  { name: 'orders', grid: { x: 1, y: 0 } },
  { name: 'payments', grid: { x: 0, y: 1 } },
  { name: 'ledger', grid: { x: 1, y: 1 } },
];
const layout = computeLayout(HOUSE, { width: 1280, height: 720, dpr: 1 });

describe('shapes', () => {
  it('keeps the walls, the lamp and the clock inside the silhouette of the room', () => {
    for (const room of layout.rooms) {
      const art = buildRoomArt(room, layout.scale);
      const xs = room.silhouette.map((p) => p.x);
      const ys = room.silhouette.map((p) => p.y);
      const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
      const eps = 1e-6;
      for (const poly of art.polys) {
        for (const p of poly.points) {
          expect(p.x).toBeGreaterThanOrEqual(x0 - eps);
          expect(p.x).toBeLessThanOrEqual(x1 + eps);
          expect(p.y).toBeGreaterThanOrEqual(y0 - eps);
          expect(p.y).toBeLessThanOrEqual(y1 + eps);
        }
      }
      const c = art.clock;
      expect(c.center.x - c.radius).toBeGreaterThanOrEqual(x0);
      expect(c.center.x + c.radius).toBeLessThanOrEqual(x1);
      expect(c.center.y - c.radius).toBeGreaterThanOrEqual(y0);
      expect(art.lampTop.y).toBeGreaterThan(y0);
    }
  });

  it('draws the floor first among the polygons that cover it and uses only palette colours', () => {
    const art = buildRoomArt(layout.rooms[0]!, layout.scale);
    const palette = new Set(Object.values(PALETTE));
    for (const p of art.polys) expect(palette.has(p.fill as never)).toBe(true);
    for (const l of art.lines) expect(palette.has(l.color as never)).toBe(true);
    expect(art.polys[2]!.points).toEqual(layout.rooms[0]!.floor);
    expect(wallHeightPx(layout.scale)).toBeCloseTo(layout.scale);
  });

  it('puts the rug on the floor, and the chip at the front, clear of the clock and the lamp', () => {
    for (const room of layout.rooms) {
      const art = buildRoomArt(room, layout.scale);
      for (const p of art.polys[3]!.points) expect(insideDiamond(room.floor, p)).toBeGreaterThan(0);
      const label = room.chipBox;
      const clock = art.clock;
      expect(clock.center.y + clock.radius).toBeLessThan(label.y);
      expect(art.lampTop.y).toBeLessThan(label.y);
      expect(label.y).toBeGreaterThan(room.center.y);
    }
  });

  it('draws a house behind the rooms: outer walls, a pitched roof with a chimney and an attic window, a plinth and a ground line', () => {
    const house = layout.house!;
    const art = buildHouseArt(house, layout.scale);
    const palette = new Set(Object.values(PALETTE));
    for (const p of art.polys) expect(palette.has(p.fill as never)).toBe(true);
    for (const l of [...art.lines, ...art.window.bars]) expect(palette.has(l.color as never)).toBe(true);
    expect(palette.has(art.window.fill as never)).toBe(true);
    const [eaveL, peak, eaveR] = house.roof;
    const roomTop = Math.min(...layout.rooms.flatMap((r) => r.silhouette.map((p) => p.y)));
    // The peak is above every room, the eaves are lower than the peak, the roof is wider than the rooms.
    expect(peak.y).toBeLessThan(roomTop);
    expect(eaveL.y).toBeGreaterThan(peak.y);
    expect(eaveR.y).toBeGreaterThan(peak.y);
    const xs = layout.rooms.flatMap((r) => r.silhouette.map((p) => p.x));
    expect(eaveL.x).toBeLessThan(Math.min(...xs));
    expect(eaveR.x).toBeGreaterThan(Math.max(...xs));
    // The chimney stands on the right slope; the attic window is in the gable, under the peak.
    expect(Math.min(...house.chimney.map((p) => p.x))).toBeGreaterThan(peak.x);
    expect(Math.min(...house.chimney.map((p) => p.y))).toBeGreaterThan(peak.y);
    expect(house.atticWindow.center.y).toBeGreaterThan(peak.y);
    expect(house.atticWindow.radius).toBeGreaterThan(0);
    // The ground line runs under the front corner of the house.
    const frontRoomBottom = Math.max(...layout.rooms.map((r) => r.floor[2].y));
    expect(Math.max(...house.groundLine.map((p) => p.y))).toBeGreaterThan(frontRoomBottom);
    for (const p of [...house.roof, ...house.chimney, ...house.plinth]) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(layout.width);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(layout.height);
    }
  });

  it('scales the house with the layout', () => {
    const small = computeLayout(HOUSE, { width: 360, height: 360, dpr: 1 }).house!;
    const big = computeLayout(HOUSE, { width: 3840, height: 2160, dpr: 1 }).house!;
    const width = (h: typeof small) => h.roof[2].x - h.roof[0].x;
    expect(width(big)).toBeGreaterThan(4 * width(small));
    expect(computeLayout([], { width: 800, height: 600, dpr: 1 }).house).toBeNull();
  });

  it('draws the idle corridor clearly and the lit line and pulses brighter', () => {
    expect(CORRIDOR_STYLE.idleAlpha).toBeGreaterThanOrEqual(0.5);
    expect(CORRIDOR_STYLE.litAlpha).toBeGreaterThan(CORRIDOR_STYLE.idleAlpha);
    expect(CORRIDOR_STYLE.pulseAlpha).toBeGreaterThan(CORRIDOR_STYLE.idleAlpha);
  });

  it('puts the "!" marker after the name inside one chip, only when an incident is open', () => {
    const room = layout.rooms[2]!;
    const base = { room, labelW: 80, labelH: layout.labelPx, bangW: 6 };
    const closed = chipLayout({ ...base, open: false });
    expect(closed.bang).toBeNull();
    const open = chipLayout({ ...base, open: true });
    expect(open.bang).not.toBeNull();
    // Same height and centre, wider by the marker; the marker is right of the name and on its line.
    expect(open.pill.h).toBeCloseTo(closed.pill.h);
    expect(open.pill.y).toBeCloseTo(closed.pill.y);
    expect(open.pill.w).toBeGreaterThan(closed.pill.w);
    expect(open.pill.x + open.pill.w / 2).toBeCloseTo(room.chipAt.x);
    expect(open.bang!.x).toBeGreaterThan(open.label.x + 80);
    expect(open.bang!.y).toBe(open.label.y);
    // The chip covers the name and the marker.
    expect(open.pill.x).toBeLessThan(open.label.x);
    expect(open.pill.x + open.pill.w).toBeGreaterThan(open.bang!.x + 6);
  });
  it('builds clock hands from the model angles', () => {
    const hands = clockHands({ hour: 0, minute: Math.PI / 2 }, { x: 10, y: 10 }, 10);
    expect(hands).toHaveLength(2);
    expect(hands[0]!.points[1]!.x).toBeCloseTo(10);
    expect(hands[0]!.points[1]!.y).toBeLessThan(10);
    expect(hands[1]!.points[1]!.x).toBeGreaterThan(10);
  });

  it('makes a fixed star field and a pill around a text box', () => {
    expect(starField(800, 600)).toEqual(starField(800, 600));
    expect(starField(800, 600, 10)).toHaveLength(10);
    const stars = starField(800, 600);
    expect(stars.every((s) => s.x >= 0 && s.x <= 800 && s.y >= 0 && s.y <= 600)).toBe(true);
    const pill = pillRect({ x: 100, y: 50 }, 60, 12);
    expect(pill.x + pill.w / 2).toBeCloseTo(100);
    expect(pill.w).toBeGreaterThan(60);
    expect(pill.r).toBeCloseTo(pill.h / 2);
  });
});

describe('room art of the lantern look', () => {
  it('has a floor gradient and darker inner walls inside the room, and keeps the floor and the rug at their places', () => {
    for (const room of layout.rooms) {
      const art = buildRoomArt(room, layout.scale);
      expect(art.detail.length).toBeGreaterThanOrEqual(5);
      const xs = room.silhouette.map((p) => p.x);
      const ys = room.silhouette.map((p) => p.y);
      for (const poly of art.detail) {
        for (const p of poly.points) {
          expect(p.x).toBeGreaterThanOrEqual(Math.min(...xs) - 1e-6);
          expect(p.x).toBeLessThanOrEqual(Math.max(...xs) + 1e-6);
          expect(p.y).toBeGreaterThanOrEqual(Math.min(...ys) - 1e-6);
          expect(p.y).toBeLessThanOrEqual(Math.max(...ys) + 1e-6);
        }
      }
      // The first three strips lie on the floor.
      for (const poly of art.detail.slice(0, 3)) for (const p of poly.points) expect(insideDiamond(room.floor, p)).toBeGreaterThan(-1e-6);
      const palette = new Set(Object.values(PALETTE));
      for (const poly of art.detail) expect(palette.has(poly.fill as never)).toBe(true);
      // The floor strips fade from the back to the front.
      const strips = art.detail.slice(0, 3).map((p) => p.alpha);
      expect([...strips].sort((a, b) => b - a)).toEqual(strips);
    }
  });

  it('draws one icon per known service on the back wall (coin, box, book, gate arch) and none for an unknown one', () => {
    const room = layout.rooms[0]!;
    const shapeCount = (name: string) => {
      const icon = buildRoomArt(room, layout.scale, name).icon;
      return icon === null ? null : icon.polys.length + icon.lines.length + icon.discs.length;
    };
    expect(buildRoomArt(room, layout.scale, 'payments').icon!.discs).toHaveLength(1);
    expect(buildRoomArt(room, layout.scale, 'orders').icon!.polys).toHaveLength(2);
    expect(buildRoomArt(room, layout.scale, 'ledger').icon!.polys).toHaveLength(2);
    expect(buildRoomArt(room, layout.scale, 'gate').icon!.lines.length).toBeGreaterThanOrEqual(2);
    for (const name of ['payments', 'orders', 'ledger', 'gate']) expect(shapeCount(name)).toBeGreaterThan(0);
    expect(buildRoomArt(room, layout.scale, 'unknown-service').icon).toBeNull();
    for (const l of layout.rooms) expect(buildRoomArt(l, layout.scale).icon).not.toBeNull();
  });

  it('keeps every icon on the right back wall, inside the silhouette, clear of the clock', () => {
    for (const room of layout.rooms) {
      const art = buildRoomArt(room, layout.scale);
      const icon = art.icon!;
      const xs = room.silhouette.map((p) => p.x);
      const ys = room.silhouette.map((p) => p.y);
      const points = [...icon.polys.flatMap((p) => p.points), ...icon.lines.flatMap((l) => l.points)];
      for (const p of points) {
        expect(p.x).toBeGreaterThanOrEqual(Math.min(...xs));
        expect(p.x).toBeLessThanOrEqual(Math.max(...xs));
        expect(p.y).toBeGreaterThanOrEqual(Math.min(...ys));
        expect(p.y).toBeLessThan(room.floor[2].y);
      }
      const rightmost = Math.max(...points.map((p) => p.x));
      expect(rightmost).toBeLessThan(art.clock.center.x - art.clock.radius);
    }
  });

  it('splits the roof and the chimney from the rest of the house, so the roof can fade', () => {
    const art = buildHouseArt(layout.house!, layout.scale);
    expect(art.roof.polys).toHaveLength(2);
    expect(art.roof.polys.map((p) => p.points)).toEqual([layout.house!.roof, layout.house!.chimney]);
    expect(art.roof.polys.every((p) => p.alpha === 1)).toBe(true);
  });

  it('makes two star layers of different stars', () => {
    expect(starField(800, 600, 40, 7)).not.toEqual(starField(800, 600, 16, 19).slice(0, 16));
    expect(starField(800, 600, 16, 19)).toEqual(starField(800, 600, 16, 19));
  });
});

describe('textures', () => {
  it('has at most 9 recipes (the ghost, the fog puffs, three noise clouds, the mote and the glow), each drawn once from code', () => {
    expect(TEXTURE_NAMES.length).toBeGreaterThan(0);
    expect(TEXTURE_NAMES.length).toBeLessThanOrEqual(9);
    expect(TEXTURE_NAMES).toEqual(expect.arrayContaining(['ghost', 'noiseA', 'noiseB', 'noiseC']));
    for (const name of TEXTURE_NAMES) {
      const r = TEXTURE_RECIPES[name];
      expect(r.width).toBeGreaterThan(0);
      expect(r.height).toBeGreaterThan(0);
    }
  });

  it('has a wide, flat puff for the fog bank and a round one for the wisps', () => {
    expect(TEXTURE_RECIPES.fogBank.width / TEXTURE_RECIPES.fogBank.height).toBeGreaterThan(2);
    expect(TEXTURE_RECIPES.fog.width).toBe(TEXTURE_RECIPES.fog.height);
  });

  it('draws every recipe with canvas calls only', () => {
    for (const name of TEXTURE_NAMES) {
      const calls: string[] = [];
      const ctx = new Proxy(
        {},
        {
          get: (_t, prop) => (prop === 'createRadialGradient' || prop === 'createLinearGradient' ? () => ({ addColorStop: () => calls.push('stop') }) : (..._a: unknown[]) => calls.push(String(prop))),
          set: () => true,
        },
      ) as unknown as CanvasRenderingContext2D;
      const doc = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) } as unknown as Document;
      const canvas = drawTexture(name, doc);
      expect(canvas.width).toBe(TEXTURE_RECIPES[name].width);
      expect(calls.length).toBeGreaterThan(0);
    }
  });
});

describe('asset audit', () => {
  const dir = 'src/scene';
  const sources = readdirSync(dir).filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\./.test(f));

  it('imports no image, SVG, font or sound file and loads nothing from the network', () => {
    for (const file of sources) {
      const text = readFileSync(`${dir}/${file}`, 'utf8');
      expect(text, file).not.toMatch(/from\s+['"][^'"]+\.(png|jpe?g|gif|webp|avif|svg|woff2?|ttf|otf|mp3|ogg|wav)(\?[^'"]*)?['"]/i);
      expect(text, file).not.toMatch(/new\s+Image\s*\(|new\s+Audio\s*\(|Assets\.load|fetch\s*\(|@font-face|url\(/);
    }
  });

  it('lets only pixi-surface.ts import pixi.js', () => {
    const importers = sources.filter((f) => /from\s+['"]pixi\.js/.test(readFileSync(`${dir}/${f}`, 'utf8')));
    expect(importers).toEqual(['pixi-surface.ts']);
  });

  it('uses the system font stack of the page', () => {
    const palette = readFileSync(`${dir}/palette.ts`, 'utf8');
    expect(palette).toContain('system-ui');
  });
});
