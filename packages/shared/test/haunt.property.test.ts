import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  ERROR_RATE_THRESHOLDS,
  LOWER_AFTER_POLLS,
  P95_MS_THRESHOLDS,
  RAISE_AFTER_POLLS,
  UP_DOWN_BELOW,
  initialHauntState,
  scoreSample,
  stepHaunt,
  type HauntLevel,
  type HauntState,
  type Sample,
} from '../src/index.js';
import { hauntLevelArb, sampleArb, sampleForLevel } from './arbitraries.js';

const RUNS = { numRuns: 200 };

const nonNegative = fc.double({ min: 0, max: 10_000, noNaN: true });
const anyNumber = fc.oneof(
  fc.double(),
  fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 0, 0.05, 0.2, 0.5, 500, 1000, 3000),
);
const anySample: fc.Arbitrary<Sample> = fc.record({
  errorRate: fc.option(anyNumber, { nil: null }),
  p95Ms: fc.option(anyNumber, { nil: null }),
  up: fc.option(anyNumber, { nil: null }),
});

/** Sample B no better than A: higher error ratio and p95, lower up, null is the best value. */
const worsePair: fc.Arbitrary<[Sample, Sample]> = fc
  .tuple(
    sampleArb,
    fc.record({ e: nonNegative, p: nonNegative, u: nonNegative }),
    fc.record({ e: fc.boolean(), p: fc.boolean(), u: fc.boolean() }),
  )
  .map(([a, d, keep]) => {
    const worse = (v: number | null, delta: number, sign: 1 | -1, keepSame: boolean, fallback: number): number | null =>
      v === null ? (keepSame ? null : fallback + sign * delta) : v + sign * delta * (keepSame ? 0 : 1);
    const b: Sample = {
      errorRate: worse(a.errorRate, d.e / 1000, 1, keep.e, 0.3),
      p95Ms: worse(a.p95Ms, d.p, 1, keep.p, 800),
      up: worse(a.up, d.u / 10_000, -1, keep.u, 0.6),
    };
    return [a, b];
  });

// Feature: ingest-haunt-score, Property 1
describe('Property 1: the score is monotonic', () => {
  it('a Sample that is no better never gets a lower level', () => {
    fc.assert(
      fc.property(worsePair, ([a, b]) => {
        expect(scoreSample(b).level).toBeGreaterThanOrEqual(scoreSample(a).level);
      }),
      RUNS,
    );
  });
});

const levelOf = (value: number, thresholds: readonly number[]): number => thresholds.filter((t) => value >= t).length;

// Feature: ingest-haunt-score, Property 2
describe('Property 2: the score is total and its reason explains the level', () => {
  it('returns a level 0..4, reason null iff level 0, and a reason that names the deciding signal', () => {
    fc.assert(
      fc.property(anySample, (s) => {
        const r = scoreSample(s);
        expect([0, 1, 2, 3, 4]).toContain(r.level);
        expect(r.level === 0).toBe(r.reason === null);
        if (r.reason === null) return;
        expect(Number.isFinite(r.reason.value)).toBe(true);
        if (r.reason.kind === 'down') {
          expect(r.level).toBe(4);
          expect(r.reason.value).toBeLessThan(UP_DOWN_BELOW);
          expect(r.reason.value).toBe(s.up);
        } else if (r.reason.kind === 'error_rate') {
          expect(r.reason.value).toBe(Math.max(0, s.errorRate as number));
          expect(levelOf(r.reason.value, ERROR_RATE_THRESHOLDS)).toBe(r.level);
        } else {
          expect(r.reason.value).toBe(Math.max(0, s.p95Ms as number));
          expect(levelOf(r.reason.value, P95_MS_THRESHOLDS)).toBe(r.level);
        }
      }),
      RUNS,
    );
  });
});

const rawSeq = fc.array(hauntLevelArb, { minLength: 1, maxLength: 40 });
const runSteps = (start: HauntState, levels: readonly HauntLevel[]): HauntState[] => {
  const out: HauntState[] = [];
  let state = start;
  for (const l of levels) {
    state = stepHaunt(state, sampleForLevel(l));
    out.push(state);
  }
  return out;
};

// Feature: ingest-haunt-score, Property 3
describe('Property 3: a single poll never changes the level', () => {
  it('from a state with no pending streak, one Sample keeps the level', () => {
    fc.assert(
      fc.property(hauntLevelArb, anySample, (level, s) => {
        expect(stepHaunt(initialHauntState(level, null), s).level).toBe(level);
      }),
      RUNS,
    );
  });

  it('a level change always follows a full pending streak in its direction', () => {
    fc.assert(
      fc.property(hauntLevelArb, rawSeq, (start, levels) => {
        let prev = initialHauntState(start, null);
        for (const l of levels) {
          const next = stepHaunt(prev, sampleForLevel(l));
          if (next.level > prev.level) expect((prev.higher?.count ?? 0) + 1).toBeGreaterThanOrEqual(RAISE_AFTER_POLLS);
          if (next.level < prev.level) expect((prev.lower?.count ?? 0) + 1).toBeGreaterThanOrEqual(LOWER_AFTER_POLLS);
          prev = next;
        }
      }),
      RUNS,
    );
  });
});

// Feature: ingest-haunt-score, Property 4
describe('Property 4: hysteresis never flickers and takes exactly 2 or 3 polls', () => {
  it('(a) alternating worse and better polls never change the level', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 3 }),
        fc.array(fc.tuple(fc.nat(), fc.nat()), { minLength: 1, maxLength: 20 }),
        fc.boolean(),
        (level, picks, worseFirst) => {
          const lv = level as HauntLevel;
          const worse = (n: number): HauntLevel => (lv + 1 + (n % (4 - lv))) as HauntLevel;
          const better = (n: number): HauntLevel => (n % lv) as HauntLevel;
          const seq: HauntLevel[] = [];
          picks.forEach(([x, y], i) => {
            const first = (i % 2 === 0) === worseFirst;
            seq.push(first ? worse(x) : better(y));
          });
          const states = runSteps(initialHauntState(lv, null), seq);
          for (const s of states) expect(s.level).toBe(lv);
        },
      ),
      RUNS,
    );
  });

  it('(b) 2 higher polls raise the level at the 2nd, to the lowest of the two', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 3 }), fc.nat(), fc.nat(), (level, x, y) => {
        const lv = level as HauntLevel;
        const a = (lv + 1 + (x % (4 - lv))) as HauntLevel;
        const b = (lv + 1 + (y % (4 - lv))) as HauntLevel;
        const [s1, s2] = runSteps(initialHauntState(lv, null), [a, b]);
        expect(s1?.level).toBe(lv);
        expect(s2?.level).toBe(Math.min(a, b));
      }),
      RUNS,
    );
  });

  it('(c) 3 lower polls lower the level at the 3rd, to the highest of the three', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 4 }), fc.tuple(fc.nat(), fc.nat(), fc.nat()), (level, [x, y, z]) => {
        const lv = level as HauntLevel;
        const pick = (n: number): HauntLevel => (n % lv) as HauntLevel;
        const picks = [pick(x), pick(y), pick(z)];
        const [s1, s2, s3] = runSteps(initialHauntState(lv, null), picks);
        expect(s1?.level).toBe(lv);
        expect(s2?.level).toBe(lv);
        expect(s3?.level).toBe(Math.max(...picks));
      }),
      RUNS,
    );
  });

  it('(d) a No-data sample anywhere changes nothing', () => {
    fc.assert(
      fc.property(hauntLevelArb, rawSeq, fc.nat(), (start, levels, at) => {
        const noData: Sample = { errorRate: null, p95Ms: null, up: null };
        const cut = at % (levels.length + 1);
        const plain = levels.map(sampleForLevel);
        const withGap = [...plain.slice(0, cut), noData, ...plain.slice(cut)];
        const a = plain.reduce(stepHaunt, initialHauntState(start, null));
        const b = withGap.reduce(stepHaunt, initialHauntState(start, null));
        expect(b).toEqual(a);
      }),
      RUNS,
    );
  });

  it('(e) the level stays from 0 to 4 for any samples', () => {
    fc.assert(
      fc.property(hauntLevelArb, fc.array(anySample, { maxLength: 40 }), (start, samples) => {
        let state = initialHauntState(start, null);
        for (const s of samples) {
          state = stepHaunt(state, s);
          expect([0, 1, 2, 3, 4]).toContain(state.level);
        }
      }),
      RUNS,
    );
  });
});
