import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App, replayRouteFromPath } from '../App.js';
import { announcementsFor } from '../components/LiveAnnouncer.js';
import { syntheticReplay } from './fixture.js';
import ReplayApp from './ReplayApp.js';
import { stateAt, timeline } from './player.js';
const file = syntheticReplay();
class FakeResizeObserver {
  constructor(private readonly cb: ResizeObserverCallback) {}
  observe(): void {
    this.cb([{ contentRect: { width: 800, height: 500 } } as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
  unobserve(): void {}
  disconnect(): void {}
}
const stubMotion = (reduce: boolean): void => {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: reduce && query.includes('reduce'), media: query, addEventListener: () => undefined, removeEventListener: () => undefined }));
};
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
interface Net {
  urls: string[];
  eventSources: string[];
  client: { baseUrl: string; createEventSource: (url: string) => never; fetchImpl: (url: string) => Promise<Response> };
}
function net(answer: (url: string) => Response | Promise<Response>): Net {
  const urls: string[] = [];
  const eventSources: string[] = [];
  return {
    urls,
    eventSources,
    client: {
      baseUrl: 'http://api.test',
      createEventSource: (url: string) => {
        eventSources.push(url);
        throw new Error('no stream on a replay');
      },
      fetchImpl: async (url: string) => {
        urls.push(url);
        return answer(url);
      },
    },
  };
}
const play = (id: string, n: Net) => <ReplayApp route={{ kind: 'play', id }} client={n.client} Shell={App} />;
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  stubMotion(true);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});
describe('replayRouteFromPath', () => {
  it('reads /replays and /replays/<id> and nothing else', () => {
    expect(replayRouteFromPath('/replays')).toEqual({ kind: 'list' });
    expect(replayRouteFromPath('/replays/')).toEqual({ kind: 'list' });
    expect(replayRouteFromPath('/replays/synthetic-error-spike')).toEqual({ kind: 'play', id: 'synthetic-error-spike' });
    for (const p of ['/', '/hunts/abc', '/replays/ab', '/replays/Abc', '/replays/a/b', '/replay/abc', '/replays/x_y_z']) expect(replayRouteFromPath(p), p).toBeNull();
  });
});
describe('the list', () => {
  it('lists the replays as links', async () => {
    const n = net(() => json([{ id: 'synthetic-error-spike', title: file.title, scenario: 'error-spike', recordedOn: '2026-11-15', durationMs: file.durationMs }]));
    render(<ReplayApp route={{ kind: 'list' }} client={n.client} Shell={App} />);
    const link = await screen.findByRole('link', { name: file.title });
    expect(link.getAttribute('href')).toBe('/replays/synthetic-error-spike');
    expect(n.urls).toEqual(['http://api.test/api/replays']);
    expect(screen.getByRole('link', { name: 'Back to live' })).toBeTruthy();
  });
  it('says so when there is none, and when the API is down', async () => {
    render(<ReplayApp route={{ kind: 'list' }} client={net(() => json([])).client} Shell={App} />);
    expect(await screen.findByText('There is no replay yet.')).toBeTruthy();
    cleanup();
    render(<ReplayApp route={{ kind: 'list' }} client={net(() => Promise.reject(new Error('down'))).client} Shell={App} />);
    expect((await screen.findByRole('alert')).textContent).toContain('cannot be loaded');
  });
});
describe('errors', () => {
  it('a 404 says the replay does not exist and links to the list', async () => {
    render(play('nothing-here', net(() => json({ error: 'not_found' }, 404))));
    expect(await screen.findByRole('heading', { name: 'This replay does not exist' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'See the replays' }).getAttribute('href')).toBe('/replays');
  });
  it('an API that is down, a 500 or an invalid file give a plain message and no crash', async () => {
    for (const answer of [() => Promise.reject(new Error('down')), () => new Response('', { status: 500 }), () => json({ nope: 1 }), () => json({ ...file, review: null })]) {
      render(play('synthetic-error-spike', net(answer)));
      expect((await screen.findByRole('alert')).textContent).toContain('cannot be loaded');
      cleanup();
    }
  });
  it('an id that cannot exist is not requested', async () => {
    const n = net(() => json(file));
    render(play('Bad_Id', n));
    expect(await screen.findByRole('heading', { name: 'This replay does not exist' })).toBeTruthy();
    expect(n.urls).toEqual([]);
  });
});
describe('the player page', () => {
  async function open(): Promise<Net> {
    const n = net(() => json(file));
    render(play('synthetic-error-spike', n));
    await screen.findByRole('button', { name: 'Play' });
    return n;
  }
  it('is the one state path: no stream, no live fetch, the banner on the page and in the table caption', async () => {
    const n = await open();
    expect(n.urls).toEqual(['http://api.test/api/replays/synthetic-error-spike']);
    expect(n.eventSources).toEqual([]);
    expect(screen.getByText('Replay of 2026-11-15, not live')).toBeTruthy();
    expect(screen.getByRole('table').querySelector('caption')?.textContent).toContain('Replay of 2026-11-15, not live');
    expect(screen.queryByText(/Connection:/)).toBeNull();
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(5);
  });
  it('starts paused with reduced motion, and playing without it', async () => {
    await open();
    expect(screen.getByRole('button', { name: 'Play' }).getAttribute('aria-pressed')).toBe('false');
    cleanup();
    stubMotion(false);
    window.localStorage.setItem('haunted-ops.a11y.v1', JSON.stringify({ mode: 'off' }));
    await open();
    expect(screen.getByRole('button', { name: 'Play' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    expect(screen.getByRole('button', { name: 'Play' }).getAttribute('aria-pressed')).toBe('false');
  });
  it('starts paused in Accessible mode even without reduced motion', async () => {
    stubMotion(false);
    window.localStorage.setItem('haunted-ops.a11y.v1', JSON.stringify({ mode: 'on' }));
    await open();
    expect(screen.getByRole('button', { name: 'Play' }).getAttribute('aria-pressed')).toBe('false');
  });
  it('has labelled controls: speed, steps, the position range with its words, and a way back to live', async () => {
    await open();
    for (const name of ['Previous frame', 'Next frame', '1×', '2×', '4×']) expect(screen.getByRole('button', { name })).toBeTruthy();
    expect(screen.getByRole('button', { name: '1×' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: '4×' }));
    expect(screen.getByRole('button', { name: '4×' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: '1×' }).getAttribute('aria-pressed')).toBe('false');
    const range = screen.getByRole('slider', { name: /Position/ });
    expect(range.getAttribute('aria-valuetext')).toBe(`0 s of 3 min 20 s`);
    expect(screen.getByRole('link', { name: 'Back to live' }).getAttribute('href')).toBe('/');
  });
  it('steps and seeks: the table shows the state of the frame reached', async () => {
    await open();
    const range = screen.getByRole('slider', { name: /Position/ });
    fireEvent.change(range, { target: { value: String(file.durationMs) } });
    expect(range.getAttribute('aria-valuetext')).toBe('3 min 20 s of 3 min 20 s');
    const states = timeline(file.frames);
    const end = stateAt(states, file.frames, file.durationMs);
    expect(end.hunt?.status).toBe('succeeded');
    await waitFor(() => expect(screen.getAllByTestId('fix-cell').some((c) => /deployed/i.test(c.textContent ?? ''))).toBe(true));
    fireEvent.change(range, { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Next frame' }));
    expect(range.getAttribute('aria-valuetext')).toBe('5 s of 3 min 20 s');
    fireEvent.click(screen.getByRole('button', { name: 'Previous frame' }));
    expect(range.getAttribute('aria-valuetext')).toBe('0 s of 3 min 20 s');
  });
  it('a jump says the state reached once: the sentences are those of the net change', async () => {
    await open();
    const states = timeline(file.frames);
    const first = stateAt(states, file.frames, 0);
    const reached = stateAt(states, file.frames, 110_000);
    const expected = announcementsFor(first.services, reached.services);
    expect(expected.urgent.length).toBeGreaterThan(0);
    const region = screen.getByTestId('level-announcer');
    await act(async () => {
      fireEvent.change(screen.getByRole('slider', { name: /Position/ }), { target: { value: '110000' } });
    });
    await waitFor(() => expect(region.textContent).toBe(expected.urgent[0]));
    expect(region.textContent).not.toBe('');
  });
  it('the detail of a finished hunt comes from the frame, not from the API', async () => {
    const n = await open();
    fireEvent.change(screen.getByRole('slider', { name: /Position/ }), { target: { value: String(file.durationMs) } });
    fireEvent.click(screen.getByRole('button', { name: 'payments' }));
    expect(await screen.findByText(/Cited evidence/)).toBeTruthy();
    expect(n.urls.some((u) => u.includes('/api/hunts/'))).toBe(false);
  });
});
