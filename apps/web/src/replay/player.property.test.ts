import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { applyReplayFrame, type ReplayFile, type ReplayState } from '@haunted-ops/shared';
import { syntheticReplay } from './fixture.js';
import { SPEEDS, frameIndexAt, reducePlayer, startPlayer, stateAt, timeline, type PlayerAction, type PlayerState } from './player.js';
const base = syntheticReplay();
/** A file with random frame times (sorted, from 0) over the services, hunts and proposals of the synthetic replay. */
const fileArb: fc.Arbitrary<Pick<ReplayFile, 'frames' | 'durationMs'>> = fc
  .record({
    gaps: fc.array(fc.integer({ min: 0, max: 5000 }), { minLength: 0, maxLength: 30 }),
    pick: fc.array(fc.nat(), { minLength: 31, maxLength: 31 }),
    pad: fc.integer({ min: 0, max: 4000 }),
  })
  .map(({ gaps, pick, pad }) => {
    let t = 0;
    const frames: ReplayFile['frames'] = [{ ...(base.frames[0] as ReplayFile['frames'][number]), t: 0 }];
    gaps.forEach((gap, i) => {
      t += gap;
      const src = base.frames[(pick[i] as number) % base.frames.length] as ReplayFile['frames'][number];
      frames.push({ ...src, t });
    });
    return { frames, durationMs: Math.max(1, t + pad) };
  });
const actionArb: fc.Arbitrary<PlayerAction> = fc.oneof(
  fc.constant<PlayerAction>({ type: 'play' }),
  fc.constant<PlayerAction>({ type: 'pause' }),
  fc.constant<PlayerAction>({ type: 'toggle' }),
  fc.constantFrom(...SPEEDS).map((speed): PlayerAction => ({ type: 'speed', speed })),
  fc.integer({ min: 0, max: 3000 }).map((dtMs): PlayerAction => ({ type: 'tick', dtMs })),
  fc.integer({ min: -2000, max: 40_000 }).map((ms): PlayerAction => ({ type: 'seek', ms })),
  fc.constant<PlayerAction>({ type: 'next' }),
  fc.constant<PlayerAction>({ type: 'prev' }),
);
const fold = (frames: ReplayFile['frames'], position: number): ReplayState => {
  let s: ReplayState = { services: [], hunt: null, proposal: null };
  for (const f of frames) if (f.t <= position) s = applyReplayFrame(s, f);
  return s;
};
describe('the frame player', () => {
  // Feature: replay, Property 4
  it('Property 4: the state at a position is the fold of the frames up to it, and the position always stays in range', () => {
    fc.assert(
      fc.property(fileArb, fc.array(actionArb, { maxLength: 40 }), (file, actions) => {
        const states = timeline(file.frames);
        let s: PlayerState = startPlayer(false);
        for (const a of actions) {
          const next = reducePlayer(file, s, a);
          expect(next.position).toBeGreaterThanOrEqual(0);
          expect(next.position).toBeLessThanOrEqual(file.durationMs);
          expect(Number.isInteger(next.position)).toBe(true);
          expect(stateAt(states, file.frames, next.position)).toEqual(fold(file.frames, next.position));
          s = next;
        }
      }),
      { numRuns: 150 },
    );
  }, 30_000);
  it('stepping next from the start visits the frames in order and stops at the last time', () => {
    fc.assert(
      fc.property(fileArb, (file) => {
        let s = startPlayer(false);
        const visited: number[] = [];
        for (let i = 0; i < file.frames.length + 3; i++) {
          s = reducePlayer(file, s, { type: 'next' });
          visited.push(frameIndexAt(file.frames, s.position));
        }
        expect(s.position).toBe((file.frames[file.frames.length - 1] as { t: number }).t);
        expect(visited).toEqual([...visited].sort((a, b) => a - b));
      }),
      { numRuns: 100 },
    );
  });
  it('previous undoes next when the next frame is later than the current one', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 20 }), (k) => {
        const file = { frames: base.frames, durationMs: base.durationMs };
        const start = { ...startPlayer(false), position: (base.frames[k % base.frames.length] as { t: number }).t };
        const there = reducePlayer(file, start, { type: 'next' });
        if (there.position !== start.position) expect(reducePlayer(file, there, { type: 'prev' }).position).toBe(start.position);
      }),
      { numRuns: 60 },
    );
  });
});
