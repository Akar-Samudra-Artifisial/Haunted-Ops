import { describe, expect, it } from 'vitest';
import type { ReplayFile } from '@haunted-ops/shared';
import { syntheticReplay } from './fixture.js';
import { bannerText, frameIndexAt, positionText, reducePlayer, sceneClock, spoken, startPlayer, stateAt, timeline, type PlayerAction } from './player.js';
const file = syntheticReplay();
const frames = file.frames;
const last = frames.length - 1;
const t = (i: number): number => (frames[i] as { t: number }).t;
const run = (actions: PlayerAction[], start = startPlayer(false)) => actions.reduce((s, a) => reducePlayer(file, s, a), start);
describe('frameIndexAt', () => {
  it('finds the last frame at or before the position', () => {
    expect(frameIndexAt(frames, 0)).toBe(0);
    expect(frameIndexAt(frames, t(1) - 1)).toBe(0);
    expect(frameIndexAt(frames, t(1))).toBe(1);
    expect(frameIndexAt(frames, file.durationMs)).toBe(last);
  });
});
describe('timeline and stateAt', () => {
  it('is the fold of the frames: a part a frame does not name stays', () => {
    const states = timeline(frames);
    expect(states).toHaveLength(frames.length);
    expect(states[0]?.services).toHaveLength(4);
    const i = frames.findIndex((f, k) => k > 0 && f.hunt === undefined && f.services !== undefined);
    expect(states[i]?.hunt).toBe(states[i - 1]?.hunt);
    expect(stateAt(states, frames, 0)).toBe(states[0]);
    expect(stateAt(states, frames, file.durationMs)).toBe(states[last]);
  });
  it('a part set to null replaces the part', () => {
    const withProposal = frames.find((x) => x.proposal)?.proposal ?? null;
    const f: ReplayFile['frames'] = [{ t: 0, services: frames[0]?.services ?? [], hunt: null, proposal: null }, { t: 1000, proposal: withProposal }, { t: 2000, proposal: null }];
    const states = timeline(f);
    expect(states[1]?.proposal).not.toBeNull();
    expect(states[2]?.proposal).toBeNull();
  });
});
describe('reducePlayer', () => {
  it('starts at 0, paused or playing', () => {
    expect(startPlayer(false)).toEqual({ position: 0, playing: false, speed: 1 });
    expect(startPlayer(true).playing).toBe(true);
  });
  it('plays, pauses and toggles', () => {
    expect(run([{ type: 'play' }]).playing).toBe(true);
    expect(run([{ type: 'play' }, { type: 'pause' }]).playing).toBe(false);
    expect(run([{ type: 'toggle' }, { type: 'toggle' }, { type: 'toggle' }]).playing).toBe(true);
  });
  it('moves only while playing, by dt times the speed', () => {
    expect(run([{ type: 'tick', dtMs: 500 }]).position).toBe(0);
    expect(run([{ type: 'play' }, { type: 'tick', dtMs: 500 }]).position).toBe(500);
    expect(run([{ type: 'play' }, { type: 'speed', speed: 4 }, { type: 'tick', dtMs: 500 }]).position).toBe(2000);
    expect(run([{ type: 'speed', speed: 2 }]).speed).toBe(2);
  });
  it('stops at the end, and play at the end starts again from 0', () => {
    const end = run([{ type: 'play' }, { type: 'tick', dtMs: file.durationMs * 2 }]);
    expect(end).toEqual({ position: file.durationMs, playing: false, speed: 1 });
    expect(reducePlayer(file, end, { type: 'play' })).toEqual({ position: 0, playing: true, speed: 1 });
  });
  it('seeks inside 0 and durationMs', () => {
    expect(run([{ type: 'seek', ms: -5 }]).position).toBe(0);
    expect(run([{ type: 'seek', ms: file.durationMs + 5 }]).position).toBe(file.durationMs);
    expect(run([{ type: 'seek', ms: 12_345.6 }]).position).toBe(12_346);
  });
  it('steps to the next and the previous frame and pauses', () => {
    const one = reducePlayer(file, startPlayer(true), { type: 'next' });
    expect(one).toEqual({ position: t(1), playing: false, speed: 1 });
    expect(reducePlayer(file, one, { type: 'next' }).position).toBe(t(2));
    expect(reducePlayer(file, { ...one, position: t(1) + 400 }, { type: 'prev' }).position).toBe(t(1));
    expect(reducePlayer(file, one, { type: 'prev' }).position).toBe(0);
  });
  it('does nothing at the ends: previous at the start, next at the last frame', () => {
    const start = startPlayer(false);
    expect(reducePlayer(file, start, { type: 'prev' })).toEqual(start);
    const atLast = { ...start, position: t(last) };
    expect(reducePlayer(file, atLast, { type: 'next' })).toEqual(atLast);
    const end = { ...start, position: file.durationMs };
    expect(reducePlayer(file, end, { type: 'next' }).position).toBe(file.durationMs);
    expect(reducePlayer(file, end, { type: 'prev' }).position).toBe(t(last - 1));
  });
});
describe('words', () => {
  it('says a position in minutes and seconds', () => {
    expect(spoken(0)).toBe('0 s');
    expect(spoken(20_000)).toBe('20 s');
    expect(spoken(80_000)).toBe('1 min 20 s');
    expect(spoken(180_000)).toBe('3 min');
    expect(spoken(59_999)).toBe('59 s');
    expect(positionText(80_000, 180_000)).toBe('1 min 20 s of 3 min');
  });
  it('banner and scene clock use the recording date only', () => {
    expect(bannerText('2026-11-15')).toBe('Replay of 2026-11-15, not live');
    expect(sceneClock('2026-11-15', 0)).toBe(Date.parse('2026-11-15T12:00:00.000Z'));
    expect(sceneClock('2026-11-15', 61_900)).toBe(Date.parse('2026-11-15T12:01:01.000Z'));
  });
});
