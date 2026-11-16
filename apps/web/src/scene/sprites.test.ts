import { afterEach, describe, expect, it, vi } from 'vitest';
import { FULL, house, scene } from '../test/scene-fakes.js';
import { GHOST_KIND_MAX, GHOST_MAX, ghostKind } from './particles.js';

const assets = vi.hoisted(() => ({ load: vi.fn(), unload: vi.fn() }));
vi.mock('pixi.js', () => ({ Assets: assets }));
const { LOAD_TIMEOUT_MS, ROOM_BOX, ROOM_SPRITE, ROOM_SPRITE_SCALE, SPRITE_KEYS, SPRITE_MANIFEST, loadSprites, roomSpriteFit, spriteBrightness, spriteSilhouette } = await import('./sprites.js');

const picture = { width: 256, height: 256 };
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  assets.load.mockReset();
});

describe('roomSpriteFit', () => {
  const layout = scene(house(), FULL).layout;
  it('makes the content box ROOM_SPRITE_SCALE times as wide as the floor and keeps its bottom centre on the front corner', () => {
    expect(ROOM_SPRITE_SCALE).toBeLessThanOrEqual(0.9);
    expect(layout.rooms.length).toBeGreaterThan(0);
    for (const room of layout.rooms) {
      const fit = roomSpriteFit(room.floor);
      const [, right, bottom, left] = room.floor;
      const boxW = (ROOM_BOX.x1 - ROOM_BOX.x0) * fit.width;
      expect(boxW).toBeCloseTo(ROOM_SPRITE_SCALE * (right.x - left.x), 6);
      expect(fit.x + ((ROOM_BOX.x0 + ROOM_BOX.x1) / 2) * fit.width).toBeCloseTo(bottom.x, 6);
      expect(fit.y + ROOM_BOX.y1 * fit.height).toBeCloseTo(bottom.y, 6);
      expect(fit.width).toBe(fit.height);
    }
  });
  it('draws the outline of the picture inside the floor width, centred on the front corner', () => {
    const room = layout.rooms[0]!;
    const hex = spriteSilhouette(roomSpriteFit(room.floor));
    const [, right, bottom, left] = room.floor;
    expect(hex).toHaveLength(6);
    expect(hex[4]!.x - hex[0]!.x).toBeCloseTo(ROOM_SPRITE_SCALE * (right.x - left.x), 6);
    expect((hex[0]!.x + hex[4]!.x) / 2).toBeCloseTo(bottom.x, 6);
    expect(hex[5]!.x).toBeCloseTo(bottom.x, 6);
    expect(hex[5]!.y).toBeCloseTo(room.floor[2].y, 6);
  });
  it('keeps the picture of a front room off the front corner of the floor of every room behind it (demo layout, three widths)', () => {
    for (const width of [1440, 390, 1000]) {
      const { layout: l } = scene(house(), FULL, { width, height: 800, dpr: 1 });
      expect(l.rooms).toHaveLength(4);
      for (const front of l.rooms) {
        const fit = roomSpriteFit(front.floor);
        const bottom = front.floor[2];
        const half = ((ROOM_BOX.x1 - ROOM_BOX.x0) / 2) * fit.width;
        const top = bottom.y - (ROOM_BOX.y1 - ROOM_BOX.y0) * fit.height;
        for (const back of l.rooms) {
          if (back.grid.x + back.grid.y >= front.grid.x + front.grid.y) continue;
          const corner = back.floor[2];
          const inside = corner.x >= bottom.x - half && corner.x <= bottom.x + half && corner.y >= top && corner.y <= bottom.y;
          expect(inside, `${front.name} over ${back.name} at ${width}`).toBe(false);
        }
      }
    }
  });
});

describe('the manifest', () => {
  it('lists ten files under /scene/ and a room file for the four services only', () => {
    expect(SPRITE_KEYS).toHaveLength(10);
    for (const key of SPRITE_KEYS) expect(SPRITE_MANIFEST[key]).toMatch(/^\/scene\/[a-z-]+\.webp$/);
    expect(Object.keys(ROOM_SPRITE).sort()).toEqual(['gate', 'ledger', 'orders', 'payments']);
  });
});

describe('loadSprites', () => {
  it('returns the set when every file decodes, asking for each manifest path once', async () => {
    assets.load.mockResolvedValue(picture);
    const set = await loadSprites();
    expect(set).not.toBeNull();
    expect(assets.load.mock.calls.map((c) => c[0]).sort()).toEqual(Object.values(SPRITE_MANIFEST).sort());
    expect(Object.keys(set!.rooms).sort()).toEqual(['gate', 'ledger', 'orders', 'payments']);
    expect(set!.ghosts).toHaveLength(3);
  });
  it('returns null when a file rejects', async () => {
    assets.load.mockImplementation(async (path: string) => {
      if (path.includes('fog')) throw new Error('404');
      return picture;
    });
    expect(await loadSprites()).toBeNull();
  });
  it('returns null on the timeout', async () => {
    vi.useFakeTimers();
    assets.load.mockImplementation(() => new Promise(() => undefined));
    const pending = loadSprites();
    await vi.advanceTimersByTimeAsync(LOAD_TIMEOUT_MS + 1);
    expect(await pending).toBeNull();
  });
  it('returns null when an answer is not a picture (the server answers a missing file with the page)', async () => {
    for (const bad of ['<!doctype html>', null, undefined, { width: 0, height: 0 }, {}]) {
      assets.load.mockResolvedValue(bad);
      expect(await loadSprites()).toBeNull();
    }
  });
});

describe('spriteBrightness', () => {
  it('is dim for a lantern-only room (0.40 at most), 0.80 or more for haunted, full for a possessed one and near black for a dark one', () => {
    expect(spriteBrightness(0.25, 0)).toBeLessThanOrEqual(0.4);
    expect(spriteBrightness(0.7, 0)).toBeGreaterThanOrEqual(0.8);
    expect(spriteBrightness(0.4, 0)).toBeGreaterThan(spriteBrightness(0.25, 0));
    expect(spriteBrightness(0.4, 0)).toBeLessThan(spriteBrightness(0.7, 0));
    expect(spriteBrightness(1, 0)).toBe(1);
    expect(spriteBrightness(0, 0.92)).toBeLessThan(0.05);
  });
});

describe('the ghost variants', () => {
  it('share the slots of a room: never more than GHOST_MAX in all, never more than a pool holds', () => {
    for (let level = 0; level <= 4; level++) {
      for (let n = 0; n <= GHOST_MAX; n++) {
        const counts = [0, 0, 0];
        for (let i = 0; i < n; i++) counts[ghostKind(level, i)]! += 1;
        expect(counts.reduce((a, b) => a + b, 0)).toBe(n);
        counts.forEach((c, k) => expect(c).toBeLessThanOrEqual(GHOST_KIND_MAX[k]!));
      }
    }
  });
  it('uses calm and drift below possessed and mostly angry from possessed', () => {
    for (let i = 0; i < GHOST_MAX; i++) {
      expect(ghostKind(1, i)).toBeLessThan(2);
      expect(ghostKind(2, i)).toBeLessThan(2);
      expect(ghostKind(3, i) === 2 || i % 4 === 3).toBe(true);
    }
  });
});
