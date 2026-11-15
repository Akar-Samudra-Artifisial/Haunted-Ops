import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { makeService } from '../test/arbs.js';
import { levelArb } from '../test/arbs.js';
import { DRAFT_GLOW_MS, FLICKER_CELL_MS, PULSE_GAP_MS, createAnimator } from './animator.js';
import { scene } from '../test/scene-fakes.js';

const PER_SECOND = (ms: number): number => 1000 / ms;

describe('flashing outside Accessible mode', () => {
  it('keeps every rate of the animator constants at or below 3 per second', () => {
    expect(PER_SECOND(PULSE_GAP_MS)).toBeLessThanOrEqual(3);
    expect(PER_SECOND(FLICKER_CELL_MS)).toBeLessThanOrEqual(3);
    expect(PER_SECOND(DRAFT_GLOW_MS)).toBeLessThanOrEqual(3);
  });
});

describe('no shake and a slow dim at every level', () => {
  it('keeps the room offset 0 and the luminance cue at 3 changes per second or less, in both motion modes', () => {
    fc.assert(
      fc.property(levelArb, fc.boolean(), fc.integer({ min: 0, max: 100_000 }), (level, reduced, start) => {
        const { model, layout } = scene([makeService('payments', { hauntLevel: level })], { reducedMotion: reduced, quality: 'full' });
        const a = createAnimator();
        a.setLayout(layout);
        a.setModel(model);
        let last = Number.NaN;
        let dir = 0;
        let turns = 0;
        for (let t = start; t < start + 5000; t += 16) {
          const room = a.step(16, t).rooms[0]!;
          expect([room.shakeX, room.shakeY]).toEqual([0, 0]);
          const d = Math.sign(room.flicker - last);
          if (d !== 0 && dir !== 0 && d !== dir) turns += 1;
          if (d !== 0) dir = d;
          last = room.flicker;
        }
        expect(turns / 5).toBeLessThanOrEqual(3);
      }),
      { numRuns: 30 },
    );
  });
});
describe('Property 9: the Scene never flashes above 3 per second', () => {
  // Feature: accessible-mode, Property 9
  it('changes the lamp brightness direction at most 3 times per second at every Haunt level', () => {
    fc.assert(
      fc.property(levelArb, fc.integer({ min: 0, max: 100_000 }), (level, start) => {
        const { model, layout } = scene([makeService('payments', { hauntLevel: level })]);
        const a = createAnimator();
        a.setLayout(layout);
        a.setModel(model);
        const values: number[] = [];
        for (let t = start; t < start + 6000; t += 16) values.push(a.step(16, t).rooms[0]!.flicker);
        let turns = 0;
        let dir = 0;
        for (let i = 1; i < values.length; i++) {
          const d = Math.sign(values[i]! - values[i - 1]!);
          if (d !== 0 && dir !== 0 && d !== dir) turns += 1;
          if (d !== 0) dir = d;
        }
        expect(turns / 6).toBeLessThanOrEqual(3);
      }),
      { numRuns: 30 },
    );
  });
});
