import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App.js';
import { FALLBACK_TEXT, SceneMount, type CanvasLoader } from './SceneMount.js';
import { usePrefersReducedMotion } from '../scene/hooks.js';
import type { RendererCallbacks } from '../scene/SceneCanvas.js';
import type { SceneRenderer } from '../scene/renderer.js';
import { SceneInitError } from '../scene/surface.js';
import { toSceneModel } from '../scene/model.js';
import { SAMPLE_SERVICES, eventSourceRegistry, fakeFetch, flush } from '../test/fakes.js';

// The real SceneCanvas is used, but it must not load PixiJS in jsdom.
vi.mock('../scene/pixi-surface.js', () => ({ PixiSurface: class {} }));

class FakeResizeObserver {
  constructor(private readonly cb: ResizeObserverCallback) {}
  observe(): void {
    this.cb([{ contentRect: { width: 800, height: 500 } } as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
  unobserve(): void {}
  disconnect(): void {}
}

function fakeRenderer(over: Partial<Record<'start', () => Promise<void>>> = {}) {
  const r = {
    start: vi.fn<SceneRenderer['start']>(over.start ?? (() => Promise.resolve())),
    update: vi.fn(),
    resize: vi.fn(),
    select: vi.fn(),
    destroy: vi.fn(),
    stats: { frameMs: 16, particles: 0, quality: 'full' as const, frames: 0 },
  };
  return r satisfies SceneRenderer;
}

const model = (reduced = false) => toSceneModel(SAMPLE_SERVICES, Date.parse('2026-11-13T10:00:00.000Z'), { reducedMotion: reduced, quality: 'full' });
const realLoader: CanvasLoader = () => import('../scene/SceneCanvas.js');

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('SceneMount', () => {
  it('shows the text summary at once while the scene chunk loads, and the region is never empty', async () => {
    const m = model();
    render(<SceneMount services={SAMPLE_SERVICES} model={m} selected={null} loadCanvas={() => new Promise(() => undefined)} />);
    const region = screen.getByRole('region', { name: 'House scene' });
    expect(region.childElementCount).toBeGreaterThan(0);
    expect(region.textContent).toContain(m.summary);
    await waitFor(() => expect(region.style.height).not.toBe(''));
    expect(region.textContent).toContain('payments: dark');
  });

  it('draws the canvas with the summary as its label, and updates, resizes, selects and destroys the renderer', async () => {
    const renderer = fakeRenderer();
    const m = model();
    const view = render(
      <SceneMount services={SAMPLE_SERVICES} model={m} selected={null} loadCanvas={realLoader} createRenderer={() => renderer} />,
    );
    const img = await screen.findByRole('img');
    expect(img.getAttribute('aria-label')).toBe(m.summary);
    await waitFor(() => expect(renderer.start).toHaveBeenCalledTimes(1));
    expect(renderer.start.mock.calls[0]?.[0]).toMatchObject({ host: expect.any(HTMLElement), layout: expect.objectContaining({ width: 800, height: 500 }) });

    const next = model(true);
    view.rerender(<SceneMount services={SAMPLE_SERVICES} model={next} selected="payments" loadCanvas={realLoader} createRenderer={() => renderer} />);
    await waitFor(() => expect(renderer.update).toHaveBeenLastCalledWith(next));
    expect(renderer.select).toHaveBeenLastCalledWith('payments');
    expect(screen.getByRole('img').getAttribute('aria-label')).toBe(next.summary);

    view.unmount();
    expect(renderer.destroy).toHaveBeenCalledTimes(1);
  });

  it('shows the fallback message when the chunk fails to load, with no canvas and no empty region', async () => {
    const loader: CanvasLoader = () => Promise.reject(new Error('offline'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(<SceneMount services={SAMPLE_SERVICES} model={model()} selected={null} loadCanvas={loader} />);
    expect(await screen.findByText(FALLBACK_TEXT)).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByRole('region', { name: 'House scene' }).childElementCount).toBeGreaterThan(0);
  });

  it('shows the fallback message when the renderer cannot start (SceneInitError)', async () => {
    const renderer = fakeRenderer({ start: () => Promise.reject(new SceneInitError('webgl')) });
    render(<SceneMount services={SAMPLE_SERVICES} model={model()} selected={null} loadCanvas={realLoader} createRenderer={() => renderer} />);
    expect(await screen.findByText(FALLBACK_TEXT)).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull();
    expect(renderer.destroy).toHaveBeenCalled();
  });

  it('ignores a failure or a callback from the renderer of a canvas that is gone', async () => {
    let callbacks!: RendererCallbacks;
    let reject!: (e: unknown) => void;
    const renderer = fakeRenderer({
      start: () =>
        new Promise<void>((_, r) => {
          reject = r;
        }),
    });
    const onQuality = vi.fn();
    const view = render(
      <SceneMount
        services={SAMPLE_SERVICES}
        model={model()}
        selected={null}
        onQuality={onQuality}
        loadCanvas={realLoader}
        createRenderer={(c) => {
          callbacks = c;
          return renderer;
        }}
      />,
    );
    await waitFor(() => expect(renderer.start).toHaveBeenCalledTimes(1));
    view.unmount();
    expect(renderer.destroy).toHaveBeenCalledTimes(1);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await act(async () => {
      reject(new SceneInitError('webgl'));
      callbacks.onQuality('low');
      callbacks.onContext('lost');
      await flush();
    });
    expect(onQuality).not.toHaveBeenCalled();
    // No state update on an unmounted tree, so React has nothing to warn about.
    expect(errors).not.toHaveBeenCalled();
  });

  it('shows the message at once when the context is lost and removes it when restored', async () => {
    let callbacks!: RendererCallbacks;
    const renderer = fakeRenderer();
    render(
      <SceneMount
        services={SAMPLE_SERVICES}
        model={model()}
        selected={null}
        loadCanvas={realLoader}
        createRenderer={(c) => {
          callbacks = c;
          return renderer;
        }}
      />,
    );
    await screen.findByRole('img');
    act(() => callbacks.onContext('lost'));
    expect(screen.getByText(FALLBACK_TEXT)).toBeTruthy();
    expect(screen.getByRole('region', { name: 'House scene' }).childElementCount).toBeGreaterThan(0);
    act(() => callbacks.onContext('restored'));
    expect(screen.queryByText(FALLBACK_TEXT)).toBeNull();
    expect(screen.getByRole('img')).toBeTruthy();
  });

  it('passes the low power quality up, and the app builds the model with it', async () => {
    let callbacks!: RendererCallbacks;
    const renderer = fakeRenderer();
    const es = eventSourceRegistry();
    render(
      <App
        client={{ baseUrl: 'http://api.test', createEventSource: es.factory, fetchImpl: fakeFetch().impl }}
        scene={{
          loadCanvas: realLoader,
          createRenderer: (c) => {
            callbacks = c;
            return renderer;
          },
        }}
      />,
    );
    await act(async () => {
      es.latest().connect();
      await flush();
    });
    await waitFor(() => expect(renderer.start).toHaveBeenCalled());
    const first = renderer.update.mock.calls.at(-1)?.[0] as ReturnType<typeof model> | undefined;
    expect(first?.quality ?? 'full').toBe('full');
    act(() => callbacks.onQuality('low'));
    await waitFor(() => expect((renderer.update.mock.calls.at(-1)?.[0] as ReturnType<typeof model>).quality).toBe('low'));
  });
});

describe('usePrefersReducedMotion', () => {
  function stubMedia(initial: boolean) {
    let matches = initial;
    const listeners = new Set<() => void>();
    vi.stubGlobal('matchMedia', () => ({
      get matches() {
        return matches;
      },
      addEventListener: (_: string, l: () => void) => listeners.add(l),
      removeEventListener: (_: string, l: () => void) => listeners.delete(l),
    }));
    return {
      set(value: boolean) {
        matches = value;
        for (const l of [...listeners]) l();
      },
      get listeners() {
        return listeners.size;
      },
    };
  }

  it('reads the setting at start and follows changes', () => {
    const media = stubMedia(false);
    const { result, unmount } = renderHook(() => usePrefersReducedMotion());
    expect(result.current).toBe(false);
    act(() => media.set(true));
    expect(result.current).toBe(true);
    act(() => media.set(false));
    expect(result.current).toBe(false);
    unmount();
    expect(media.listeners).toBe(0);
  });

  it('starts true when the user asked for reduced motion, and is false without matchMedia', () => {
    stubMedia(true);
    expect(renderHook(() => usePrefersReducedMotion()).result.current).toBe(true);
    vi.unstubAllGlobals();
    vi.stubGlobal('matchMedia', undefined);
    expect(renderHook(() => usePrefersReducedMotion()).result.current).toBe(false);
  });
});
