import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServiceState } from '@haunted-ops/shared';
import { App } from '../App.js';
import { makeService } from '../test/arbs.js';
import { SAMPLE_SERVICES, eventSourceRegistry, fakeFetch, flush } from '../test/fakes.js';
import { house } from '../test/scene-fakes.js';
import { toSceneModel } from '../scene/model.js';
import { SceneMount } from './SceneMount.js';
import { TableMode } from './TableMode.js';

vi.mock('../scene/pixi-surface.js', () => ({ PixiSurface: class {} }));

class FakeResizeObserver {
  constructor(private readonly cb: ResizeObserverCallback) {}
  observe(): void {
    this.cb([{ contentRect: { width: 900, height: 540 } } as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
  unobserve(): void {}
  disconnect(): void {}
}
const never = () => new Promise<never>(() => undefined);

const haunted: ServiceState[] = house({
  payments: {
    hauntLevel: 2,
    reason: { kind: 'error_rate', value: 0.22 },
    metrics: { errorRate: 0.22, p95Ms: 100, up: 1, at: 'x' },
    openIncident: { id: 'i', openedAt: '2026-11-13T10:00:00.000Z', peakLevel: 2 },
  },
});
const model = (services: ServiceState[]) => toSceneModel(services, Date.parse('2026-11-13T10:00:00.000Z'), { reducedMotion: false, quality: 'full' });

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function mountButtons(onSelect = vi.fn(), selected: Parameters<typeof SceneMount>[0]['selected'] = null) {
  render(<SceneMount services={haunted} model={model(haunted)} selected={selected} onSelect={onSelect} loadCanvas={never} />);
  const group = await screen.findByRole('group', { name: 'Rooms' });
  return { onSelect, group, buttons: within(group).getAllByRole('button') };
}

describe('room buttons', () => {
  it('has one button per room in reading order, with the spoken state as its name', async () => {
    const { buttons } = await mountButtons();
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual([
      'gate, calm',
      'orders, calm',
      'payments, haunted, error rate 22%, incident open',
      'ledger, calm',
    ]);
  });

  it('are shaped like the silhouette of the room, so the pointer target is the room', async () => {
    const { buttons } = await mountButtons();
    for (const b of buttons) {
      expect(b.style.clipPath).toMatch(/^polygon\(/);
      expect(parseFloat(b.style.width)).toBeGreaterThan(0);
    }
  });

  it('select the room when focused or clicked', async () => {
    const { onSelect, buttons } = await mountButtons();
    fireEvent.focus(buttons[2]!);
    expect(onSelect).toHaveBeenLastCalledWith('payments');
    fireEvent.click(buttons[3]!);
    expect(onSelect).toHaveBeenLastCalledWith('ledger');
  });

  it('move with the arrow keys to the nearest room, and with Home and End', async () => {
    const { buttons } = await mountButtons();
    buttons[0]!.focus();
    fireEvent.keyDown(buttons[0]!, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(buttons[1]);
    fireEvent.keyDown(buttons[1]!, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(buttons[2]);
    fireEvent.keyDown(buttons[2]!, { key: 'End' });
    expect(document.activeElement).toBe(buttons[3]);
    fireEvent.keyDown(buttons[3]!, { key: 'Home' });
    expect(document.activeElement).toBe(buttons[0]);
    fireEvent.keyDown(buttons[0]!, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(buttons[0]);
  });

  it('clear the selection on Escape, and mark the selected room as pressed', async () => {
    const { onSelect, buttons } = await mountButtons(vi.fn(), 'orders');
    expect(buttons.map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'true', 'false', 'false']);
    fireEvent.keyDown(buttons[1]!, { key: 'Escape' });
    expect(onSelect).toHaveBeenLastCalledWith(null);
  });

  it('are removed when the scene falls back', async () => {
    render(
      <SceneMount
        services={haunted}
        model={model(haunted)}
        selected={null}
        loadCanvas={() => Promise.reject(new Error('offline'))}
      />,
    );
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await screen.findByText(/not available on this device/);
    expect(screen.queryByRole('group', { name: 'Rooms' })).toBeNull();
  });
});

describe('table selection and dark text', () => {
  it('shows "room dark" for a lit-level service whose up is 0, and plain text otherwise', () => {
    const dark = makeService('ledger', { hauntLevel: 2, metrics: { errorRate: null, p95Ms: null, up: 0, at: 'x' } });
    render(<TableMode services={[dark, makeService('gate', { hauntLevel: 4 })]} />);
    const rows = screen.getAllByRole('row').slice(1);
    expect(within(rows[0]!).getAllByRole('cell')[0]?.textContent).toContain('2 (haunted), room dark');
    expect(within(rows[0]!).getAllByRole('cell')[0]?.textContent).not.toContain('4 (dark)');
    expect(within(rows[1]!).getAllByRole('cell')[0]?.textContent).toContain('4 (dark)');
    expect(rows[0]!.getAttribute('data-room-state')).toBe('dark');
  });

  it('marks the selected row with aria-current, a marker and a pressed name button', () => {
    const onSelect = vi.fn();
    render(<TableMode services={SAMPLE_SERVICES} selected="orders" onSelect={onSelect} />);
    const row = screen.getByRole('row', { name: /orders/ });
    expect(row.getAttribute('aria-current')).toBe('true');
    expect(row.textContent).toContain('▶');
    expect(screen.getAllByRole('row').filter((r) => r.getAttribute('aria-current') === 'true')).toHaveLength(1);
    const button = within(row).getByRole('button', { name: 'orders' });
    expect(button.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(button);
    expect(onSelect).toHaveBeenLastCalledWith(null);
    fireEvent.click(within(screen.getByRole('row', { name: /payments/ })).getByRole('button', { name: 'payments' }));
    expect(onSelect).toHaveBeenLastCalledWith('payments');
  });

  it('scrolls the selected row into view', () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const { rerender } = render(<TableMode services={SAMPLE_SERVICES} selected={null} />);
    rerender(<TableMode services={SAMPLE_SERVICES} selected="ledger" />);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
    // @ts-expect-error restore the jsdom default
    delete Element.prototype.scrollIntoView;
  });
});

describe('selection stays in step between the scene and the table', () => {
  async function mountApp() {
    const es = eventSourceRegistry();
    const services = house({ payments: { hauntLevel: 2 } });
    render(<App client={{ baseUrl: 'http://api.test', createEventSource: es.factory, fetchImpl: fakeFetch(() => services).impl }} scene={{ loadCanvas: never }} />);
    await act(async () => {
      es.latest().connect();
      await flush();
    });
    return screen.findByRole('group', { name: 'Rooms' });
  }
  const row = (name: string) => screen.getByRole('row', { name: new RegExp(`^(▶ )?${name}`) });

  it('selecting a room selects its row, and selecting a row selects its room', async () => {
    const group = await mountApp();
    const room = (name: string) => within(group).getByRole('button', { name: new RegExp(`^${name}`) });
    fireEvent.focus(room('payments'));
    await waitFor(() => expect(row('payments').getAttribute('aria-current')).toBe('true'));
    expect(room('payments').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(within(row('orders')).getByRole('button', { name: 'orders' }));
    await waitFor(() => expect(row('orders').getAttribute('aria-current')).toBe('true'));
    expect(room('orders').getAttribute('aria-pressed')).toBe('true');
    expect(room('payments').getAttribute('aria-pressed')).toBe('false');
    expect(row('payments').getAttribute('aria-current')).toBeNull();
  });

  it('clears both views with Escape', async () => {
    const group = await mountApp();
    fireEvent.click(within(group).getByRole('button', { name: /^gate/ }));
    await waitFor(() => expect(row('gate').getAttribute('aria-current')).toBe('true'));
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(row('gate').getAttribute('aria-current')).toBeNull());
    expect(within(group).getByRole('button', { name: /^gate/ }).getAttribute('aria-pressed')).toBe('false');
  });
});

describe('the scene adds no live region', () => {
  it('has no aria-live, status or alert inside the working scene', async () => {
    render(
      <SceneMount
        services={haunted}
        model={model(haunted)}
        selected={null}
        loadCanvas={() => import('../scene/SceneCanvas.js')}
        createRenderer={() => ({
          start: () => Promise.resolve(),
          update: () => undefined,
          resize: () => undefined,
          select: () => undefined,
          destroy: () => undefined,
          stats: { frameMs: 16, particles: 0, quality: 'full', frames: 0 },
        })}
      />,
    );
    await screen.findByRole('img');
    const region = screen.getByRole('region', { name: 'House scene' });
    expect(region.querySelectorAll('[aria-live], [role="status"], [role="alert"]')).toHaveLength(0);
    expect(screen.getByRole('img').getAttribute('aria-label')).toBe(model(haunted).summary);
  });
});
