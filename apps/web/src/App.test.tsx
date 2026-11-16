import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { Header } from './components/Header.js';
import { TableMode } from './components/TableMode.js';
import { SAMPLE_SERVICES, eventSourceRegistry, fakeFetch, flush } from './test/fakes.js';

const LIVE = '[aria-live], [role=status], [role=alert], [role=log]';
const region = (): HTMLElement => screen.getByTestId('level-announcer');
class FakeResizeObserver {
  constructor(private readonly cb: ResizeObserverCallback) {}
  observe(): void {
    this.cb([{ contentRect: { width: 800, height: 500 } } as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
  unobserve(): void {}
  disconnect(): void {}
}
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  window.history.pushState({}, '', '/');
});

describe('Header', () => {
  it('shows the status as plain text and is not a live region', () => {
    const { container } = render(<Header status="offline" />);
    expect(screen.getByText('Connection: offline')).toBeTruthy();
    expect(container.querySelectorAll(LIVE)).toHaveLength(0);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Haunted Ops');
  });
});

describe('TableMode', () => {
  it('lists each service with its haunt level as text', () => {
    render(<TableMode services={SAMPLE_SERVICES} />);
    const rows = within(screen.getByRole('table')).getAllByRole('row');
    expect(rows).toHaveLength(5);
    expect(rows[3]?.textContent).toContain('payments');
    expect(rows[3]?.textContent).toContain('4 (dark)');
    expect(rows[3]?.textContent).toContain('no data');
  });
});

describe('App', () => {
  it('renders the shell and fills the table from GET /api/services once live', async () => {
    const es = eventSourceRegistry();
    const http = fakeFetch();
    render(<App client={{ baseUrl: 'http://api.test', createEventSource: es.factory, fetchImpl: http.impl }} />);
    expect(screen.getByText('Connection: reconnecting')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'House scene' })).toBeTruthy();
    await act(async () => {
      es.latest().connect();
      await flush();
    });
    expect(screen.getByText('Connection: live')).toBeTruthy();
    expect(screen.getAllByRole('row')).toHaveLength(5);
    expect(http.urls).toEqual(['http://api.test/api/services']);
    expect(http.statusUrls).toEqual(['http://api.test/api/ingest/status']);
    expect(screen.queryByText(/Metrics are stale/)).toBeNull();
  });

  it('shows the stale notice from the loaded status and announces a level change from the stream', async () => {
    const es = eventSourceRegistry();
    const http = fakeFetch(undefined, () => ({
      state: 'stale',
      at: '2026-11-12T10:00:30.000Z',
      lastSuccessAt: '2026-11-12T10:00:05.000Z',
    }));
    render(<App client={{ baseUrl: 'http://api.test', createEventSource: es.factory, fetchImpl: http.impl }} />);
    await act(async () => {
      es.latest().connect();
      await flush();
    });
    expect(screen.getByText('Metrics are stale. Last update 10:00:05 UTC.')).toBeTruthy();
    const gate = { ...SAMPLE_SERVICES[0]!, hauntLevel: 2 as const, updatedAt: '2026-11-12T10:00:40.000Z' };
    await act(async () => {
      es.latest().emit('service.updated', { service: gate, previousLevel: 0 }, 'a1b2c3d4e5f6-1');
      await flush();
    });
    expect(screen.getByTestId('level-announcer').textContent).toBe('gate: haunted');
    expect(within(screen.getByRole('table')).getAllByRole('row')[1]?.textContent).toContain('2 (haunted)');
  });
});
describe('one live region in the whole app', () => {
  const demo = { kind: 'scenario', name: 'payments-haunted' } as const;
  const failing = { loadCanvas: () => Promise.reject(new Error('offline')) };
  it.each([
    ['the scene', ''],
    ['Accessible mode', '?mode=accessible'],
  ])('has exactly one in %s', (_name, search) => {
    window.history.pushState({}, '', `/${search}`);
    render(<App client={{ baseUrl: 'http://api.test' }} demo={demo} />);
    expect(document.querySelectorAll(LIVE)).toHaveLength(1);
  });
  it('has exactly one with the scene fallback shown, and says it once', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(<App client={{ baseUrl: 'http://api.test' }} demo={demo} scene={failing} />);
    // The text comes after a frame (the size of the mount), the failed load and the error boundary: a loaded machine needs more than the default 1 s of polling.
    await screen.findAllByText(/The house view is not available/, undefined, { timeout: 8000 });
    expect(document.querySelectorAll(LIVE)).toHaveLength(1);
    await waitFor(() => expect(region().textContent).toContain('The house view is not available'), { timeout: 8000 });
  });
  it('has exactly one while live and stale, and says connection and stale changes but not the first load', async () => {
    const es = eventSourceRegistry();
    const http = fakeFetch(undefined, () => ({ state: 'stale', at: '2026-11-12T10:00:30.000Z', lastSuccessAt: '2026-11-12T10:00:05.000Z' }));
    window.history.pushState({}, '', '/?mode=accessible');
    render(<App client={{ baseUrl: 'http://api.test', createEventSource: es.factory, fetchImpl: http.impl }} />);
    await act(async () => {
      es.latest().connect();
      await flush();
    });
    expect(screen.getByText('Metrics are stale. Last update 10:00:05 UTC.').closest(LIVE)).toBeNull();
    expect(document.querySelectorAll(LIVE)).toHaveLength(1);
    // The first connection is silent; the stale state at first load is silent too.
    expect(region().textContent).toBe('');
    await act(async () => {
      es.latest().emit('ingest.status', { state: 'ok', at: '2026-11-12T10:01:00.000Z', lastSuccessAt: '2026-11-12T10:01:00.000Z' }, 'a1b2c3d4e5f6-1');
      await flush();
    });
    await waitFor(() => expect(region().textContent).toBe('Metrics are fresh again.'));
    act(() => es.latest().fail());
    // One sentence per 2 s: the connection sentence waits its turn.
    await waitFor(() => expect(region().textContent).toBe('Connection: reconnecting.'), { timeout: 3000 });
  });
});
