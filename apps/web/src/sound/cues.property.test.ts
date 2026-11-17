import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { SERVICE_NAMES, type ProposalSummary, type ServiceState } from '@haunted-ops/shared';
import { makeService } from '../test/arbs.js';
import { runningHunt, sealedHunt } from '../test/hunt-arbs.js';
import { CUE_GAP_MS, ROOM_GAP_MS, STEP_GAP_MS, createCueGate, nextCue, type CueName } from './cues.js';

const proposal = (status: ProposalSummary['status']): ProposalSummary => ({
  id: 'cmproposalaaaaaaaaaaaaaa1',
  huntId: 'cmhuntaaaaaaaaaaaaaaaaaa1',
  attempt: 1,
  kind: 'ai_patch',
  status,
  prNumber: null,
  prUrl: null,
  mergedBy: null,
  checks: [],
  failReason: null,
  aiFailReason: null,
  updatedAt: '2026-11-14T10:00:00.000Z',
});

const serviceArb = (name: (typeof SERVICE_NAMES)[number]): fc.Arbitrary<ServiceState> =>
  fc
    .record({
      level: fc.constantFrom(0, 1, 2, 3, 4 as const),
      up: fc.constantFrom(null, 0, 1),
      hunt: fc.constantFrom('none', 'r0', 'r1', 'r2', 'r3', 'r4', 'sealed'),
      fix: fc.constantFrom('none', 'drafting', 'open', 'merged', 'deployed'),
    })
    .map((r) =>
      makeService(name, {
        hauntLevel: r.level as 0 | 1 | 2 | 3 | 4,
        metrics: r.up === null ? null : { errorRate: 0, p95Ms: 1, up: r.up, at: 'x' },
        hunt: r.hunt === 'none' ? null : r.hunt === 'sealed' ? sealedHunt() : runningHunt(Number(r.hunt.slice(1))),
        proposal: r.fix === 'none' ? null : proposal(r.fix as ProposalSummary['status']),
      }),
    );

const snapshotArb: fc.Arbitrary<ServiceState[]> = fc.tuple(...SERVICE_NAMES.map(serviceArb));
/** Time steps in ms, from 0 (the same instant) to 9 s. */
const gapArb = fc.integer({ min: 0, max: 9000 });

// Feature: visual-refresh, Property 13
describe('Property 13: the cues obey the three rate limits and the first snapshot makes none', () => {
  it('holds for any sequence of snapshots and times', () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(snapshotArb, gapArb), { minLength: 1, maxLength: 40 }), fc.integer({ min: 0, max: 1_000_000 }), (steps, start) => {
        let gate = createCueGate();
        let now = start;
        const played: Array<{ cue: CueName; room: string; t: number }> = [];
        steps.forEach(([services, gap], i) => {
          now += gap;
          const out = nextCue(gate, services, now);
          gate = out.gate;
          // The first snapshot is only the state to compare with.
          if (i === 0) expect(out.play).toBeNull();
          if (out.play !== null) played.push({ cue: out.play.cue, room: out.play.room, t: now });
        });
        // At most one cue in 700 ms.
        for (let i = 1; i < played.length; i++) expect(played[i]!.t - played[i - 1]!.t).toBeGreaterThanOrEqual(CUE_GAP_MS);
        // hunt-step at most once in 3 s.
        const stepTimes = played.filter((p) => p.cue === 'hunt-step').map((p) => p.t);
        for (let i = 1; i < stepTimes.length; i++) expect(stepTimes[i]! - stepTimes[i - 1]!).toBeGreaterThanOrEqual(STEP_GAP_MS);
        // The same cue for the same room at most once in 5 s.
        const last = new Map<string, number>();
        for (const p of played) {
          const key = `${p.cue}:${p.room}`;
          const before = last.get(key);
          if (before !== undefined) expect(p.t - before).toBeGreaterThanOrEqual(ROOM_GAP_MS);
          last.set(key, p.t);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('makes no cue for the same snapshot twice', () => {
    fc.assert(
      fc.property(snapshotArb, fc.integer({ min: 0, max: 100_000 }), (services, now) => {
        const first = nextCue(createCueGate(), services, now);
        expect(first.play).toBeNull();
        expect(nextCue(first.gate, services, now + 10_000).play).toBeNull();
      }),
      { numRuns: 100 },
    );
  });
});
