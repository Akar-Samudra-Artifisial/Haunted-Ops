import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProposalSummary, ServiceState } from '@haunted-ops/shared';
import { MAX_PENDING, MIN_GAP_MS } from '../a11y/announcement-queue.js';
import { makeService } from '../test/arbs.js';
import { runningHunt, sealedHunt } from '../test/hunt-arbs.js';
import { LiveAnnouncer, announcementsFor } from './LiveAnnouncer.js';

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
const said = (before: ServiceState, after: ServiceState): string[] => {
  const a = announcementsFor([before], [after]);
  return [...a.urgent, ...(a.step === null ? [] : [a.step])];
};
const up = (n: number) => ({ errorRate: 0, p95Ms: 1, up: n, at: 'x' });

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('announcementsFor: one sentence per listed change', () => {
  it('says a room that goes dark or is back', () => {
    expect(said(pay({ metrics: up(1) }), pay({ metrics: up(0) }))).toEqual(['payments is dark.']);
    expect(said(pay({ metrics: up(0) }), pay({ metrics: up(1) }))).toEqual(['payments is back.']);
    expect(said(pay({ hauntLevel: 2 }), pay({ hauntLevel: 4 }))).toEqual(['payments: dark']);
    expect(said(pay({ hauntLevel: 4 }), pay({ hauntLevel: 0 }))).toEqual(['payments: calm', 'payments is back.']);
  });
  it('says a hunt start, a step, and the diagnosis with the short commit', () => {
    expect(said(pay({ hunt: null }), pay({ hunt: runningHunt(0) }))).toEqual(['Hunt started on payments.']);
    expect(said(pay({ hunt: runningHunt(1) }), pay({ hunt: runningHunt(2) }))).toEqual(['Hunt on payments, step 2: errors.']);
    expect(said(pay({ hunt: runningHunt(3) }), pay({ hunt: sealedHunt() }))).toEqual(['Diagnosis for payments: deploy d-7, commit 65c0fca.']);
  });
  it('says the kind of the proposal, merged, deployed, and the short reason of a failure', () => {
    const base = pay({ proposal: proposal({ status: 'drafting' }) });
    const url = 'https://github.com/example/haunted-lab/pull/4';
    const open = (kind: 'ai_patch' | 'revert') => pay({ proposal: proposal({ status: 'open', kind, prNumber: 4, prUrl: url }) });
    expect(said(base, open('ai_patch'))).toEqual(['Pull request 4 open on payments, AI patch.']);
    expect(said(base, open('revert'))).toEqual(['Pull request 4 open on payments, revert.']);
    expect(said(open('revert'), pay({ proposal: proposal({ status: 'merged', mergedBy: 'octocat' }) }))).toEqual(['Fix merged on payments by octocat.']);
    expect(said(base, pay({ proposal: proposal({ status: 'deployed' }) }))).toEqual(['Fix deployed on payments.']);
    expect(said(base, pay({ proposal: proposal({ status: 'failed', failReason: null, aiFailReason: 'tests_failed' }) }))).toEqual(['Fix failed on payments: tests failed.']);
  });
  it('is silent for a Service seen for the first time and for the same state twice', () => {
    expect(announcementsFor([], [pay({ hauntLevel: 4, hunt: runningHunt(2) })])).toEqual({ urgent: [], step: null });
    const s = pay({ hauntLevel: 2 });
    expect(announcementsFor([s], [s])).toEqual({ urgent: [], step: null });
  });
});

describe('LiveAnnouncer queue', () => {
  const region = (): HTMLElement => screen.getByTestId('level-announcer');
  const lv = (n: 0 | 1 | 2 | 3 | 4): ServiceState[] => [pay({ hauntLevel: n })];

  it('is the only aria-live region of its tree and starts empty', () => {
    const { container } = render(<LiveAnnouncer services={lv(0)} />);
    expect(container.querySelectorAll('[aria-live], [role="status"], [role="alert"]')).toHaveLength(1);
    expect(region().textContent).toBe('');
  });
  it('speaks a burst of equal sentences once', () => {
    const { rerender } = render(<LiveAnnouncer services={lv(0)} />);
    rerender(<LiveAnnouncer services={lv(2)} />);
    rerender(<LiveAnnouncer services={lv(0)} />);
    rerender(<LiveAnnouncer services={lv(2)} />);
    expect(region().textContent).toBe('payments: haunted');
    act(() => {
      vi.advanceTimersByTime(MIN_GAP_MS * 3);
    });
    // "payments: calm" is the only other sentence; the second "haunted" was dropped.
    expect(region().textContent).toBe('payments: calm');
    act(() => {
      vi.advanceTimersByTime(MIN_GAP_MS * 3);
    });
    expect(region().textContent).toBe('payments: calm');
  });
  it('releases one sentence per 2 s in order, and drops the oldest above the cap', () => {
    const all = (n: 0 | 2 | 3): ServiceState[] => (['gate', 'orders', 'payments', 'ledger'] as const).map((name) => makeService(name, { hauntLevel: n }));
    const { rerender } = render(<LiveAnnouncer services={all(0)} />);
    rerender(<LiveAnnouncer services={all(2)} />);
    rerender(<LiveAnnouncer services={all(3)} />);
    // 8 different sentences: the first is said at once, 5 may wait, so two of the middle ones were dropped.
    expect(region().textContent).toBe('gate: haunted');
    const heard: string[] = [region().textContent ?? ''];
    for (let i = 0; i < 8; i++) {
      act(() => {
        vi.advanceTimersByTime(MIN_GAP_MS);
      });
      const t = region().textContent ?? '';
      if (t !== heard.at(-1)) heard.push(t);
    }
    expect(heard).toHaveLength(1 + MAX_PENDING);
    expect(heard).toEqual(['gate: haunted', 'ledger: haunted', 'gate: possessed', 'orders: possessed', 'payments: possessed', 'ledger: possessed']);
  });
  it('says a sentence from outside the services, and the same one again after the repeat window as a new DOM write', () => {
    const { rerender } = render(<LiveAnnouncer services={lv(0)} notice={null} />);
    const writes: string[] = [];
    const observer = new MutationObserver((records) => {
      for (const r of records) for (const n of r.addedNodes) writes.push(n.textContent ?? '');
    });
    observer.observe(region(), { childList: true, characterData: true, subtree: true });
    rerender(<LiveAnnouncer services={lv(0)} notice={{ text: 'Metrics are stale.' }} />);
    expect(region().textContent).toBe('Metrics are stale.');
    writes.push(...observer.takeRecords().flatMap((r) => [...r.addedNodes].map((n) => n.textContent ?? '')));
    expect(writes.filter((w) => w === 'Metrics are stale.')).toHaveLength(1);
    // The same sentence inside 10 s is dropped.
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    rerender(<LiveAnnouncer services={lv(0)} notice={{ text: 'Metrics are stale.' }} />);
    writes.push(...observer.takeRecords().flatMap((r) => [...r.addedNodes].map((n) => n.textContent ?? '')));
    expect(writes.filter((w) => w === 'Metrics are stale.')).toHaveLength(1);
    // After the window it is written again, though the text did not change.
    act(() => {
      vi.advanceTimersByTime(6_000);
    });
    rerender(<LiveAnnouncer services={lv(0)} notice={{ text: 'Metrics are stale.' }} />);
    writes.push(...observer.takeRecords().flatMap((r) => [...r.addedNodes].map((n) => n.textContent ?? '')));
    observer.disconnect();
    expect(writes.filter((w) => w === 'Metrics are stale.')).toHaveLength(2);
  });
  it('clears its timers when it unmounts', () => {
    const { rerender, unmount } = render(<LiveAnnouncer services={lv(0)} />);
    rerender(<LiveAnnouncer services={lv(2)} />);
    rerender(<LiveAnnouncer services={lv(3)} />);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
