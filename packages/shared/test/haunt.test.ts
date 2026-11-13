import { describe, expect, it } from 'vitest';
import {
  ERROR_RATE_THRESHOLDS,
  P95_MS_THRESHOLDS,
  UP_DOWN_BELOW,
  hauntChanged,
  initialHauntState,
  isNoData,
  scoreSample,
  stepHaunt,
  type HauntLevel,
  type HauntState,
  type Sample,
} from '../src/index.js';
import { sampleForLevel } from './arbitraries.js';

const calm: Sample = { errorRate: 0, p95Ms: 100, up: 1 };
const sample = (over: Partial<Sample>): Sample => ({ ...calm, ...over });
const noData: Sample = { errorRate: null, p95Ms: null, up: null };

describe('scoreSample thresholds', () => {
  it('names the documented thresholds', () => {
    expect([...ERROR_RATE_THRESHOLDS]).toEqual([0.05, 0.2, 0.5]);
    expect([...P95_MS_THRESHOLDS]).toEqual([500, 1000, 3000]);
    expect(UP_DOWN_BELOW).toBe(0.5);
  });

  it('puts the error ratio on the right side of each threshold', () => {
    const lv = (errorRate: number): number => scoreSample(sample({ errorRate })).level;
    expect([0.049999, 0.05, 0.199999, 0.2, 0.499999, 0.5, 1].map(lv)).toEqual([0, 1, 1, 2, 2, 3, 3]);
  });

  it('puts the p95 on the right side of each threshold', () => {
    const lv = (p95Ms: number): number => scoreSample(sample({ p95Ms })).level;
    expect([499, 500, 999, 1000, 2999, 3000, 60000].map(lv)).toEqual([0, 1, 1, 2, 2, 3, 3]);
  });

  it('treats up below 0.5 as dark and exactly 0.5 as not down', () => {
    expect(scoreSample(sample({ up: 0.5 })).level).toBe(0);
    expect(scoreSample(sample({ up: 0.4999 })).level).toBe(4);
    expect(scoreSample(sample({ up: 0 })).reason).toEqual({ kind: 'down', value: 0 });
  });

  it('scores the lab values', () => {
    expect(scoreSample(sample({ errorRate: 0.22 }))).toEqual({ level: 2, reason: { kind: 'error_rate', value: 0.22 } });
    expect(scoreSample(sample({ p95Ms: 2200 }))).toEqual({ level: 2, reason: { kind: 'p95', value: 2200 } });
    expect(scoreSample({ errorRate: null, p95Ms: null, up: 0 })).toEqual({ level: 4, reason: { kind: 'down', value: 0 } });
  });

  it('prefers down, then error_rate, then p95 at the same level', () => {
    expect(scoreSample({ errorRate: 0.25, p95Ms: 1500, up: 1 }).reason?.kind).toBe('error_rate');
    expect(scoreSample({ errorRate: 0.1, p95Ms: 600, up: 1 }).reason?.kind).toBe('error_rate');
    expect(scoreSample({ errorRate: 0.01, p95Ms: 3500, up: 1 }).reason?.kind).toBe('p95');
    expect(scoreSample({ errorRate: 0.9, p95Ms: 9000, up: 0 }).reason?.kind).toBe('down');
  });

  it('is calm for null, non-finite and negative input', () => {
    expect(scoreSample(noData)).toEqual({ level: 0, reason: null });
    expect(scoreSample({ errorRate: Number.NaN, p95Ms: Number.POSITIVE_INFINITY, up: Number.NaN }).level).toBe(0);
    expect(scoreSample({ errorRate: -1, p95Ms: -5, up: 1 })).toEqual({ level: 0, reason: null });
  });
});

describe('stepHaunt', () => {
  const run = (start: HauntState, samples: Sample[]): HauntState => samples.reduce(stepHaunt, start);
  const at = (level: HauntLevel): HauntState => initialHauntState(level, null);

  it('raises after 2 higher polls, to the lowest of them', () => {
    const one = run(at(0), [sampleForLevel(3)]);
    expect(one.level).toBe(0);
    const two = run(at(0), [sampleForLevel(3), sampleForLevel(2)]);
    expect(two.level).toBe(2);
    expect(two.reason?.kind).toBe('error_rate');
  });

  it('lowers after 3 lower polls, to the highest of them', () => {
    expect(run(at(4), [sampleForLevel(0), sampleForLevel(0)]).level).toBe(4);
    expect(run(at(4), [sampleForLevel(1), sampleForLevel(0), sampleForLevel(2)]).level).toBe(2);
  });

  it('resets on an equal poll and on a change of direction', () => {
    expect(run(at(2), [sampleForLevel(3), sampleForLevel(2), sampleForLevel(3)]).level).toBe(2);
    expect(run(at(2), [sampleForLevel(3), sampleForLevel(0), sampleForLevel(3)]).level).toBe(2);
    expect(run(at(2), [sampleForLevel(0), sampleForLevel(0), sampleForLevel(2), sampleForLevel(0)]).level).toBe(2);
  });

  it('does not flicker on alternating polls', () => {
    const alt = Array.from({ length: 20 }, (_, i) => sampleForLevel(i % 2 === 0 ? 3 : 0));
    expect(run(at(2), alt).level).toBe(2);
  });

  it('takes the reason from the sample that set the new level, the later one on a tie', () => {
    const a = sample({ errorRate: 0.25 });
    const b = sample({ p95Ms: 1500 });
    expect(run(at(0), [a, b]).reason?.kind).toBe('p95');
    const c = sample({ errorRate: 0.6 });
    expect(run(at(0), [c, a]).reason?.kind).toBe('error_rate');
    expect(run(at(0), [c, b]).reason?.kind).toBe('p95');
  });

  it('refreshes the reason at an equal level and clears it at level 0', () => {
    const s = run(at(2), [sample({ errorRate: 0.25 })]);
    expect(s.reason).toEqual({ kind: 'error_rate', value: 0.25 });
    const t = stepHaunt(s, sample({ p95Ms: 1500 }));
    expect(t.reason?.kind).toBe('p95');
    expect(hauntChanged(s, t)).toBe(true);
    expect(stepHaunt(at(0), calm).reason).toBeNull();
  });

  it('leaves the state alone for a No-data sample, streaks included', () => {
    const mid = stepHaunt(at(0), sampleForLevel(3));
    expect(isNoData(noData)).toBe(true);
    expect(stepHaunt(mid, noData)).toBe(mid);
    expect(stepHaunt(mid, sampleForLevel(2)).level).toBe(2);
  });

  it('reports a change only for the level or the reason kind', () => {
    const a = initialHauntState(2, { kind: 'error_rate', value: 0.25 });
    expect(hauntChanged(a, initialHauntState(2, { kind: 'error_rate', value: 0.3 }))).toBe(false);
    expect(hauntChanged(a, initialHauntState(3, { kind: 'error_rate', value: 0.25 }))).toBe(true);
    expect(hauntChanged(a, initialHauntState(2, { kind: 'p95', value: 1500 }))).toBe(true);
    expect(hauntChanged(a, initialHauntState(2, null))).toBe(true);
  });
});
