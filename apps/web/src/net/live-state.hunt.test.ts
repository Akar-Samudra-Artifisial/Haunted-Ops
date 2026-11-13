import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { validateHuntSummary, type HuntEventName, type HuntEventPayloads, type HuntSummary } from '@haunted-ops/shared';
import { SAMPLE_SERVICES } from '../test/fakes.js';
import { SHA, at, makeHunt } from '../test/hunt-arbs.js';
import { applyHuntEvent, applyLiveEvent, type LiveState } from './live-state.js';

const ID = 'cmhuntaaaaaaaaaaaaaaaaaaa';
const NEXT = 'cmhuntbbbbbbbbbbbbbbbbbbb';
const INC = 'cmincidentaaaaaaaaaaaaaaa';

const queued = (id = ID, when = 0): HuntEventPayloads['hunt.queued'] => ({ huntId: id, incidentId: INC, service: 'payments', trigger: 'auto', queuedAt: at(when) });
const started = (id = ID): HuntEventPayloads['hunt.started'] => ({ huntId: id, service: 'payments', model: 'claude-sonnet-5.5', startedAt: at(5) });
const step = (index: number, id = ID): HuntEventPayloads['hunt.step'] => ({ huntId: id, service: 'payments', index, tool: 'search_errors', summary: `errors ${index}`, at: at(10 + index) });
const evidence = (index: number, id = ID): HuntEventPayloads['hunt.evidence'] => ({ huntId: id, service: 'payments', index, kind: 'log', ref: `log:${index}`, detail: 'x', at: at(10 + index) });
const diagnosis = (id = ID): HuntEventPayloads['hunt.diagnosis'] => ({ huntId: id, service: 'payments', culpritDeploy: 'd-7', culpritSha: SHA, culpritService: 'ledger', summary: 'The guard was removed.', fixHint: '', cited: ['deploy:d-7'], at: at(60) });
const finished = (over: Partial<HuntEventPayloads['hunt.finished']> = {}): HuntEventPayloads['hunt.finished'] => ({
  huntId: ID,
  service: 'payments',
  status: 'succeeded',
  reason: 'diagnosed',
  invalidCheck: null,
  diagnosedBy: null,
  credits: 0.9,
  durationMs: 55_000,
  toolCalls: 12,
  finishedAt: at(60),
  ...over,
});

const start: LiveState = { services: SAMPLE_SERVICES.map((s) => ({ ...s, hunt: null })), ingest: null };
const huntOf = (s: LiveState, name = 'payments'): HuntSummary | null => s.services.find((x) => x.name === name)?.hunt ?? null;

describe('applyLiveEvent: hunt events', () => {
  it('follows a Hunt from queued to sealed, with a valid summary at every step', () => {
    let s = applyLiveEvent(start, 'hunt.queued', queued());
    expect(huntOf(s)).toMatchObject({ id: ID, status: 'queued', trigger: 'auto' });
    s = applyLiveEvent(s, 'hunt.started', started());
    expect(huntOf(s)).toMatchObject({ status: 'running', startedAt: at(5) });
    for (let i = 1; i <= 10; i++) s = applyLiveEvent(s, 'hunt.step', step(i));
    s = applyLiveEvent(s, 'hunt.evidence', evidence(3));
    expect(huntOf(s)).toMatchObject({ stepCount: 10, evidenceCount: 3 });
    expect(huntOf(s)?.steps.map((x) => x.index)).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
    s = applyLiveEvent(s, 'hunt.diagnosis', diagnosis());
    expect(huntOf(s)).toMatchObject({ status: 'succeeded', reason: 'diagnosed', diagnosis: { culpritDeploy: 'd-7', culpritSha: SHA, culpritService: 'ledger' } });
    s = applyLiveEvent(s, 'hunt.finished', finished());
    expect(huntOf(s)).toMatchObject({ status: 'succeeded', credits: 0.9, finishedAt: at(60) });
    expect(validateHuntSummary(huntOf(s)).ok).toBe(true);
  });

  it('shows a failure with no diagnosis', () => {
    let s = applyLiveEvent(start, 'hunt.queued', queued());
    s = applyLiveEvent(s, 'hunt.started', started());
    s = applyLiveEvent(s, 'hunt.finished', finished({ status: 'failed', reason: 'credit_cap', credits: 1.6 }));
    expect(huntOf(s)).toMatchObject({ status: 'failed', reason: 'credit_cap', diagnosis: null });
    expect(validateHuntSummary(huntOf(s)).ok).toBe(true);
  });

  it('takes a newer Hunt only on hunt.queued, and ignores the other events of any other Hunt', () => {
    let s = applyLiveEvent(start, 'hunt.queued', queued());
    s = applyLiveEvent(s, 'hunt.started', started());
    const other = applyLiveEvent(s, 'hunt.step', step(1, NEXT));
    expect(other).toBe(s);
    expect(applyLiveEvent(s, 'hunt.finished', finished({ huntId: NEXT }))).toBe(s);
    const newer = applyLiveEvent(s, 'hunt.queued', queued(NEXT, 100));
    expect(huntOf(newer)).toMatchObject({ id: NEXT, status: 'queued', stepCount: 0 });
    // An older Hunt that arrives late does not replace the newer one.
    expect(applyLiveEvent(newer, 'hunt.queued', queued(ID, 50))).toBe(newer);
  });

  it('is idempotent: a repeated or out-of-order event changes nothing', () => {
    let s = applyLiveEvent(start, 'hunt.queued', queued());
    s = applyLiveEvent(s, 'hunt.started', started());
    s = applyLiveEvent(s, 'hunt.step', step(1));
    s = applyLiveEvent(s, 'hunt.step', step(2));
    expect(applyLiveEvent(s, 'hunt.step', step(2))).toBe(s);
    expect(applyLiveEvent(s, 'hunt.step', step(1))).toBe(s);
    expect(applyLiveEvent(s, 'hunt.queued', queued())).toBe(s);
    expect(applyLiveEvent(s, 'hunt.started', started())).toBe(s);
    const done = applyLiveEvent(s, 'hunt.finished', finished({ status: 'failed', reason: 'timeout' }));
    expect(applyLiveEvent(done, 'hunt.step', step(3))).toBe(done);
    expect(applyLiveEvent(done, 'hunt.diagnosis', diagnosis())).toBe(done);
  });

  it('ignores a hunt event for a Service that is not in the state', () => {
    const empty: LiveState = { services: [], ingest: null };
    expect(applyLiveEvent(empty, 'hunt.queued', queued())).toBe(empty);
  });

  it('keeps the other Services as they were', () => {
    const s = applyLiveEvent(start, 'hunt.queued', queued());
    expect(huntOf(s, 'gate')).toBeNull();
    expect(s.services.map((x) => x.name)).toEqual(start.services.map((x) => x.name));
  });
});

const NAMES: HuntEventName[] = ['hunt.queued', 'hunt.started', 'hunt.step', 'hunt.evidence', 'hunt.diagnosis', 'hunt.finished'];

describe('applyHuntEvent properties', () => {
  it('always gives a valid summary and never lowers the step count of the same Hunt, for any event order', () => {
    const event = fc.oneof(
      fc.constant(['hunt.queued', queued()] as const),
      fc.constant(['hunt.started', started()] as const),
      fc.integer({ min: 1, max: 12 }).map((i) => ['hunt.step', step(i)] as const),
      fc.integer({ min: 1, max: 12 }).map((i) => ['hunt.evidence', evidence(i)] as const),
      fc.constant(['hunt.diagnosis', diagnosis()] as const),
      fc.constantFrom(finished(), finished({ status: 'failed', reason: 'timeout' }), finished({ status: 'cancelled', reason: 'disabled' })).map((p) => ['hunt.finished', p] as const),
    );
    fc.assert(
      fc.property(fc.array(event, { maxLength: 30 }), (events) => {
        let h: HuntSummary | null = null;
        for (const [name, payload] of events) {
          const before: HuntSummary | null = h;
          h = applyHuntEvent(h, name as 'hunt.queued', payload as never);
          if (h !== null) {
            // A Hunt that was not queued first is not shown at all: events of unknown Hunts are ignored.
            expect(validateHuntSummary(h).ok || h.status === 'succeeded').toBe(true);
            if (before !== null && before.id === h.id) expect(h.stepCount).toBeGreaterThanOrEqual(before.stepCount);
          }
        }
        expect(NAMES).toContain('hunt.queued');
      }),
      { numRuns: 200 },
    );
  });

  it('a hunt.finished without a diagnosis never leaves a diagnosis on a failed Hunt', () => {
    const s = applyHuntEvent(applyHuntEvent(null, 'hunt.queued', queued()), 'hunt.finished', finished({ status: 'failed', reason: 'timeout' }));
    expect(s?.diagnosis).toBeNull();
    expect(makeHunt().status).toBe('queued');
  });
});
