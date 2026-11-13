// Feature: ingest-haunt-score, Property 14: every table row says the level and the cause in text
import fc from 'fast-check';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { HauntLevel, HauntReason, ServiceState } from '@haunted-ops/shared';
import { LEVEL_MARKER, LEVEL_TEXT, NO_DATA, formatErrorRatio, formatP95, formatReason, formatUp } from '../format.js';
import { SAMPLE_SERVICES } from '../test/fakes.js';
import { TableMode } from './TableMode.js';

const levelArb = fc.constantFrom<HauntLevel>(0, 1, 2, 3, 4);
const iso = fc
  .integer({ min: Date.parse('2026-01-01T00:00:00.000Z'), max: Date.parse('2026-12-31T00:00:00.000Z') })
  .map((ms) => new Date(ms).toISOString());
const nullable = fc.option(fc.double({ min: 0, max: 100_000, noNaN: true }), { nil: null });
const reasonArb: fc.Arbitrary<HauntReason | null> = fc.option(
  fc.record({ kind: fc.constantFrom('error_rate' as const, 'p95' as const, 'down' as const), value: fc.double({ min: 0, max: 100_000, noNaN: true }) }),
  { nil: null },
);

const stateArb: fc.Arbitrary<ServiceState> = fc
  .tuple(
    fc.constantFrom(...SAMPLE_SERVICES),
    levelArb,
    reasonArb,
    fc.option(fc.record({ errorRate: nullable, p95Ms: nullable, up: nullable, at: iso }), { nil: null }),
    fc.option(fc.record({ id: fc.constant('inc'), openedAt: iso, peakLevel: levelArb }), { nil: null }),
  )
  .map(([base, hauntLevel, reason, metrics, openIncident]) => ({ ...base, hauntLevel, reason, metrics, openIncident }));

function rowCells(state: ServiceState): { head: string; cells: string[]; html: string } {
  const html = renderToStaticMarkup(<TableMode services={[state]} />);
  const doc = document.createElement('div');
  doc.innerHTML = html;
  const row = doc.querySelector('tbody tr') as HTMLElement;
  return {
    head: row.querySelector('th')?.textContent ?? '',
    cells: [...row.querySelectorAll('td')].map((c) => c.textContent ?? ''),
    html,
  };
}

describe('Property 14: every table row says the level and the cause in text', () => {
  it('shows level number and label, a marker, the reason text, no data and the incident as text', () => {
    fc.assert(
      fc.property(stateArb, (s) => {
        const { head, cells, html } = rowCells(s);
        expect(head).toBe(s.name);
        expect(cells).toHaveLength(7);
        expect(cells[6]).toBe('none');
        expect(cells[0]).toContain(`${s.hauntLevel} (${LEVEL_TEXT[s.hauntLevel]})`);
        expect(cells[0]).toContain(LEVEL_MARKER[s.hauntLevel]);
        expect(cells[1]).toBe(formatReason(s.reason, s.metrics));
        if (s.reason === null) expect(cells[1]).toBe('none');
        expect(cells[2]).toBe(formatErrorRatio(s.metrics?.errorRate ?? null));
        expect(cells[3]).toBe(formatP95(s.metrics?.p95Ms ?? null));
        expect(cells[4]).toBe(formatUp(s.metrics?.up ?? null));
        if (s.metrics === null) expect(cells.slice(2, 5)).toEqual([NO_DATA, NO_DATA, NO_DATA]);
        if (s.metrics?.errorRate === null) expect(cells[2]).toBe(NO_DATA);
        if (s.openIncident === null) expect(cells[5]).toBe('none');
        else expect(cells[5]).toContain(`peak ${s.openIncident.peakLevel}`);
        // No cell is empty, and nothing is carried by a colour style.
        for (const c of cells) expect(c.trim()).not.toBe('');
        expect(html).not.toMatch(/style=|color/i);
      }),
      { numRuns: 200 },
    );
  });
});
