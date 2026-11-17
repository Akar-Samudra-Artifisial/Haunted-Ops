import fc from 'fast-check';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FULL, house, scene } from '../test/scene-fakes.js';
import type { Pt } from './layout.js';
import { roomOutline, roomSpriteFit, spriteSilhouette } from './outline.js';
import { RING_DASH_PX, RING_GAP_PX, dashPaths, ringShape } from './ring.js';
import { RoomButtons } from './RoomButtons.js';

afterEach(cleanup);

const bounds = (pts: readonly Pt[]) => ({
  x0: Math.min(...pts.map((p) => p.x)),
  y0: Math.min(...pts.map((p) => p.y)),
  x1: Math.max(...pts.map((p) => p.x)),
  y1: Math.max(...pts.map((p) => p.y)),
});

/** The polygon of a room button in page px: its position plus its clip-path. */
function hitPolygon(button: HTMLElement): Pt[] {
  const left = parseFloat(button.style.left);
  const top = parseFloat(button.style.top);
  const inner = /^polygon\((.*)\)$/.exec(button.style.clipPath)?.[1] ?? '';
  return inner.split(',').map((pair) => {
    const [x, y] = pair.trim().split(/\s+/).map((v) => parseFloat(v));
    return { x: left + (x as number), y: top + (y as number) };
  });
}

describe('roomOutline: one outline for the ring, the room outline and the room buttons', () => {
  it('is the sprite outline with the pictures and the procedural silhouette without them', () => {
    const { layout } = scene(house(), FULL, { width: 1440, height: 900, dpr: 1 });
    for (const room of layout.rooms) {
      expect(roomOutline(room, true)).toEqual(spriteSilhouette(roomSpriteFit(room.floor)));
      expect(roomOutline(room, false)).toBe(room.silhouette);
    }
  });

  for (const sprites of [true, false]) {
    it(`gives every room button the same polygon as the ring (${sprites ? 'sprites' : 'fallback'}), to 0.1 px`, () => {
      const { layout, model } = scene(house(), FULL, { width: 1440, height: 900, dpr: 1 });
      const view = render(<RoomButtons layout={layout} model={model} selected="gate" onSelect={() => undefined} outline={(room) => roomOutline(room, sprites)} />);
      const buttons = [...view.container.querySelectorAll<HTMLButtonElement>('.room-button')];
      expect(buttons).toHaveLength(layout.rooms.length);
      layout.rooms.forEach((room, i) => {
        const hit = hitPolygon(buttons[i] as HTMLElement);
        const ring = ringShape(roomOutline(room, sprites), true).paths[0] as Pt[];
        expect(hit).toHaveLength(ring.length);
        hit.forEach((p, k) => {
          expect(Math.abs(p.x - (ring[k] as Pt).x)).toBeLessThan(0.11);
          expect(Math.abs(p.y - (ring[k] as Pt).y)).toBeLessThan(0.11);
        });
      });
    });
  }

  it('marks the group for the scene ring only while the scene draws, and reports keyboard focus (not mouse focus)', () => {
    const { layout, model } = scene(house(), FULL);
    const onFocusVisible = vi.fn();
    const before = render(<RoomButtons layout={layout} model={model} selected={null} onSelect={() => undefined} />);
    expect(before.container.querySelector('.room-buttons')?.getAttribute('data-ring')).toBeNull();
    // Without the scene the button is shaped by the procedural silhouette.
    const plain = hitPolygon(before.container.querySelector('.room-button') as HTMLElement);
    plain.forEach((p, k) => expect(Math.abs(p.x - (layout.rooms[0]!.silhouette[k] as Pt).x)).toBeLessThan(0.11));
    cleanup();
    const view = render(<RoomButtons layout={layout} model={model} selected={null} onSelect={() => undefined} outline={(room) => roomOutline(room, false)} onFocusVisible={onFocusVisible} />);
    expect(view.container.querySelector('.room-buttons')?.getAttribute('data-ring')).toBe('scene');
    const button = view.container.querySelector<HTMLButtonElement>('.room-button') as HTMLButtonElement;
    const matches = vi.spyOn(button, 'matches').mockReturnValue(true);
    fireEvent.focus(button);
    expect(onFocusVisible).toHaveBeenLastCalledWith(layout.rooms[0]?.name);
    fireEvent.blur(button);
    expect(onFocusVisible).toHaveBeenLastCalledWith(null);
    matches.mockReturnValue(false);
    onFocusVisible.mockClear();
    fireEvent.focus(button);
    expect(onFocusVisible).not.toHaveBeenCalled();
  });
});

describe('dashPaths', () => {
  it('cuts a square into dashes of the given length (shorter at the end of an edge) that lie on its edges and start at every corner', () => {
    const square: Pt[] = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ];
    const paths = dashPaths(square, RING_DASH_PX, RING_GAP_PX);
    // 100 px per edge at a period of 16 px: 7 dashes per edge (six of 10 px and one of 4 px), 28 in all.
    expect(paths).toHaveLength(28);
    for (const [k, path] of paths.entries()) {
      let len = 0;
      for (let i = 1; i < path.length; i++) len += Math.hypot((path[i] as Pt).x - (path[i - 1] as Pt).x, (path[i] as Pt).y - (path[i - 1] as Pt).y);
      expect(len).toBeCloseTo(k % 7 === 6 ? 4 : RING_DASH_PX, 6);
      for (const p of path) expect(p.x === 0 || p.x === 100 || p.y === 0 || p.y === 100).toBe(true);
    }
    for (const corner of square) expect(paths.some((path) => path[0]!.x === corner.x && path[0]!.y === corner.y)).toBe(true);
  });
});

describe('Property 16: the ring bounds equal the outline bounds and hold the chip-free picture of the room', () => {
  // Feature: visual-refresh, Property 16
  it('holds for every room at 390, 768, 1024 and 1440, solid or dashed, with or without the pictures', () => {
    fc.assert(
      fc.property(fc.constantFrom(390, 768, 1024, 1440), fc.integer({ min: 500, max: 1100 }), fc.boolean(), fc.boolean(), (width, height, sprites, selected) => {
        const { layout } = scene(house(), FULL, { width, height, dpr: 1 });
        for (const room of layout.rooms) {
          const outline = roomOutline(room, sprites);
          const ring = bounds(ringShape(outline, selected).paths.flat());
          const box = bounds(outline);
          for (const k of ['x0', 'y0', 'x1', 'y1'] as const) expect(Math.abs(ring[k] - box[k])).toBeLessThanOrEqual(1);
          // The chip-free area of the room picture: the outline of the sprite down to its front corner (the chip hangs below it).
          const area = bounds(sprites ? spriteSilhouette(roomSpriteFit(room.floor)) : room.silhouette);
          expect(ring.x0).toBeLessThanOrEqual(area.x0 + 1);
          expect(ring.y0).toBeLessThanOrEqual(area.y0 + 1);
          expect(ring.x1).toBeGreaterThanOrEqual(area.x1 - 1);
          expect(ring.y1).toBeGreaterThanOrEqual(area.y1 - 1);
        }
      }),
      { numRuns: 60 },
    );
  });
});
