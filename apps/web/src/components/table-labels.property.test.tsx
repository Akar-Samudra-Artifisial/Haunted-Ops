import { cleanup, render, within } from '@testing-library/react';
import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import type { HauntLevel, ServiceName } from '@haunted-ops/shared';
import { makeService } from '../test/arbs.js';
import { TableMode } from './TableMode.js';
afterEach(cleanup);
const NAMES: ServiceName[] = ['gate', 'orders', 'payments', 'ledger'];
describe('Property 4: every cell is labelled by its column and keeps its role', () => {
  // Feature: visual-refresh, Property 4
  it('has one labelled cell per column in every row, with the table roles written out', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom<HauntLevel>(0, 1, 2, 3, 4), { minLength: 1, maxLength: 4 }), (levels) => {
        cleanup();
        const { container } = render(<TableMode services={levels.map((hauntLevel, i) => makeService(NAMES[i] as ServiceName, { hauntLevel }))} />);
        const headers = [...container.querySelectorAll('thead th')].map((th) => th.textContent);
        expect(headers).toHaveLength(9);
        expect(container.querySelector('table')?.getAttribute('role')).toBe('table');
        expect(within(container).getAllByRole('columnheader')).toHaveLength(9);
        const rows = [...container.querySelectorAll('tbody tr')];
        expect(rows).toHaveLength(levels.length);
        for (const row of rows) {
          expect(row.getAttribute('role')).toBe('row');
          const cells = [...row.children];
          expect(cells.map((c) => c.getAttribute('data-label'))).toEqual(headers);
          expect(cells[0]?.getAttribute('role')).toBe('rowheader');
          for (const c of cells.slice(1)) expect(c.getAttribute('role')).toBe('cell');
        }
      }),
      { numRuns: 100 },
    );
  });
});
