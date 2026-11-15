import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
const ROW = '[data-row]';
/** The table row of a Service, found by comparing the attribute (a name is never put into a selector). */
function findRow(name: string): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>(ROW)) if (el.dataset['row'] === name) return el;
  return null;
}
/** Moves focus to the name button of a row; false when the row is not there. */
export function focusRow(name: string): boolean {
  const target = findRow(name)?.querySelector<HTMLElement>('button.row-select') ?? null;
  if (target === null) return false;
  target.focus();
  return document.activeElement === target;
}
/** True when nothing holds focus (it fell to the body), or focus is inside `region`. */
export function focusIsFreeOrIn(region: Element | null): boolean {
  const active = document.activeElement;
  return active === null || active === document.body || (region !== null && region.contains(active));
}
type Anchor = { kind: 'row'; name: string } | { kind: 'region' };
/**
 * Keeps focus from falling to `<body>` when the table re-renders. It remembers the row (or the region) that
 * had focus and, after a render that left focus on the body, puts it back on the same row, or on the region
 * when the row is gone. A click or a move of focus outside the region forgets the anchor.
 */
export function useFocusAnchor(region: RefObject<HTMLElement | null>): void {
  const anchor = useRef<Anchor | null>(null);
  useEffect(() => {
    const onFocusIn = (event: FocusEvent): void => {
      const el = region.current;
      const target = event.target;
      if (el === null || !(target instanceof Element) || !el.contains(target)) {
        anchor.current = null;
        return;
      }
      const row = target.closest<HTMLElement>(ROW);
      const name = row?.dataset['row'];
      anchor.current = name === undefined ? { kind: 'region' } : { kind: 'row', name };
    };
    const forget = (): void => {
      anchor.current = null;
    };
    document.addEventListener('focusin', onFocusIn);
    // A pointer press is the user's own move: a blur it causes must not be undone.
    document.addEventListener('pointerdown', forget, true);
    return () => {
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('pointerdown', forget, true);
    };
  }, [region]);
  // After every render of the table, not only when the services change.
  useLayoutEffect(() => {
    const a = anchor.current;
    const active = document.activeElement;
    if (a === null || (active !== null && active !== document.body)) return;
    if (a.kind === 'row' && focusRow(a.name)) return;
    region.current?.focus();
  });
}
