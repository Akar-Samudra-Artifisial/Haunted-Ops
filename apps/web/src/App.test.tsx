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
  });
});
