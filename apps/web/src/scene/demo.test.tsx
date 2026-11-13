import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateServiceStates, type ServiceName, type ServiceState } from '@haunted-ops/shared';
import { App } from '../App.js';
import { Header } from '../components/Header.js';
import { DEMO_DURATION_MS, demoServices, demoTime, scenarioServices } from './demo.js';
import { DEMO_SCENARIOS, parseDemoParam } from './params.js';

const at = (s: number): ServiceState[] => demoServices(s * 1000);
const of = (list: ServiceState[], name: ServiceName): ServiceState => list.find((x) => x.name === name)!;
const DEV = { PROD: false };

describe('parseDemoParam', () => {
  it('reads the timeline, the loop flag and every scenario name', () => {
    expect(parseDemoParam('?demo=1', DEV)).toEqual({ kind: 'timeline', loop: false });
    expect(parseDemoParam('?demo=1&loop=1', DEV)).toEqual({ kind: 'timeline', loop: true });
    expect(parseDemoParam('?demo=1&loop=0', DEV)).toEqual({ kind: 'timeline', loop: false });
    for (const name of DEMO_SCENARIOS) expect(parseDemoParam(`?demo=${name}`, DEV)).toEqual({ kind: 'scenario', name });
  });

  it('ignores a missing, empty or unknown value', () => {
    for (const search of ['', '?', '?x=1', '?demo=', '?demo=2', '?demo=payments', '?demo=Calm', '?demo=<script>', '?demo=1%00']) {
      expect(parseDemoParam(search, DEV), search).toBeNull();
    }
  });

  it('ignores the parameter in a production build unless VITE_DEMO_MODE is true', () => {
    expect(parseDemoParam('?demo=1', { PROD: true })).toBeNull();
    expect(parseDemoParam('?demo=ledger-dark', { PROD: true, VITE_DEMO_MODE: 'false' })).toBeNull();
    expect(parseDemoParam('?demo=ledger-dark', { PROD: true, VITE_DEMO_MODE: 'yes' })).toBeNull();
    expect(parseDemoParam('?demo=ledger-dark', { PROD: true, VITE_DEMO_MODE: 'true' })).toEqual({ kind: 'scenario', name: 'ledger-dark' });
    expect(parseDemoParam('?demo=1', { PROD: false, VITE_DEMO_MODE: 'false' })).toEqual({ kind: 'timeline', loop: false });
  });
});

describe('demo timeline', () => {
  it('is calm for the first 5 seconds', () => {
    const calm = at(3);
    expect(calm.map((s) => s.hauntLevel)).toEqual([0, 0, 0, 0]);
    expect(calm.every((s) => s.openIncident === null && s.reason === null)).toBe(true);
  });

  it('raises payments to level 2 with an incident, then to level 3', () => {
    const haunted = of(at(12), 'payments');
    expect(haunted).toMatchObject({ hauntLevel: 2, reason: { kind: 'error_rate' } });
    expect(haunted.openIncident).not.toBeNull();
    expect(of(at(12), 'orders').hauntLevel).toBe(0);
    const possessed = of(at(22), 'payments');
    expect(possessed.hauntLevel).toBe(3);
    expect(possessed.openIncident?.peakLevel).toBe(3);
  });

  it('puts fog on orders, then ledger in the dark', () => {
    const fog = of(at(27), 'orders');
    expect(fog).toMatchObject({ hauntLevel: 2, reason: { kind: 'p95' } });
    expect(fog.metrics!.p95Ms!).toBeGreaterThan(1000);
    const dark = of(at(31), 'ledger');
    expect(dark).toMatchObject({ hauntLevel: 4, reason: { kind: 'down' } });
    expect(dark.metrics!.up).toBe(0);
    expect(of(at(29), 'ledger').hauntLevel).toBe(0);
  });

  it('recovers and is calm again before the end, with every incident closed', () => {
    const end = at(46);
    expect(end.map((s) => s.hauntLevel)).toEqual([0, 0, 0, 0]);
    expect(end.every((s) => s.openIncident === null)).toBe(true);
    expect(of(at(37), 'payments').hauntLevel).toBeGreaterThan(0);
  });

  it('is a pure function of time, wraps with loop and stops at the end without it', () => {
    expect(demoServices(12_345)).toEqual(demoServices(12_345));
    expect(demoServices(12_999)).toEqual(demoServices(12_000));
    expect(demoTime(DEMO_DURATION_MS + 5000, true)).toBe(5000);
    expect(demoTime(DEMO_DURATION_MS + 5000, false)).toBe(DEMO_DURATION_MS - 1);
    expect(demoTime(-5, false)).toBe(0);
    expect(demoServices(demoTime(DEMO_DURATION_MS + 3000, true))).toEqual(demoServices(3000));
  });

  it('gives a valid fixed state for each scenario', () => {
    for (const name of DEMO_SCENARIOS) {
      const list = scenarioServices(name);
      expect(validateServiceStates(list).ok, name).toBe(true);
      expect(list.map((s) => s.name)).toEqual(['gate', 'orders', 'payments', 'ledger']);
      expect(scenarioServices(name)).toEqual(list);
    }
    expect(of(scenarioServices('ledger-dark'), 'ledger')).toMatchObject({ hauntLevel: 4, reason: { kind: 'down', value: 0 } });
    expect(of(scenarioServices('payments-haunted'), 'payments')).toMatchObject({ hauntLevel: 2, reason: { kind: 'error_rate' } });
    expect(scenarioServices('calm').every((s) => s.hauntLevel === 0)).toBe(true);
  });
});

describe('Demo mode in the app', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  const clientSpies = () => ({
    fetchImpl: vi.fn(() => Promise.reject(new Error('no network in demo'))),
    createEventSource: vi.fn(() => {
      throw new Error('no stream in demo');
    }),
  });

  it('shows "Demo data, not live" and makes no request and no stream', () => {
    const spies = clientSpies();
    render(<App client={{ baseUrl: 'http://api.test', ...spies }} demo={{ kind: 'scenario', name: 'ledger-dark' }} />);
    expect(screen.getByText('Demo data, not live')).toBeTruthy();
    expect(screen.queryByText(/Connection:/)).toBeNull();
    expect(spies.fetchImpl).not.toHaveBeenCalled();
    expect(spies.createEventSource).not.toHaveBeenCalled();
    const row = screen.getByRole('row', { name: /^ledger/ });
    expect(within(row).getAllByRole('cell')[0]?.textContent).toContain('4 (dark)');
  });

  it('advances the timeline with time, and keeps the live header otherwise', () => {
    const spies = clientSpies();
    render(<App client={{ baseUrl: 'http://api.test', ...spies }} demo={{ kind: 'timeline', loop: false }} />);
    const ledger = () => within(screen.getByRole('row', { name: /^ledger/ })).getAllByRole('cell')[0]?.textContent;
    expect(ledger()).toContain('0 (calm)');
    act(() => {
      vi.advanceTimersByTime(32_000);
    });
    expect(ledger()).toContain('4 (dark)');
    expect(spies.fetchImpl).not.toHaveBeenCalled();
    cleanup();
    render(<Header status="live" />);
    expect(screen.getByText('Connection: live')).toBeTruthy();
    expect(screen.queryByText('Demo data, not live')).toBeNull();
  });
});
