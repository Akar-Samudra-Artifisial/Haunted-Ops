import { describe, expect, it } from 'vitest';
import type { ProposalSummary, ServiceState } from '@haunted-ops/shared';
import { announcementsFor } from '../components/LiveAnnouncer.js';
import { makeService } from '../test/arbs.js';
import { runningHunt, sealedHunt } from '../test/hunt-arbs.js';
import { CUE_GAP_MS, CUE_PRIORITY, ROOM_GAP_MS, STEP_GAP_MS, createCueGate, nextCue, soundCues, type CueGate } from './cues.js';

const proposal = (over: Partial<ProposalSummary>): ProposalSummary => ({
  id: 'cmproposalaaaaaaaaaaaaaa1',
  huntId: 'cmhuntaaaaaaaaaaaaaaaaaa1',
  attempt: 1,
  kind: 'ai_patch',
  status: 'drafting',
  prNumber: null,
  prUrl: null,
  mergedBy: null,
  checks: [],
  failReason: null,
  aiFailReason: null,
  updatedAt: '2026-11-14T10:00:00.000Z',
  ...over,
});
const pay = (over: Partial<ServiceState> = {}): ServiceState => makeService('payments', over);
const up = (n: number) => ({ errorRate: 0, p95Ms: 1, up: n, at: 'x' });
const cues = (before: ServiceState[], after: ServiceState[]): string[] => soundCues(before, after).map((c) => c.cue);

describe('soundCues: one cue per listed change', () => {
  it('plays ghost-appear when a room rises to haunted and possessed when it rises to possessed', () => {
    expect(cues([pay({ hauntLevel: 0 })], [pay({ hauntLevel: 2 })])).toEqual(['ghost-appear']);
    expect(cues([pay({ hauntLevel: 1 })], [pay({ hauntLevel: 2 })])).toEqual(['ghost-appear']);
    expect(cues([pay({ hauntLevel: 2 })], [pay({ hauntLevel: 3 })])).toEqual(['possessed']);
    expect(cues([pay({ hauntLevel: 0 })], [pay({ hauntLevel: 3 })])).toEqual(['possessed']);
    // A rise to uneasy, a fall to haunted and a level that stays are silent.
    expect(cues([pay({ hauntLevel: 0 })], [pay({ hauntLevel: 1 })])).toEqual([]);
    expect(cues([pay({ hauntLevel: 3 })], [pay({ hauntLevel: 2 })])).toEqual([]);
    expect(cues([pay({ hauntLevel: 2 })], [pay({ hauntLevel: 2 })])).toEqual([]);
  });

  it('plays room-dark when a room becomes dark, by level 4 or by `up` falling', () => {
    expect(cues([pay({ hauntLevel: 2 })], [pay({ hauntLevel: 4 })])).toEqual(['room-dark']);
    expect(cues([pay({ metrics: up(1) })], [pay({ metrics: up(0) })])).toEqual(['room-dark']);
    expect(cues([pay({ hauntLevel: 4 })], [pay({ hauntLevel: 4 })])).toEqual([]);
  });

  it('plays calm-restored when a room is calm again from haunted or worse, or from dark', () => {
    expect(cues([pay({ hauntLevel: 2 })], [pay({ hauntLevel: 0 })])).toEqual(['calm-restored']);
    expect(cues([pay({ hauntLevel: 3 })], [pay({ hauntLevel: 0 })])).toEqual(['calm-restored']);
    expect(cues([pay({ hauntLevel: 4 })], [pay({ hauntLevel: 0 })])).toEqual(['calm-restored']);
    expect(cues([pay({ metrics: up(0) })], [pay({ metrics: up(1) })])).toEqual(['calm-restored']);
    // Uneasy to calm is not a restore; haunted to uneasy is not calm.
    expect(cues([pay({ hauntLevel: 1 })], [pay({ hauntLevel: 0 })])).toEqual([]);
    expect(cues([pay({ hauntLevel: 2 })], [pay({ hauntLevel: 1 })])).toEqual([]);
    // Back from dark to a level that is not calm is no restore.
    expect(cues([pay({ hauntLevel: 4 })], [pay({ hauntLevel: 2 })])).toEqual([]);
  });

  it('plays hunt-start, hunt-step and diagnosed from the hunt of a room', () => {
    expect(cues([pay({ hunt: null })], [pay({ hunt: runningHunt(0) })])).toEqual(['hunt-start']);
    expect(cues([pay({ hunt: runningHunt(1) })], [pay({ hunt: runningHunt(2) })])).toEqual(['hunt-step']);
    expect(cues([pay({ hunt: runningHunt(3) })], [pay({ hunt: sealedHunt() })])).toEqual(['diagnosed']);
    expect(cues([pay({ hunt: runningHunt(2) })], [pay({ hunt: runningHunt(2) })])).toEqual([]);
  });

  it('plays fix-merged when a fix is merged (or deployed), once', () => {
    expect(cues([pay({ proposal: proposal({ status: 'open' }) })], [pay({ proposal: proposal({ status: 'merged' }) })])).toEqual(['fix-merged']);
    expect(cues([pay({ proposal: proposal({ status: 'open' }) })], [pay({ proposal: proposal({ status: 'deployed' }) })])).toEqual(['fix-merged']);
    expect(cues([pay({ proposal: proposal({ status: 'merged' }) })], [pay({ proposal: proposal({ status: 'deployed' }) })])).toEqual([]);
    expect(cues([pay({ proposal: null })], [pay({ proposal: proposal({ status: 'drafting' }) })])).toEqual([]);
    expect(cues([pay({ proposal: proposal({ status: 'drafting' }) })], [pay({ proposal: proposal({ status: 'open' }) })])).toEqual([]);
  });

  it('is silent for a service seen for the first time and for the same state twice', () => {
    expect(cues([], [pay({ hauntLevel: 3, hunt: runningHunt(2) })])).toEqual([]);
    const same = [pay({ hauntLevel: 3, hunt: runningHunt(2), proposal: proposal({ status: 'merged' }) })];
    expect(cues(same, same)).toEqual([]);
  });

  it('orders the cues of one change by priority', () => {
    const got = cues(
      [pay({ hauntLevel: 1, hunt: null, proposal: proposal({ status: 'open' }) }), makeService('gate', { hauntLevel: 3 })],
      [pay({ hauntLevel: 3, hunt: runningHunt(0), proposal: proposal({ status: 'merged' }) }), makeService('gate', { hauntLevel: 0 })],
    );
    expect(got).toEqual(['possessed', 'fix-merged', 'hunt-start', 'calm-restored']);
    expect(CUE_PRIORITY).toEqual(['room-dark', 'possessed', 'ghost-appear', 'diagnosed', 'fix-merged', 'hunt-start', 'calm-restored', 'hunt-step']);
  });

  it('reads the same changes as the announcer: it plays exactly when the announcer says something about level, dark, hunt or fix', () => {
    const pairs: Array<[ServiceState[], ServiceState[]]> = [
      [[pay({ hauntLevel: 0 })], [pay({ hauntLevel: 2 })]],
      [[pay({ metrics: up(1) })], [pay({ metrics: up(0) })]],
      [[pay({ hunt: null })], [pay({ hunt: runningHunt(0) })]],
      [[pay({ hunt: runningHunt(1) })], [pay({ hunt: runningHunt(2) })]],
      [[pay({ proposal: proposal({ status: 'open' }) })], [pay({ proposal: proposal({ status: 'merged' }) })]],
      [[pay({ hauntLevel: 1 })], [pay({ hauntLevel: 1 })]],
      [[], [pay({ hauntLevel: 3 })]],
    ];
    for (const [before, after] of pairs) {
      const a = announcementsFor(before, after);
      const announced = a.urgent.length > 0 || a.step !== null;
      expect(cues(before, after).length > 0, JSON.stringify(after)).toBe(announced);
    }
  });
});

describe('nextCue: the rate rules, with a fake clock', () => {
  const calm = [pay({ hauntLevel: 0 })];
  const haunted = [pay({ hauntLevel: 2 })];
  const dark = [pay({ hauntLevel: 4 })];

  it('makes no cue for the first snapshot, whatever it holds', () => {
    const out = nextCue(createCueGate(), [pay({ hauntLevel: 3, hunt: runningHunt(2) })], 0);
    expect(out.play).toBeNull();
    expect(out.gate.prev).not.toBeNull();
  });

  it('plays one cue and then nothing for the same state again (a reconnect)', () => {
    let gate: CueGate = nextCue(createCueGate(), calm, 0).gate;
    const first = nextCue(gate, haunted, 1000);
    expect(first.play).toEqual({ cue: 'ghost-appear', room: 'payments' });
    gate = first.gate;
    expect(nextCue(gate, haunted, 9000).play).toBeNull();
  });

  it('plays at most one cue in 700 ms', () => {
    let gate: CueGate = nextCue(createCueGate(), [pay({ hauntLevel: 0 }), makeService('gate')], 0).gate;
    const a = nextCue(gate, [pay({ hauntLevel: 2 }), makeService('gate')], 1000);
    expect(a.play?.cue).toBe('ghost-appear');
    gate = a.gate;
    // 699 ms later another room turns dark: dropped, not queued.
    const b = nextCue(gate, [pay({ hauntLevel: 2 }), makeService('gate', { hauntLevel: 4 })], 1000 + CUE_GAP_MS - 1);
    expect(b.play).toBeNull();
    // The same change at 700 ms is not seen again (the state moved on), but a new one is.
    const c = nextCue(b.gate, [pay({ hauntLevel: 2 }), makeService('gate', { hauntLevel: 0 })], 1000 + CUE_GAP_MS);
    expect(c.play?.cue).toBe('calm-restored');
  });

  it('keeps the highest priority when several cues compete in one snapshot', () => {
    const before = [pay({ hauntLevel: 0 }), makeService('gate', { hauntLevel: 2 }), makeService('orders', { hunt: null })];
    const after = [pay({ hauntLevel: 4 }), makeService('gate', { hauntLevel: 0 }), makeService('orders', { hunt: runningHunt(0) })];
    const out = nextCue(nextCue(createCueGate(), before, 0).gate, after, 5000);
    expect(out.play).toEqual({ cue: 'room-dark', room: 'payments' });
  });

  it('plays hunt-step at most once in 3 s', () => {
    let gate: CueGate = nextCue(createCueGate(), [pay({ hunt: runningHunt(1) }), makeService('gate', { hunt: runningHunt(1) })], 0).gate;
    const a = nextCue(gate, [pay({ hunt: runningHunt(2) }), makeService('gate', { hunt: runningHunt(1) })], 10_000);
    expect(a.play?.cue).toBe('hunt-step');
    gate = a.gate;
    // Another room steps 1.5 s later: past 700 ms, inside 3 s.
    const b = nextCue(gate, [pay({ hunt: runningHunt(2) }), makeService('gate', { hunt: runningHunt(2) })], 11_500);
    expect(b.play).toBeNull();
    const c = nextCue(b.gate, [pay({ hunt: runningHunt(2) }), makeService('gate', { hunt: runningHunt(3) })], 10_000 + STEP_GAP_MS);
    expect(c.play).toEqual({ cue: 'hunt-step', room: 'gate' });
  });

  it('plays the same cue for the same room at most once in 5 s', () => {
    let gate: CueGate = nextCue(createCueGate(), calm, 0).gate;
    const a = nextCue(gate, haunted, 10_000);
    expect(a.play?.cue).toBe('ghost-appear');
    // Calm again at 11 s plays calm-restored; haunted again at 12 s is the same cue for the same room 2 s after the first: dropped.
    const restored = nextCue(a.gate, calm, 11_000);
    expect(restored.play?.cue).toBe('calm-restored');
    const b = nextCue(restored.gate, haunted, 12_000);
    expect(b.play).toBeNull();
    // Calm at 13 s is calm-restored again 2 s after the last: dropped. Haunted at exactly 5 s after the first plays.
    const calmAgain = nextCue(b.gate, calm, 13_000);
    expect(calmAgain.play).toBeNull();
    gate = calmAgain.gate;
    const c = nextCue(gate, haunted, 10_000 + ROOM_GAP_MS);
    expect(c.play?.cue).toBe('ghost-appear');
    // Another cue for the same room is not held back by it.
    const d = nextCue(c.gate, dark, 10_000 + ROOM_GAP_MS + CUE_GAP_MS);
    expect(d.play?.cue).toBe('room-dark');
  });
});
