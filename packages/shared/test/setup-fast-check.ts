import fc from 'fast-check';
import { afterEach, beforeEach } from 'vitest';
import { isPropertyFailure, isTimeout } from './fast-check-report.js';
/**
 * Vitest `setupFiles` of every workspace that uses fast-check (shared, api, web, exorcist-mcp).
 *
 * Each test file runs with ONE seed: `FC_SEED` from the environment, or a random one. When a test fails because a
 * property was falsified (the error comes from `fc.assert`: its message holds "Property failed") the seed is printed,
 * together with the `FC_SEED` and `FC_PATH` that replay it. When a test that ran a property fails by TIMEOUT (the
 * property itself passed or was only slow, as on a loaded machine) the line `[fast-check] timed out` is printed with the same
 * seed. Any other failure (a plain assertion, a timeout of a test that ran no property) prints nothing.
 * `FC_PATH` is the `path` that fast-check prints with a falsified property: with the same `FC_SEED` it replays the
 * counterexample at once. `numRuns` is never changed here.
 */
const fromEnv = process.env.FC_SEED;
const parsed = fromEnv === undefined || fromEnv === '' ? Number.NaN : Number(fromEnv);
if (fromEnv !== undefined && fromEnv !== '' && !Number.isInteger(parsed)) throw new Error('FC_SEED must be an integer');
const seed = Number.isInteger(parsed) ? parsed : Math.floor(Math.random() * 0x7fffffff);
const path = process.env.FC_PATH === undefined || process.env.FC_PATH === '' ? undefined : process.env.FC_PATH;
if (path !== undefined && !/^[0-9:]+$/.test(path)) throw new Error('FC_PATH must be digits and colons, as fast-check prints it');
// A property is "run" in a test when `fc.assert` reaches its reporter. The reporter does what the default does (it throws the
// usual report of a falsified property) and counts the runs of the current test, so a timeout can be told from a failure.
let propertyRuns = 0;
const report = (details: fc.RunDetails<unknown>): void => {
  propertyRuns++;
  if (details.failed) throw new Error(fc.defaultReportMessage(details));
};
// `path` is not in the type of the global parameters (it only makes sense with a seed), but `assert` reads it.
fc.configureGlobal({ seed, reporter: report, ...(path === undefined ? {} : ({ path } as object)) });
beforeEach(() => {
  propertyRuns = 0;
});
afterEach((ctx) => {
  if (ctx.task.result?.state !== 'fail') return;
  const replay = `FC_SEED=${seed}${path === undefined ? '' : ` FC_PATH=${path}`}`;
  if (isPropertyFailure(ctx.task.result.errors)) {
    process.stderr.write(`[fast-check] "${ctx.task.name}" failed. seed: ${seed}. Replay with: ${replay}. The failing path is in the message above.\n`);
  } else if (propertyRuns > 0 && isTimeout(ctx.task.result.errors)) {
    process.stderr.write(`[fast-check] timed out: "${ctx.task.name}". seed: ${seed}. Replay with: ${replay}. The property ran ${propertyRuns} time(s) in this test; it was slow, not falsified.\n`);
  }
});
