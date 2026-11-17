import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HuntEmpty } from './HuntSection.js';
import { Legend } from './Legend.js';
import { LEGEND_KEY } from './legend-state.js';
beforeEach(() => localStorage.clear());
afterEach(cleanup);
const details = (): HTMLDetailsElement => screen.getByText('What am I looking at?').parentElement as HTMLDetailsElement;
describe('Legend', () => {
  it('is open on a first visit and lists every thing and every level', () => {
    render(<Legend />);
    expect(details().open).toBe(true);
    for (const t of ['Ghost', 'Fog', 'Dark room', 'Lantern', 'Green mist', 'Dust floating in lantern light', 'Red outline and dot on a room label']) expect(screen.getByText(t)).toBeTruthy();
    const items = [...document.querySelectorAll('.legend-things li')].map((li) => li.textContent);
    expect(items).toEqual(['Ghost = errors', 'Fog = latency', 'Dark room = the service is down', 'Lantern = healthy', 'Green mist = the Exorcist is investigating', 'Dust floating in lantern light = a quiet, healthy room', 'Red outline and dot on a room label = an incident is open']);
    const levels = [...document.querySelectorAll('.legend-levels li')].map((li) => li.textContent?.replace(/^[○◔◑◕●]\s*/, ''));
    expect(levels).toEqual(['calm', 'uneasy', 'haunted', 'possessed', 'dark']);
    expect(document.querySelectorAll('.legend svg[aria-hidden="true"]').length).toBe(7);
  });
  it('keeps the choice of the visitor', () => {
    const first = render(<Legend />);
    fireEvent.click(screen.getByText('What am I looking at?'));
    expect(localStorage.getItem(LEGEND_KEY)).toBe('closed');
    first.unmount();
    render(<Legend />);
    expect(details().open).toBe(false);
  });
  it('opens when the storage says open', () => {
    localStorage.setItem(LEGEND_KEY, 'open');
    render(<Legend />);
    expect(details().open).toBe(true);
  });
  it('writes nothing on a first visit', () => {
    render(<Legend />);
    expect(localStorage.getItem(LEGEND_KEY)).toBeNull();
  });
});
describe('Panel empty state', () => {
  it('is one sentence on what will appear', () => {
    render(<HuntEmpty />);
    expect(screen.getByTestId('hunt-empty').textContent).toMatch(/appear here when a hunt starts\.$/);
  });
});
