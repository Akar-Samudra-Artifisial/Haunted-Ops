// Loaded with `node --import` by `pnpm test:scripts` (the same idea as packages/shared/test/setup-fast-check.ts for vitest):
// each test file runs fast-check with ONE seed, `FC_SEED` from the environment or a random one. When the process ends with a
// failure caused by a falsified property the seed is printed with the `FC_SEED` and `FC_PATH` that replay it (the falsified
// property prints its own `path`); any other failure prints no seed.
// `numRuns` is never changed here.
import fc from 'fast-check';
const fromEnv = process.env.FC_SEED;
const parsed = fromEnv === undefined || fromEnv === '' ? Number.NaN : Number(fromEnv);
if (fromEnv !== undefined && fromEnv !== '' && !Number.isInteger(parsed)) throw new Error('FC_SEED must be an integer');
const seed = Number.isInteger(parsed) ? parsed : Math.floor(Math.random() * 0x7fffffff);
const path = process.env.FC_PATH === undefined || process.env.FC_PATH === '' ? undefined : process.env.FC_PATH;
if (path !== undefined && !/^[0-9:]+$/.test(path)) throw new Error('FC_PATH must be digits and colons, as fast-check prints it');
// `path` is not in the type of the global parameters, but `assert` reads it.
// The seed is printed only when a property was falsified: the reporter below notes that `fc.assert` failed, and throws the
// usual report (its message holds "Property failed"). A plain assertion or any other error prints no seed.
let propertyFailed = false;
const report = (details) => {
  if (details.failed) {
    propertyFailed = true;
    throw new Error(fc.defaultReportMessage(details));
  }
};
fc.configureGlobal({ seed, reporter: report, ...(path === undefined ? {} : { path }) });
process.on('exit', (code) => {
  if (code !== 0 && propertyFailed) process.stderr.write(`[fast-check] a property failed. seed: ${seed}. Replay with: FC_SEED=${seed}${path === undefined ? '' : ` FC_PATH=${path}`}. The failing path is in the message of the property.\n`);
});
