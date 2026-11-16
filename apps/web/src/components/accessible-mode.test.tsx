import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App.js';
import { STORAGE_KEY } from '../a11y/mode.js';
import { SAMPLE_SERVICES, eventSourceRegistry, fakeFetch, flush } from '../test/fakes.js';
import type { CanvasLoader } from './SceneMount.js';

vi.mock('../scene/pixi-surface.js', () => ({ PixiSurface: class {} }));
vi.mock('../net/api.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchHuntDetail: vi.fn(async () => ({ service: 'payments' })),
}));

class FakeResizeObserver {
  constructor(private readonly cb: ResizeObserverCallback) {}
  observe(): void {
    this.cb([{ contentRect: { width: 800, height: 500 } } as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
  unobserve(): void {}
  disconnect(): void {}
}

export const DEMO = { kind: 'scenario', name: 'payments-haunted' } as const;
const CLIENT = { baseUrl: 'http://api.test' };

export function fakeRenderer() {
  return { start: vi.fn(() => Promise.resolve()), update: vi.fn(), resize: vi.fn(), select: vi.fn(), destroy: vi.fn(), stats: { frameMs: 16, particles: 0, quality: 'full' as const, frames: 0 } };
}
export function setUrl(search: string, path = '/'): void {
  window.history.pushState({}, '', `${path}${search}`);
}
export function stubReducedMotion(reduced: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: reduced, media: query, addEventListener: () => undefined, removeEventListener: () => undefined }));
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  setUrl('');
});

/** An app in Demo mode with a spy on the scene chunk loader and one renderer double per scene. */
function mount() {
  const loadCanvas = vi.fn<CanvasLoader>(() => import('../scene/SceneCanvas.js'));
  const renderers: ReturnType<typeof fakeRenderer>[] = [];
  const createRenderer = () => {
    const r = fakeRenderer();
    renderers.push(r);
    return r;
  };
  render(<App client={CLIENT} demo={DEMO} scene={{ loadCanvas, createRenderer }} />);
  return { loadCanvas, renderers };
}
const sw = () => screen.getByRole('button', { name: 'Accessible mode' });
const sceneRegion = () => screen.queryByRole('region', { name: 'House scene' });

describe('the Switch and the mode preference', () => {
  it('is the first control after the skip link, a button with aria-pressed, in the header', () => {
    mount();
    const focusable = [...document.querySelectorAll<HTMLElement>('a[href], button, [tabindex="0"]')];
    expect(focusable[0]?.textContent).toBe('Skip to services');
    expect(focusable[1]).toBe(sw());
    expect(sw().getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('banner').contains(sw())).toBe(true);
  });
  it('starts in Accessible mode with ?mode=accessible: no Scene, no loader call, no canvas', async () => {
    setUrl('?mode=accessible');
    const { loadCanvas } = mount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(sw().getAttribute('aria-pressed')).toBe('true');
    expect(loadCanvas).not.toHaveBeenCalled();
    expect(sceneRegion()).toBeNull();
    expect(document.querySelector('canvas')).toBeNull();
    expect(document.documentElement.dataset['a11y']).toBe('on');
  });
  it('turns on with Reduced motion when nothing is saved, and a saved off wins', () => {
    stubReducedMotion(true);
    mount();
    expect(sw().getAttribute('aria-pressed')).toBe('true');
    cleanup();
    window.localStorage.setItem(STORAGE_KEY, '{"mode":"off"}');
    mount();
    expect(sw().getAttribute('aria-pressed')).toBe('false');
    expect(sceneRegion()).not.toBeNull();
  });
  it('lets ?mode=scene win for the session without touching the saved choice', () => {
    window.localStorage.setItem(STORAGE_KEY, '{"mode":"on"}');
    setUrl('?mode=scene');
    mount();
    expect(sw().getAttribute('aria-pressed')).toBe('false');
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('{"mode":"on"}');
  });
  it('works when storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('full');
    });
    mount();
    expect(sw().getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(sw());
    expect(sw().getAttribute('aria-pressed')).toBe('true');
    vi.restoreAllMocks();
  });
  it('saves the press, and toggling off mounts the Scene once, toggling on destroys it once', async () => {
    setUrl('?mode=accessible');
    const { loadCanvas, renderers } = mount();
    fireEvent.click(sw());
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('{"mode":"off"}');
    await screen.findByRole('img');
    expect(loadCanvas).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(renderers).toHaveLength(1));
    await waitFor(() => expect(renderers[0]?.start).toHaveBeenCalledTimes(1));
    fireEvent.click(sw());
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe('{"mode":"on"}');
    expect(renderers[0]?.destroy).toHaveBeenCalledTimes(1);
    expect(sceneRegion()).toBeNull();
    expect(document.querySelector('canvas')).toBeNull();
    expect(document.documentElement.dataset['a11y']).toBe('on');
  });
});

describe('structure in Accessible mode', () => {
  it('has a banner, one main, one h1, headings without a skipped level, and a captioned table', () => {
    setUrl('?mode=accessible');
    mount();
    expect(screen.getByRole('banner')).toBeTruthy();
    expect(screen.getAllByRole('main')).toHaveLength(1);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    const levels = screen.getAllByRole('heading').map((h) => Number(h.tagName.slice(1)));
    expect(levels[0]).toBe(1);
    levels.forEach((l, i) => i > 0 && expect(l).toBeLessThanOrEqual((levels[i - 1] as number) + 1));
    expect(screen.getByRole('table').querySelector('caption')).not.toBeNull();
    expect(screen.queryByRole('navigation')).toBeNull();
  });
  it('moves focus to the table with the skip link', () => {
    mount();
    fireEvent.click(screen.getByRole('link', { name: 'Skip to services' }));
    expect(document.activeElement?.id).toBe('services');
  });
  it('shows the demo table with no Scene for ?demo and ?mode=accessible together', () => {
    setUrl('?demo=payments-haunted&mode=accessible');
    const { loadCanvas } = mount();
    expect(screen.getByText('Demo data, not live')).toBeTruthy();
    expect(screen.getByRole('row', { name: /payments/ }).textContent).toContain('2 (haunted)');
    expect(loadCanvas).not.toHaveBeenCalled();
  });
});

/** Each wait polls up to this long (the default of 1 s is too short for a loaded machine); the test has 30 s in all. */
const WAIT = 5000;
describe('Property 8: Accessible mode never loads or leaves the Scene', () => {
  // Feature: accessible-mode, Property 8
  it('loads and mounts only while off, and destroys one renderer per mounted Scene', async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), fc.integer({ min: 0, max: 5 }), async (startAccessible, presses) => {
        // Each run starts from nothing: no saved mode, no earlier tree, no leftover timers.
        cleanup();
        window.localStorage.clear();
        setUrl(startAccessible ? '?mode=accessible' : '');
        try {
          const { loadCanvas, renderers } = mount();
          let accessible = startAccessible;
          let mounted = 0;
          // The canvas shows before its effect makes the renderer, so wait for the renderer itself.
          const sceneUp = async (): Promise<void> => {
            await screen.findByRole('img', undefined, { timeout: WAIT });
            mounted += 1;
            await waitFor(() => expect(renderers).toHaveLength(mounted), { timeout: WAIT });
          };
          if (!accessible) await sceneUp();
          for (let i = 0; i < presses; i++) {
            fireEvent.click(sw());
            accessible = !accessible;
            if (accessible) {
              expect(sceneRegion()).toBeNull();
              expect(document.querySelector('canvas')).toBeNull();
              await waitFor(() => expect(renderers.filter((r) => r.destroy.mock.calls.length === 1)).toHaveLength(mounted), { timeout: WAIT });
            } else {
              await sceneUp();
            }
          }
          // The chunk loader is the same function for every Scene, and is called once per loader.
          expect(loadCanvas.mock.calls.length).toBeLessThanOrEqual(1);
          if (startAccessible && presses === 0) expect(loadCanvas).not.toHaveBeenCalled();
          expect(renderers).toHaveLength(mounted);
          for (const r of renderers) expect(r.destroy.mock.calls.length).toBeLessThanOrEqual(1);
        } finally {
          cleanup();
        }
      }),
      { numRuns: 12 },
    );
  }, 30_000);
});

describe('focus', () => {
  const rowButton = (name: string): HTMLElement => screen.getByRole('button', { name });
  it('returns focus to the row that opened the detail on Escape', () => {
    setUrl('?mode=accessible');
    mount();
    rowButton('payments').focus();
    fireEvent.click(rowButton('payments'));
    expect(screen.getByRole('row', { name: /payments/ }).getAttribute('aria-current')).toBe('true');
    expect(screen.getByRole('heading', { name: 'Hunt on payments' })).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('heading', { name: 'Hunt on payments' })).toBeNull();
    expect(document.activeElement).toBe(rowButton('payments'));
  });
  it('opens the detail and focuses the row for a /hunts/<id> link', async () => {
    setUrl('?mode=accessible', '/hunts/cmhuntaaaaaaaaaaaaaaaaaa1');
    const es = eventSourceRegistry();
    render(<App client={{ baseUrl: 'http://api.test', createEventSource: es.factory, fetchImpl: fakeFetch(() => SAMPLE_SERVICES).impl }} />);
    await act(async () => {
      es.latest().connect();
      await flush();
    });
    await waitFor(() => expect(document.activeElement).toBe(rowButton('payments')));
    expect(screen.getByRole('row', { name: /payments/ }).getAttribute('aria-current')).toBe('true');
    expect(screen.getByRole('heading', { name: 'Hunt on payments' })).toBeTruthy();
  });
  it('drops a deep-link focus request made in scene mode, so a later switch does not take focus', async () => {
    setUrl('', '/hunts/cmhuntaaaaaaaaaaaaaaaaaa1');
    const es = eventSourceRegistry();
    const scene = { loadCanvas: () => import('../scene/SceneCanvas.js'), createRenderer: () => fakeRenderer() };
    render(<App client={{ baseUrl: 'http://api.test', createEventSource: es.factory, fetchImpl: fakeFetch(() => SAMPLE_SERVICES).impl }} scene={scene} />);
    await act(async () => {
      es.latest().connect();
      await flush();
    });
    await waitFor(() => expect(screen.getByRole('row', { name: /payments/ }).getAttribute('aria-current')).toBe('true'));
    sw().focus();
    fireEvent.click(sw());
    expect(sw().getAttribute('aria-pressed')).toBe('true');
    expect(document.activeElement).toBe(sw());
  });
});
