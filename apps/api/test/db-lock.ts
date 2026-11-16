import pg from 'pg';
/**
 * One run of the API tests at a time on the Test database. Global setup drops the `public` schema, so a second vitest
 * process that starts while a first one runs would pull the tables from under it (`fileParallelism: false` only holds
 * inside one process). The run takes a session-level advisory lock on a connection that stays open until teardown;
 * when the process dies the closed connection frees the lock.
 */
export const TEST_DB_LOCK_KEY = 7_201_126_042;
export const WAIT_MESSAGE = 'another api test run is using the test database, waiting';
export const TIMEOUT_MESSAGE = 'another api test run is still using the test database after the wait: giving up';
export interface TestDbLockOptions {
  key?: number;
  /** How long to wait for the lock. Default 10 minutes. */
  timeoutMs?: number;
  /** Time between two tries. Default 2 s. */
  pollMs?: number;
  /** Called once, at the first refused try. */
  onWait?: (message: string) => void;
}
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
/** Takes the lock and returns the function that releases it (it also closes the connection). */
export async function acquireTestDbLock(url: string, options: TestDbLockOptions = {}): Promise<() => Promise<void>> {
  const key = options.key ?? TEST_DB_LOCK_KEY;
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;
  const pollMs = options.pollMs ?? 2000;
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const deadline = Date.now() + timeoutMs;
    let told = false;
    for (;;) {
      const res = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [key]);
      if (res.rows[0]?.locked === true) break;
      if (!told) {
        told = true;
        options.onWait?.(WAIT_MESSAGE);
      }
      if (Date.now() >= deadline) throw new Error(TIMEOUT_MESSAGE);
      await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
    }
  } catch (err) {
    await client.end().catch(() => undefined);
    throw err;
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [key]);
    } finally {
      await client.end().catch(() => undefined);
    }
  };
}
