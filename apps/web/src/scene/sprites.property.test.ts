import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import { SERVICE_NAMES, type HauntLevel, type ServiceState } from '@haunted-ops/shared';
import { ROOMS, serviceStateArb } from '../test/arbs.js';
import { insideConvex } from '../test/geometry.js';
import { FULL, house, scene } from '../test/scene-fakes.js';
import { DARK_DIM, MAX_ROOMS, createAnimator } from './animator.js';
import { toSceneModel } from './model.js';
import { GHOST_KIND_MAX, GHOST_MAX, PARTICLE_CAP, ghostKind } from './particles.js';

vi.mock('pixi.js', () => ({ Assets: { load: vi.fn(), unload: vi.fn() } }));
const { ROOM_SPRITE, roomSpriteFit, spriteBrightness, spriteFloor, spriteSilhouette } = await import('./sprites.js');

const RUNS = { numRuns: 100 };
const NOW = Date.parse('2026-11-13T15:30:00.000Z');
const LEVELS: HauntLevel[] = [0, 1, 2, 3, 4];
const withSprite = Object.keys(ROOM_SPRITE) as Array<(typeof SERVICE_NAMES)[number]>;

// Feature: visual-refresh, Property 9
describe('Property 9: the picture of a room is brighter as the trouble grows, and darkest when dark', () => {
  it('is non-decreasing from calm to possessed and the dark room is the darkest, for any service with a sprite', () => {
    fc.assert(
      fc.property(serviceStateArb, fc.constantFrom(...withSprite), (s: ServiceState, name) => {
        const rooms = LEVELS.map((hauntLevel) => toSceneModel([{ ...s, name, room: ROOMS[name], hauntLevel, metrics: s.metrics === null ? null : { ...s.metrics, up: 1 } }], NOW, FULL).rooms[0]!);
        const b = rooms.map((r) => spriteBrightness(r.light, r.dark ? DARK_DIM : 0));
        for (let i = 1; i <= 3; i++) expect(b[i]!).toBeGreaterThanOrEqual(b[i - 1]!);
        expect(b[3]!).toBeGreaterThan(b[0]!);
        expect(rooms[4]!.dark).toBe(true);
        for (let i = 0; i <= 3; i++) expect(b[4]!).toBeLessThan(b[i]!);
        expect(b[4]!).toBeLessThan(0.05);
        // The part 5 bounds: calm 0.40 at most, uneasy between calm and haunted, haunted 0.80 at least, possessed 1.
        expect(b[0]!).toBeLessThanOrEqual(0.4);
        expect(b[1]!).toBeGreaterThanOrEqual(b[0]!);
        expect(b[1]!).toBeLessThanOrEqual(b[2]!);
        expect(b[2]!).toBeGreaterThanOrEqual(0.8);
        expect(b[3]!).toBe(1);
      }),
      RUNS,
    );
  });
});

// Feature: visual-refresh, Property 10
describe('Property 10: the ghost pools never pass the caps', () => {
  it('holds for any set of rooms and levels: per room, per pool and in all', () => {
    fc.assert(
      fc.property(fc.array(serviceStateArb, { minLength: 4, maxLength: 4 }), (states) => {
        const services = states.map((s, i) => ({ ...s, name: SERVICE_NAMES[i]!, room: ROOMS[SERVICE_NAMES[i]!] }));
        const s = scene(services, FULL);
        const a = createAnimator();
        a.setLayout(s.layout);
        a.setModel(s.model);
        let frame = a.step(16, 16);
        for (let t = 2; t < 300; t++) frame = a.step(16, t * 16);
        const counts = [0, 0, 0];
        for (let i = 0; i < frame.ghosts.count; i++) counts[frame.ghosts.kind[i]!]! += 1;
        counts.forEach((c, k) => expect(c).toBeLessThanOrEqual(MAX_ROOMS * GHOST_KIND_MAX[k]!));
        expect(counts.reduce((n, c) => n + c, 0)).toBe(frame.ghosts.count);
        expect(frame.ghosts.count).toBeLessThanOrEqual(services.length * GHOST_MAX);
        expect(frame.ghosts.count).toBeLessThanOrEqual(PARTICLE_CAP);
      }),
      { numRuns: 20 },
    );
  });
  it('shares the 12 slots of a room between the variants at every level, never adding to them', () => {
    for (const level of LEVELS) {
      const per = [0, 0, 0];
      for (let i = 0; i < GHOST_MAX; i++) per[ghostKind(level, i)]! += 1;
      per.forEach((c, k) => expect(c).toBeLessThanOrEqual(GHOST_KIND_MAX[k]!));
      expect(per.reduce((n, c) => n + c, 0)).toBe(GHOST_MAX);
    }
  });
});

// Feature: visual-refresh, Property 12
describe('Property 12: the trouble tint of a sprite room stays inside its outline', () => {
  it('puts every point of the tint polygon inside the sprite silhouette, for any viewport', () => {
    fc.assert(
      fc.property(fc.integer({ min: 200, max: 2400 }), fc.integer({ min: 300, max: 1600 }), (width, height) => {
        const { layout } = scene(house(), FULL, { width, height, dpr: 1 });
        for (const room of layout.rooms) {
          const fit = roomSpriteFit(room.floor);
          const hex = spriteSilhouette(fit);
          for (const p of spriteFloor(fit)) expect(insideConvex(hex, p)).toBeGreaterThanOrEqual(-1e-6);
        }
      }),
      RUNS,
    );
  });
});
