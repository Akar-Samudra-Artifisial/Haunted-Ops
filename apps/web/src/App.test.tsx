import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App.js';
import { Header } from './components/Header.js';
import { SceneMount } from './components/SceneMount.js';
import { TableMode } from './components/TableMode.js';
import { SAMPLE_SERVICES, eventSourceRegistry, fakeFetch, flush } from './test/fakes.js';

afterEach(() => {
  cleanup();
});

describe('Header', () => {
  it('announces the status as text in a polite live region', () => {
    render(<Header status="offline" />);
    const region = screen.getByRole('status');
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.textContent).toContain('Connection: offline');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Haunted Ops');
  });
});

describe('SceneMount', () => {
  it('is an empty, labelled region', () => {
    render(<SceneMount />);
    const region = screen.getByRole('region', { name: 'House scene' });
    expect(region.childElementCount).toBe(0);
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
    expect(screen.getByRole('status').textContent).toContain('reconnecting');
    expect(screen.getByRole('region', { name: 'House scene' })).toBeTruthy();
    await act(async () => {
      es.latest().connect();
      await flush();
    });
    expect(screen.getByRole('status').textContent).toContain('live');
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
