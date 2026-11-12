/**
 * Decides whether database integration tests may run.
 * - TEST_DATABASE_URL unset: skip, with a visible message.
 * - TEST_DATABASE_URL equal to DATABASE_URL: refuse to run.
 */
export type DbGuard = { run: true; url: string } | { run: false; reason: 'unset' };

export const SKIP_MESSAGE = 'TEST_DATABASE_URL is not set: database integration tests are skipped.';
export const REFUSE_MESSAGE = 'TEST_DATABASE_URL equals DATABASE_URL: refusing to run integration tests.';

export class RefuseToRunError extends Error {
  constructor() {
    super(REFUSE_MESSAGE);
    this.name = 'RefuseToRunError';
  }
}

export function dbGuard(env: Readonly<Record<string, string | undefined>> = process.env): DbGuard {
  const url = env.TEST_DATABASE_URL?.trim();
  if (!url) return { run: false, reason: 'unset' };
  const main = env.DATABASE_URL?.trim();
  if (main !== undefined && main !== '' && main === url) throw new RefuseToRunError();
  return { run: true, url };
}
