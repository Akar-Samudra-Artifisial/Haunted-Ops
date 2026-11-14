import { act, cleanup, render, screen, within } from '@testing-library/react';
import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateHuntSummary, type HuntDetail, type HuntSummary, type ServiceName, type ServiceState } from '@haunted-ops/shared';
import { applyHuntEvent } from '../net/live-state.js';
import { makeService } from '../test/arbs.js';
import { SHA, at, failedHunt, huntSummaryArb, makeHunt, runningHunt, sealedHunt } from '../test/hunt-arbs.js';
import { HuntSection, huntSectionService } from './HuntSection.js';
import { LiveAnnouncer, STEP_INTERVAL_MS, StepGate, huntSentences } from './LiveAnnouncer.js';
import { REASON_TEXT, huntCellText, huntStepText, huntView } from './hunt-text.js';
import { TableMode } from './TableMode.js';
import { toSceneModel } from '../scene/model.js';
import { tableRowText } from './table-model.js';

afterEach(() => {
  cleanup();
});

const withHunt = (hunt: HuntSummary | null, name: ServiceName = 'payments'): ServiceState => makeService(name, { hunt });

describe('huntView and huntCellText', () => {
  it('says none, queued, running, sealed, failed and cancelled in words', () => {
    expect(huntCellText(huntView(null))).toBe('none');
    expect(huntCellText(huntView(makeHunt()))).toBe('queued');
    expect(huntCellText(huntView(makeHunt({ status: 'running', startedAt: at(5) })))).toBe('running: starting');
    expect(huntCellText(huntView(runningHunt(3)))).toBe('running: step 3, errors');
    expect(huntCellText(huntView(sealedHunt()))).toBe('sealed: d-7, 65c0fca');
    expect(huntCellText(huntView(failedHunt('credit_cap')))).toBe('failed: credit cap reached');
    expect(huntCellText(huntView(makeHunt({ status: 'cancelled', reason: 'disabled', finishedAt: at(1) })))).toBe('cancelled: hunts are off');
  });

  it('has words for every end reason', () => {
    for (const text of Object.values(REASON_TEXT)) expect(text).toMatch(/^[a-z ]{4,40}$/);
  });

  it('does not call a succeeded Hunt without a diagnosis sealed', () => {
    const v = huntView(makeHunt({ status: 'succeeded', reason: 'diagnosed', finishedAt: at(2), diagnosis: null }));
    expect(v.phase).toBe('failed');
  });

  it('is total and bounded for any summary', () => {
    fc.assert(
      fc.property(huntSummaryArb, (h) => {
        const v = huntView(h);
        const text = huntCellText(v);
        expect(text.length).toBeGreaterThan(0);
        expect(text.length).toBeLessThanOrEqual(60);
        expect(v.stepCount).toBe(h.stepCount);
        expect((v.phase === 'sealed') === (h.status === 'succeeded' && h.diagnosis !== null)).toBe(true);
        expect(huntView(h)).toEqual(v);
      }),
    );
  });
});

describe('TableMode: the Hunt column and section', () => {
  it('shows the hunt cell of each Service', () => {
    render(<TableMode services={[withHunt(runningHunt(2)), withHunt(null, 'gate')]} />);
    expect(screen.getByRole('columnheader', { name: 'Hunt' })).toBeTruthy();
    expect(within(screen.getByRole('row', { name: /^payments\b/ })).getByText('running: step 2, errors')).toBeTruthy();
    expect(within(screen.getByRole('row', { name: /^gate\b/ })).getAllByText('none').length).toBe(4); // reason, incident, hunt, fix
  });

  it('shows the steps as an ordered list for the Service with the running Hunt, with no selection', () => {
    render(<TableMode services={[withHunt(null, 'gate'), withHunt(runningHunt(3))]} />);
    const list = screen.getByRole('list', { name: /steps of the hunt on payments/i });
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'step 1: errors payments since 10:41:00',
      'step 2: errors payments since 10:41:00',
      'step 3: errors payments since 10:41:00',
    ]);
    expect(list.tagName).toBe('OL');
  });

  it('shows the Hunt of the selected Service instead', () => {
    render(<TableMode services={[withHunt(runningHunt(1)), withHunt(sealedHunt(), 'orders')]} selected="orders" />);
    expect(screen.getByRole('heading', { name: 'Hunt on orders' })).toBeTruthy();
    expect(screen.getByTestId('hunt-state').textContent).toBe('sealed: d-7, 65c0fca');
  });

  it('shows no section when nothing is selected and no Hunt runs', () => {
    render(<TableMode services={[withHunt(sealedHunt())]} />);
    expect(screen.queryByTestId('hunt-section')).toBeNull();
  });

  it('shows a valid diagnosis with its cited evidence as plain text, and nothing for a failed Hunt', async () => {
    const detail: HuntDetail = {
      ...sealedHunt(),
      model: 'claude-sonnet-5.5',
      toolCalls: 12,
      durationMs: 5000,
      invalidCheck: null,
      stopDetail: null,
      linkedHuntId: null,
      creditsEstimated: false,
      allSteps: [{ index: 1, tool: 'recent_deploys', summary: 'deploys since 10:20:00', at: at(11) }],
      evidence: [
        { index: 1, kind: 'deploy', ref: 'deploy:d-7', detail: 'd-7 payments 65c0fca', cited: true },
        { index: 2, kind: 'log', ref: 'log:1', detail: 'not cited', cited: false },
      ],
      fixHint: 'Restore it.',
      proposal: null,
    };
    render(<TableMode services={[withHunt(sealedHunt())]} selected="payments" loadHuntDetail={async () => detail} />);
    expect(screen.getByTestId('hunt-diagnosis').textContent).toContain('Culprit: deploy d-7, commit 65c0fca.');
    expect(screen.getByTestId('hunt-diagnosis').textContent).toContain('The guard was removed.');
    expect(await screen.findByText('deploy: d-7 payments 65c0fca')).toBeTruthy();
    expect(screen.queryByText(/not cited/)).toBeNull();
    // The summary and the fix hint are model text: plain, each with an "AI generated" label.
    const labels = screen.getAllByText('AI generated');
    expect(labels.length).toBe(2);
    expect(screen.getByTestId('hunt-diagnosis').textContent).toContain('Fix hint: Restore it.');
    expect(screen.getByTestId('hunt-diagnosis').querySelector('a, script, img')).toBeNull();
    cleanup();
    render(<TableMode services={[withHunt(failedHunt())]} selected="payments" />);
    expect(screen.queryByTestId('hunt-diagnosis')).toBeNull();
    expect(screen.getByTestId('hunt-state').textContent).toBe('failed: credit cap reached');
  });

  it('says how many steps are not shown', () => {
    render(<HuntSection service={withHunt(runningHunt(12))} />);
    expect(screen.getByText('Showing the last 8 of 12 steps.')).toBeTruthy();
  });

  it('picks the Service for the section: the selected one, else running, else queued', () => {
    const list = [withHunt(makeHunt(), 'gate'), withHunt(runningHunt(1), 'orders')];
    expect(huntSectionService(list, null)?.name).toBe('orders');
    expect(huntSectionService(list, 'gate')?.name).toBe('gate');
    expect(huntSectionService([withHunt(makeHunt(), 'gate')], null)?.name).toBe('gate');
    expect(huntSectionService([withHunt(sealedHunt())], null)).toBeNull();
  });

  it('has the cell text of the row model', () => {
    expect(tableRowText(withHunt(sealedHunt())).hunt).toBe('sealed: d-7, 65c0fca');
    expect(huntStepText({ index: 4, summary: 'diff 65c0fca' })).toBe('step 4: diff 65c0fca');
  });
});

describe('a culprit in another Service', () => {
  const downstream = (): HuntSummary => ({
    ...sealedHunt(),
    service: 'gate',
    diagnosis: { culpritDeploy: 'd-8', culpritSha: '739d1217dc01c07adc69d38d53231d0dfab23b1f', culpritService: 'orders', summary: 'The inventory check loops.' },
  });

  it('says "caused by" in the cell, the section, the announcement and the scene label', () => {
    const s = withHunt(downstream(), 'gate');
    expect(huntView(s.hunt).causedBy).toBe('orders');
    expect(huntCellText(huntView(s.hunt))).toBe('sealed: d-8, 739d121, caused by orders');
    expect(tableRowText(s).hunt).toBe('sealed: d-8, 739d121, caused by orders');
    render(<HuntSection service={s} />);
    expect(screen.getByTestId('hunt-diagnosis').textContent).toContain('Culprit: deploy d-8, commit 739d121, caused by orders.');
    const running = withHunt({ ...runningHunt(2), service: 'gate' }, 'gate');
    expect(huntSentences(new Map([['gate', running.hunt]]), [s]).urgent).toEqual(['Diagnosis for gate: deploy d-8, commit 739d121, caused by orders.']);
    expect(toSceneModel([s], Date.parse('2026-11-13T10:00:30Z'), { reducedMotion: false, quality: 'full' }).rooms[0]?.hunt?.label).toBe('sealed: d-8, 739d121, caused by orders');
  });

  it('says nothing extra when the culprit is in the hunted Service', () => {
    expect(huntCellText(huntView(sealedHunt()))).toBe('sealed: d-7, 65c0fca');
    expect(huntView(sealedHunt()).causedBy).toBeNull();
  });
});

describe('a Hunt withdrawn because an upstream Hunt diagnosed it', () => {
  const withdrawn = (): HuntSummary => ({ ...makeHunt({ service: 'ledger', status: 'cancelled', reason: 'diagnosed_upstream', finishedAt: at(40) }), diagnosedBy: 'payments' });

  it('says which Service diagnosed it in the cell, the section, the announcement and the Scene label', () => {
    const s = withHunt(withdrawn(), 'ledger');
    expect(huntCellText(huntView(s.hunt))).toBe('cancelled: diagnosed by the payments hunt');
    expect(tableRowText(s).hunt).toBe('cancelled: diagnosed by the payments hunt');
    render(<HuntSection service={s} />);
    expect(screen.getByTestId('hunt-state').textContent).toBe('cancelled: diagnosed by the payments hunt');
    const queued = withHunt(makeHunt({ service: 'ledger' }), 'ledger');
    expect(huntSentences(new Map([['ledger', queued.hunt]]), [s]).urgent).toEqual(['Hunt on ledger cancelled: diagnosed by the payments hunt.']);
    expect(toSceneModel([s], Date.parse('2026-11-13T10:00:30Z'), { reducedMotion: false, quality: 'full' }).rooms[0]?.hunt).toMatchObject({ phase: 'fizzled', figure: false, result: 'failed', label: 'cancelled: diagnosed by the payments hunt' });
  });

  it('follows hunt.finished with diagnosedBy in the reducer', () => {
    let hunt = applyHuntEvent(null, 'hunt.queued', { huntId: withdrawn().id, incidentId: 'cmincidentaaaaaaaaaaaaaaa', service: 'ledger', trigger: 'auto', queuedAt: at(30) });
    hunt = applyHuntEvent(hunt, 'hunt.finished', {
      huntId: withdrawn().id,
      service: 'ledger',
      status: 'cancelled',
      reason: 'diagnosed_upstream',
      invalidCheck: null,
      diagnosedBy: 'payments',
      credits: 0,
      durationMs: 0,
      toolCalls: 0,
      finishedAt: at(40),
    });
    expect(hunt).toMatchObject({ status: 'cancelled', reason: 'diagnosed_upstream', diagnosedBy: 'payments' });
    expect(validateHuntSummary(hunt).ok).toBe(true);
  });
});

describe('huntSentences', () => {
  const prevOf = (...s: ServiceState[]) => new Map(s.map((x) => [x.name, x.hunt]));

  it('is silent for a Service seen for the first time and for an unchanged state', () => {
    const s = withHunt(runningHunt(2));
    expect(huntSentences(new Map(), [s])).toEqual({ urgent: [], step: null });
    expect(huntSentences(prevOf(s), [s])).toEqual({ urgent: [], step: null });
  });

  it('announces the start, a step, the diagnosis and a failure', () => {
    const queued = withHunt(makeHunt());
    const running = withHunt(runningHunt(0));
    expect(huntSentences(prevOf(queued), [running]).urgent).toEqual(['Hunt started on payments.']);
    const step3 = withHunt(runningHunt(3));
    expect(huntSentences(prevOf(withHunt(runningHunt(2))), [step3]).step).toBe('Hunt on payments, step 3: errors.');
    expect(huntSentences(prevOf(step3), [withHunt(sealedHunt())]).urgent).toEqual(['Diagnosis for payments: deploy d-7, commit 65c0fca.']);
    expect(huntSentences(prevOf(step3), [withHunt(failedHunt('credit_cap'))]).urgent).toEqual(['Hunt on payments failed: credit cap reached.']);
  });

  it('treats a newer Hunt of the Service as a new one', () => {
    const old = withHunt(sealedHunt());
    const next = withHunt({ ...runningHunt(0), id: 'cmhuntbbbbbbbbbbbbbbbbbbb' });
    expect(huntSentences(prevOf(old), [next]).urgent).toEqual(['Hunt started on payments.']);
  });
});

// Feature: exorcist-agent, Property 16
describe('Property 16: announcements are short and not repetitive', () => {
  it('every sentence is short, and the same transition is never said twice', () => {
    fc.assert(
      fc.property(fc.array(huntSummaryArb, { minLength: 2, maxLength: 12 }), (hunts) => {
        let previous = new Map<ServiceName, HuntSummary | null>([['payments', null]]);
        for (const h of hunts) {
          const s = withHunt({ ...h, service: 'payments' });
          const first = huntSentences(previous, [s]);
          for (const text of [...first.urgent, ...(first.step === null ? [] : [first.step])]) {
            expect(text.length).toBeLessThanOrEqual(110);
            // eslint-disable-next-line no-control-regex
            expect(text).not.toMatch(/[\u0000-\u001f]/);
          }
          previous = new Map([['payments', s.hunt]]);
          expect(huntSentences(previous, [s])).toEqual({ urgent: [], step: null });
        }
      }),
      { numRuns: 200 },
    );
  });

  it('lets at most one step sentence through per 5 seconds, newest first, and never the same twice in a row', () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(fc.integer({ min: 0, max: 4000 }), fc.integer({ min: 1, max: 6 })), { minLength: 1, maxLength: 40 }), (offers) => {
        const gate = new StepGate();
        let now = 1_000_000;
        const said: Array<{ at: number; text: string }> = [];
        for (const [gap, n] of offers) {
          now += gap;
          const text = `Hunt on payments, step ${n}: errors.`;
          const out = gate.offer(text, now);
          if (out !== null) said.push({ at: now, text: out });
          const wait = gate.waitMs(now);
          if (wait !== null) {
            const late = gate.release(now + wait);
            if (late !== null) said.push({ at: now + wait, text: late });
          }
        }
        for (let i = 1; i < said.length; i++) {
          expect(said[i]!.at - said[i - 1]!.at).toBeGreaterThanOrEqual(STEP_INTERVAL_MS);
          expect(said[i]!.text).not.toBe(said[i - 1]!.text);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('puts one sentence in the live region per change and waits to say the next step', () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(<LiveAnnouncer services={[withHunt(makeHunt())]} />);
      const region = screen.getByTestId('level-announcer');
      expect(region.textContent).toBe('');
      rerender(<LiveAnnouncer services={[withHunt(runningHunt(0))]} />);
      expect(region.textContent).toBe('Hunt started on payments.');
      rerender(<LiveAnnouncer services={[withHunt(runningHunt(1))]} />);
      expect(region.textContent).toBe('Hunt on payments, step 1: errors.');
      rerender(<LiveAnnouncer services={[withHunt(runningHunt(2))]} />);
      rerender(<LiveAnnouncer services={[withHunt(runningHunt(3))]} />);
      // Steps 2 and 3 came within 5 s: only the newest is said, later.
      expect(region.textContent).toBe('Hunt on payments, step 1: errors.');
      act(() => {
        vi.advanceTimersByTime(STEP_INTERVAL_MS + 10);
      });
      expect(region.textContent).toBe('Hunt on payments, step 3: errors.');
      rerender(<LiveAnnouncer services={[withHunt(sealedHunt())]} />);
      expect(region.textContent).toBe('Diagnosis for payments: deploy d-7, commit 65c0fca.');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Hunt text', () => {
  it('keeps the culprit SHA short in every phrase', () => {
    expect(huntCellText(huntView(sealedHunt()))).not.toContain(SHA);
  });
});
