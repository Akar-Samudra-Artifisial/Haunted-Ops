import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { readLegendOpen, writeLegendOpen } from './legend-state.js';
const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};
const throwing = {
  getItem: (): string | null => {
    throw new Error('blocked');
  },
  setItem: (): void => {
    throw new Error('blocked');
  },
};
describe('Property 3: the Legend remembers its state', () => {
  // Feature: visual-refresh, Property 3
  it('reads the last choice written, true with nothing stored, and never throws', () => {
    expect(readLegendOpen(memory())).toBe(true);
    fc.assert(
      fc.property(fc.array(fc.boolean(), { minLength: 1, maxLength: 10 }), (choices) => {
        const store = memory();
        for (const c of choices) writeLegendOpen(c, store);
        expect(readLegendOpen(store)).toBe(choices.at(-1));
        expect(() => writeLegendOpen(true, throwing)).not.toThrow();
        expect(readLegendOpen(throwing)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});
