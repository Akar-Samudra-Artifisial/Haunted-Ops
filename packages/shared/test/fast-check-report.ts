/**
 * True when one of the errors of a failed test comes from a falsified fast-check property (`fc.assert` throws a message
 * that starts the report with "Property failed"). A plain assertion, a timeout or any other error is not one: those are
 * not a counterexample, so `setup-fast-check.ts` does not print the replay line of a falsified property for them.
 */
export function isPropertyFailure(errors: ReadonlyArray<{ message?: unknown } | undefined> | undefined): boolean {
  return (errors ?? []).some((e) => typeof e?.message === 'string' && e.message.includes('Property failed'));
}

/**
 * True when one of the errors of a failed test is the Vitest timeout ("Test timed out in 30000ms."). The setup prints the
 * seed for it only when a property ran in that test (a property that is slow under load, not a falsified one).
 */
export function isTimeout(errors: ReadonlyArray<{ message?: unknown } | undefined> | undefined): boolean {
  return (errors ?? []).some((e) => typeof e?.message === 'string' && /timed out/i.test(e.message));
}
