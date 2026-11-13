import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { insideDiamond } from '../test/geometry.js';
import { computeLayout } from './layout.js';
import { PALETTE } from './palette.js';
import { CORRIDOR_STYLE, buildHouseArt, buildRoomArt, clockHands, pillRect, plaqueLayout, starField, wallHeightPx } from './shapes.js';
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

  it('puts the rug on the floor, and the nameplate at the front, clear of the clock and the lamp', () => {
    for (const room of layout.rooms) {
      const art = buildRoomArt(room, layout.scale);
      for (const p of art.polys[3]!.points) expect(insideDiamond(room.floor, p)).toBeGreaterThan(0);
      const label = room.labelBox;
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

  it('puts the incident mark on the nameplate and falls back to "!" when the measured text is wider than the room allows', () => {
    const room = layout.rooms[2]!;
    const s = layout.badgePx;
    const base = { room, compact: false, markPx: s, labelW: 80, labelH: layout.labelPx };
    const closed = plaqueLayout({ ...base, open: false, wordW: 50 });
    expect(closed.mark).toBeNull();
    const long = plaqueLayout({ ...base, open: true, wordW: 50 });
    expect(long.mark?.form).toBe('long');
    expect(long.mark?.word).not.toBeNull();
    // Above the name, inside the same plate.
    expect(long.mark!.tri.y).toBeLessThan(room.labelAt.y);
    expect(long.plate.y).toBeLessThan(closed.plate.y);
    const tooWide = plaqueLayout({ ...base, open: true, wordW: room.incidentBox.w });
    expect(tooWide.mark?.form).toBe('short');
    expect(tooWide.mark?.word).toBeNull();
    const compact = plaqueLayout({ ...base, compact: true, open: true, wordW: 1 });
    expect(compact.mark?.form).toBe('short');
    expect(compact.mark!.tri.x).toBeLessThan(room.labelAt.x - 40);
    expect(compact.mark!.tri.y).toBe(room.labelAt.y);
    // Whatever the form, the plate covers the name and the mark.
    for (const p of [long, tooWide, compact]) {
      expect(p.plate.x).toBeLessThanOrEqual(room.labelAt.x - 40);
      expect(p.plate.x + p.plate.w).toBeGreaterThanOrEqual(room.labelAt.x + 40);
      expect(p.plate.x).toBeLessThanOrEqual(p.mark!.tri.x);
    }
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

describe('textures', () => {
  it('has at most 6 recipes, each drawn once from code', () => {
    expect(TEXTURE_NAMES.length).toBeGreaterThan(0);
    expect(TEXTURE_NAMES.length).toBeLessThanOrEqual(6);
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
