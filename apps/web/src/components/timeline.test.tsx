import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { makeService } from '../test/arbs.js';
import { runningHunt, sealedHunt } from '../test/hunt-arbs.js';
import { HuntSection } from './HuntSection.js';
afterEach(cleanup);
describe('Hunt timeline', () => {
  it('has one item per step, each with a decorative icon, the tool name and the time', () => {
    render(<HuntSection service={makeService('payments', { hunt: runningHunt(3) })} />);
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(3);
    for (const li of items) {
      expect(li.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
      expect(li.querySelector('.timeline-tool')?.textContent).toBe('search_errors');
      expect(li.querySelector('time')?.textContent).toMatch(/UTC$/);
    }
  });
  it('shows the diagnosis as a card with the AI label', () => {
    render(<HuntSection service={makeService('payments', { hunt: sealedHunt() })} />);
    const card = screen.getByTestId('hunt-diagnosis');
    expect(card.classList.contains('card--diagnosis')).toBe(true);
    expect(card.textContent).toContain('AI generated');
  });
});
