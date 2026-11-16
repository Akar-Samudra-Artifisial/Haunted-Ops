import { expect, it } from 'vitest';
import { TIMEOUT_MESSAGE, WAIT_MESSAGE, acquireTestDbLock } from './db-lock.js';
import { describeDb, testDatabaseUrl } from './db.js';
// A key of its own: the real key is held by the global setup of this very run.
const KEY = 7_201_126_043;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
describeDb('test database lock (Test database)', () => {
  const url = testDatabaseUrl as string;
  it('the second setup waits while the first holds the lock, says so once, and goes on after the release', async () => {
    const first = await acquireTestDbLock(url, { key: KEY, pollMs: 20 });
    const told: string[] = [];
    let got = false;
    const second = acquireTestDbLock(url, { key: KEY, pollMs: 20, onWait: (m) => told.push(m) }).then((release) => {
      got = true;
      return release;
    });
    await sleep(400);
    expect(got).toBe(false);
    expect(told).toEqual([WAIT_MESSAGE]);
    await first();
    const release = await second;
    expect(got).toBe(true);
    await release();
  });
  it('two setups started together never work at the same time', async () => {
    let inside = 0;
    let most = 0;
    const setup = async (): Promise<void> => {
      const release = await acquireTestDbLock(url, { key: KEY, pollMs: 10 });
      try {
        inside += 1;
        most = Math.max(most, inside);
        await sleep(150); // the place where the real setup drops the schema
        inside -= 1;
      } finally {
        await release();
      }
    };
    await Promise.all([setup(), setup(), setup()]);
    expect(most).toBe(1);
  });
  it('fails with the message after the deadline, and a closed connection frees the lock', async () => {
    const first = await acquireTestDbLock(url, { key: KEY, pollMs: 20 });
    await expect(acquireTestDbLock(url, { key: KEY, pollMs: 20, timeoutMs: 150 })).rejects.toThrow(TIMEOUT_MESSAGE);
    await first();
    // Released: it is free at once.
    const again = await acquireTestDbLock(url, { key: KEY, pollMs: 20, timeoutMs: 1000 });
    await again();
    await again(); // a second release does nothing
  });
});
