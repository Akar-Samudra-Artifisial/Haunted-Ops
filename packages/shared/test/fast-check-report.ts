/**
 * True when one of the errors of a failed test comes from a falsified fast-check property (`fc.assert` throws a message
 * that starts the report with "Property failed"). A plain assertion, a timeout or any other error is not one: the seed
 * says nothing about them, so `setup-fast-check.ts` stays silent.
 */
export function isPropertyFailure(errors: ReadonlyArray<{ message?: unknown } | undefined> | undefined): boolean {
  return (errors ?? []).some((e) => typeof e?.message === 'string' && e.message.includes('Property failed'));
}
