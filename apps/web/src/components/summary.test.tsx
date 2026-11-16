import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { HauntLevel, ServiceName } from '@haunted-ops/shared';
import { makeService } from '../test/arbs.js';
import { makeHunt, runningHunt, sealedHunt } from '../test/hunt-arbs.js';
import { SummaryBar } from './SummaryBar.js';
import { summarize } from './summary.js';
afterEach(cleanup);
const NAMES: ServiceName[] = ['gate', 'orders', 'payments', 'ledger'];
const at = (levels: HauntLevel[]) => levels.map((hauntLevel, i) => makeService(NAMES[i] as ServiceName, { hauntLevel }));
describe('SummaryBar', () => {
  it('says the count of each level, worst first, and leaves out empty levels', () => {
    render(<SummaryBar services={at([2, 0, 3, 2])} />);
    const text = screen.getByTestId('summary-bar').querySelector('.summary-counts')?.textContent ?? '';
    expect(text.replace(/[○◔◑◕●]\s*/g, '')).toBe('1 possessed · 2 haunted · 1 calm');
    expect(screen.queryByText(/uneasy/)).toBeNull();
    expect(screen.queryByTestId('summary-hunt')).toBeNull();
  });
  it('is not a live region', () => {
    const { container } = render(<SummaryBar services={at([2])} />);
    expect(container.querySelector('[aria-live],[role=status],[role=alert],[role=log]')).toBeNull();
  });
  it('says the state of the hunted service, never "x of y"', () => {
    const cases: Array<[ReturnType<typeof makeService>, string]> = [
      [makeService('payments', { hunt: runningHunt(5) }), 'Hunt running · 5 steps'],
      [makeService('payments', { hunt: runningHunt(1) }), 'Hunt running · 1 step'],
      [makeService('payments', { hunt: makeHunt() }), 'Hunt queued'],
      [makeService('payments', { hunt: sealedHunt() }), 'Diagnosed'],
    ];
    for (const [service, text] of cases) {
      expect(summarize([service]).huntState).toBe(text);
      expect(text).not.toMatch(/\bof\b/);
    }
  });
  it('shows no hunt state without a hunt', () => {
    expect(summarize(at([0, 0])).huntState).toBeNull();
  });
});
