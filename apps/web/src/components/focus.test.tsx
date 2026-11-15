import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import { SERVICE_NAMES, type ServiceState } from '@haunted-ops/shared';
import { makeService } from '../test/arbs.js';
import { TableMode } from './TableMode.js';

afterEach(cleanup);

const house = (names: readonly string[], level: 0 | 1 = 0): ServiceState[] =>
  SERVICE_NAMES.filter((n) => names.includes(n)).map((n) => makeService(n, { hauntLevel: level }));
const button = (name: string): HTMLElement => screen.getByRole('button', { name });

describe('focus anchor', () => {
  it('puts focus back on the same row after a render that dropped it', () => {
    const all = house(SERVICE_NAMES);
    const { rerender } = render(<TableMode services={all} />);
    button('orders').focus();
    expect(document.activeElement).toBe(button('orders'));
    button('orders').blur();
    expect(document.activeElement).toBe(document.body);
    rerender(<TableMode services={house(SERVICE_NAMES, 1)} />);
    expect(document.activeElement).toBe(button('orders'));
  });
  it('keeps focus on the row through a plain re-render, with stable row elements', () => {
    const { rerender } = render(<TableMode services={house(SERVICE_NAMES)} />);
    const before = screen.getByRole('row', { name: /orders/ });
    button('orders').focus();
    rerender(<TableMode services={house(SERVICE_NAMES, 1)} />);
    expect(screen.getByRole('row', { name: /orders/ })).toBe(before);
    expect(document.activeElement).toBe(button('orders'));
  });
  it('moves focus to the table region when the row is gone', () => {
    const { rerender } = render(<TableMode services={house(SERVICE_NAMES)} />);
    button('orders').focus();
    rerender(<TableMode services={house(['gate', 'payments', 'ledger'])} />);
    expect(document.activeElement?.id).toBe('services');
  });
  it('does not take focus back after the user clicks elsewhere', () => {
    const { rerender } = render(
      <>
        <TableMode services={house(SERVICE_NAMES)} />
        <button type="button">outside</button>
      </>,
    );
    button('orders').focus();
    fireEvent.pointerDown(document.body);
    button('orders').blur();
    rerender(
      <>
        <TableMode services={house(SERVICE_NAMES, 1)} />
        <button type="button">outside</button>
      </>,
    );
    expect(document.activeElement).toBe(document.body);
  });
  it('marks every row with its name and the selected one with aria-current', () => {
    render(<TableMode services={house(SERVICE_NAMES)} selected="ledger" />);
    expect(document.querySelectorAll('tr[data-row]')).toHaveLength(4);
    expect(screen.getByRole('row', { name: /ledger/ }).getAttribute('aria-current')).toBe('true');
  });
});

describe('Property 7: focus survives re-renders', () => {
  // Feature: accessible-mode, Property 7
  it('is never on the body after a render, and is on the same row or the region', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...SERVICE_NAMES),
        fc.array(fc.subarray([...SERVICE_NAMES], { minLength: 1 }), { minLength: 1, maxLength: 6 }),
        (focused, updates) => {
          const { rerender, unmount } = render(<TableMode services={house(SERVICE_NAMES)} />);
          button(focused).focus();
          for (const names of updates) {
            // An update that also loses focus, as a re-created row would.
            if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body && !names.includes(focused)) document.activeElement.blur();
            rerender(<TableMode services={house(names, 1)} />);
            expect(document.activeElement).not.toBe(document.body);
            if (names.includes(focused)) expect(document.activeElement).toBe(button(focused));
            else expect(document.activeElement?.id).toBe('services');
            if (!names.includes(focused)) break;
          }
          unmount();
        },
      ),
      { numRuns: 40 },
    );
  });
});
