import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { HauntLevel, ServiceState } from '@haunted-ops/shared';
import { LEVEL_MARKER } from '../format.js';
import { SAMPLE_SERVICES } from '../test/fakes.js';
import { LiveAnnouncer, levelChanges } from './LiveAnnouncer.js';
import { TableMode } from './TableMode.js';

afterEach(() => {
  cleanup();
});

const svc = (over: Partial<ServiceState> & { name: ServiceState['name'] }): ServiceState => ({
  ...(SAMPLE_SERVICES.find((s) => s.name === over.name) as ServiceState),
  ...over,
});

const rowOf = (name: string): HTMLElement => screen.getByRole('row', { name: new RegExp(`^${name}\\b`) });

describe('TableMode', () => {
  it('shows all five levels as number, label and a distinct marker', () => {
    const levels: HauntLevel[] = [0, 1, 2, 3, 4];
    const names = ['gate', 'orders', 'payments', 'ledger'] as const;
    for (const level of levels) {
      cleanup();
      render(<TableMode services={[svc({ name: names[level % 4]!, hauntLevel: level })]} />);
      const cells = within(screen.getAllByRole('row')[1]!).getAllByRole('cell');
      expect(cells[0]?.textContent).toContain(`${level} (`);
      expect(cells[0]?.textContent).toContain(LEVEL_MARKER[level]);
    }
    expect(new Set(Object.values(LEVEL_MARKER)).size).toBe(5);
  });

  it('marks the glyph aria-hidden so the text carries the level', () => {
    render(<TableMode services={SAMPLE_SERVICES} />);
    const marker = rowOf('payments').querySelector('.marker');
    expect(marker?.getAttribute('aria-hidden')).toBe('true');
    expect(rowOf('payments').textContent).toContain('4 (dark)');
  });

  it('shows reason, metrics and the open incident', () => {
    const payments = svc({
      name: 'payments',
      hauntLevel: 2,
      reason: { kind: 'error_rate', value: 0.22 },
      metrics: { errorRate: 0.22, p95Ms: 640, up: 1, at: '2026-11-13T14:02:10.000Z' },
      openIncident: { id: 'i1', openedAt: '2026-11-13T14:02:05.000Z', peakLevel: 2 },
    });
    render(<TableMode services={[payments]} />);
    const cells = within(rowOf('payments')).getAllByRole('cell').map((c) => c.textContent);
    expect(cells).toEqual(['◑ 2 (haunted)', 'error rate 22%', '22%', '640 ms', 'up', 'opened 14:02:05 UTC, peak 2 (haunted)']);
  });

  it('shows the live value of the cause, not only the value stored at the last level change', () => {
    const payments = svc({
      name: 'payments',
      hauntLevel: 2,
      reason: { kind: 'error_rate', value: 0.22 },
      metrics: { errorRate: 0.41, p95Ms: 100, up: 1, at: '2026-11-13T14:02:10.000Z' },
    });
    render(<TableMode services={[payments]} />);
    const cells = within(rowOf('payments')).getAllByRole('cell').map((c) => c.textContent);
    expect(cells[1]).toBe('error rate 41%');
    expect(cells[2]).toBe('41%');
  });

  it('writes "no data" for null metrics and "none" without reason or incident', () => {
    render(<TableMode services={[svc({ name: 'gate', metrics: { errorRate: null, p95Ms: 120, up: null, at: '2026-11-13T14:00:00.000Z' } })]} />);
    const cells = within(rowOf('gate')).getAllByRole('cell').map((c) => c.textContent);
    expect(cells).toEqual(['○ 0 (calm)', 'none', 'no data', '120 ms', 'no data', 'none']);
    cleanup();
    render(<TableMode services={[svc({ name: 'gate', metrics: null })]} />);
    const none = within(rowOf('gate')).getAllByRole('cell').map((c) => c.textContent);
    expect(none.slice(2, 5)).toEqual(['no data', 'no data', 'no data']);
  });

  it('shows the stale notice with the last update and removes it when ok', () => {
    const stale = { state: 'stale' as const, at: '2026-11-13T14:03:00.000Z', lastSuccessAt: '2026-11-13T14:02:10.000Z' };
    const { rerender } = render(<TableMode services={SAMPLE_SERVICES} ingest={stale} />);
    expect(screen.getByRole('status').textContent).toBe('Metrics are stale. Last update 14:02:10 UTC.');
    rerender(<TableMode services={SAMPLE_SERVICES} ingest={{ ...stale, state: 'ok' }} />);
    expect(screen.queryByRole('status')).toBeNull();
    rerender(<TableMode services={SAMPLE_SERVICES} ingest={null} />);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('is a captioned table with column headers and a keyboard-reachable scroll area', () => {
    render(<TableMode services={SAMPLE_SERVICES} />);
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      'Service',
      'Haunt level',
      'Reason',
      'Error ratio',
      'p95',
      'Up',
      'Incident',
    ]);
    expect(screen.getByRole('table').querySelector('caption')).not.toBeNull();
    expect(screen.getByRole('group', { name: /scrollable/ }).getAttribute('tabindex')).toBe('0');
    expect(screen.getAllByRole('rowheader').map((h) => h.textContent)).toEqual(['gate', 'orders', 'payments', 'ledger']);
  });

  it('says "No data yet" when there are no services', () => {
    render(<TableMode services={[]} />);
    expect(screen.getByText('No data yet')).toBeTruthy();
  });
});

describe('LiveAnnouncer', () => {
  const region = (): HTMLElement => screen.getByTestId('level-announcer');

  it('is a polite live region and says nothing on first load', () => {
    render(<LiveAnnouncer services={SAMPLE_SERVICES} />);
    expect(region().getAttribute('aria-live')).toBe('polite');
    expect(region().textContent).toBe('');
  });

  it('is silent while services first appear, then says one short sentence per level change', () => {
    const { rerender } = render(<LiveAnnouncer services={[]} />);
    rerender(<LiveAnnouncer services={SAMPLE_SERVICES} />);
    expect(region().textContent).toBe('');
    act(() => {
      rerender(<LiveAnnouncer services={SAMPLE_SERVICES.map((s) => (s.name === 'payments' ? { ...s, hauntLevel: 2 as const } : s))} />);
    });
    expect(region().textContent).toBe('payments: haunted');
  });

  it('does not repeat itself when nothing changed', () => {
    const changed = SAMPLE_SERVICES.map((s) => (s.name === 'gate' ? { ...s, hauntLevel: 3 as const } : s));
    const { rerender } = render(<LiveAnnouncer services={SAMPLE_SERVICES} />);
    rerender(<LiveAnnouncer services={changed} />);
    expect(region().textContent).toBe('gate: possessed');
    rerender(<LiveAnnouncer services={changed.map((s) => ({ ...s, metrics: { errorRate: 0, p95Ms: 1, up: 1, at: 'x' } }))} />);
    expect(region().textContent).toBe('gate: possessed');
  });

  it('levelChanges lists only real changes', () => {
    const prev = new Map(SAMPLE_SERVICES.map((s) => [s.name, s.hauntLevel] as const));
    expect(levelChanges(prev, SAMPLE_SERVICES)).toEqual([]);
    expect(levelChanges(new Map(), SAMPLE_SERVICES)).toEqual([]);
    expect(levelChanges(prev, [svc({ name: 'ledger', hauntLevel: 4 })])).toEqual(['ledger: dark']);
  });
});
