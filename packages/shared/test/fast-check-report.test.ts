import fc from 'fast-check';
import { expect, it } from 'vitest';
import { isPropertyFailure } from './fast-check-report.js';
function thrownBy(fn: () => void): Error {
  try {
    fn();
  } catch (err) {
    return err as Error;
  }
  throw new Error('did not throw');
}
it('a falsified fc.assert is a property failure, so the seed is printed', () => {
  const err = thrownBy(() => fc.assert(fc.property(fc.integer(), (n) => n < 0), { numRuns: 20, seed: 1 }));
  expect(err.message).toContain('Property failed');
  expect(isPropertyFailure([err])).toBe(true);
  expect(isPropertyFailure([new Error('other'), err])).toBe(true);
});
it('a plain assertion, a timeout or no error is not a property failure, so no seed is printed', () => {
  const plain = thrownBy(() => expect(1).toBe(2));
  expect(isPropertyFailure([plain])).toBe(false);
  expect(isPropertyFailure([new Error('Test timed out in 5000ms.')])).toBe(false);
  expect(isPropertyFailure([{ message: 42 }, undefined])).toBe(false);
  expect(isPropertyFailure([])).toBe(false);
  expect(isPropertyFailure(undefined)).toBe(false);
});
