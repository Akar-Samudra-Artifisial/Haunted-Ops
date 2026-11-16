import fc from 'fast-check';
import { afterEach } from 'vitest';
import { isPropertyFailure } from './fast-check-report.js';
/**
 * Vitest `setupFiles` of every workspace that uses fast-check (shared, api, web, exorcist-mcp).
 *
 * Each test file runs with ONE seed: `FC_SEED` from the environment, or a random one. When a test fails because a
 * property was falsified (the error comes from `fc.assert`: its message holds "Property failed") the seed is printed,
 * together with the `FC_SEED` and `FC_PATH` that replay it. Any other failure (a plain assertion, a timeout) prints nothing.
 * `FC_PATH` is the `path` that fast-check prints with a falsified property: with the same `FC_SEED` it replays the
 * counterexample at once. `numRuns` is never changed here.
 */
const fromEnv = process.env.FC_SEED;
const parsed = fromEnv === undefined || fromEnv === '' ? Number.NaN : Number(fromEnv);
if (fromEnv !== undefined && fromEnv !== '' && !Number.isInteger(parsed)) throw new Error('FC_SEED must be an integer');
const seed = Number.isInteger(parsed) ? parsed : Math.floor(Math.random() * 0x7fffffff);
const path = process.env.FC_PATH === undefined || process.env.FC_PATH === '' ? undefined : process.env.FC_PATH;
if (path !== undefined && !/^[0-9:]+$/.test(path)) throw new Error('FC_PATH must be digits and colons, as fast-check prints it');
// `path` is not in the type of the global parameters (it only makes sense with a seed), but `assert` reads it.
fc.configureGlobal({ seed, ...(path === undefined ? {} : ({ path } as object)) });
afterEach((ctx) => {
  if (ctx.task.result?.state !== 'fail' || !isPropertyFailure(ctx.task.result.errors)) return;
  const replay = `FC_SEED=${seed}${path === undefined ? '' : ` FC_PATH=${path}`}`;
  process.stderr.write(`[fast-check] "${ctx.task.name}" failed. seed: ${seed}. Replay with: ${replay}. The failing path is in the message above.\n`);
});
