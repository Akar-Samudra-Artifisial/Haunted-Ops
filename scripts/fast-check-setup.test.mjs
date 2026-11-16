import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
const setup = fileURLToPath(new URL('./fast-check-setup.mjs', import.meta.url));
const root = fileURLToPath(new URL('..', import.meta.url));
/** Runs `code` as an ES module with the setup preloaded and a fixed seed. */
function run(code, env = {}) {
  return spawnSync(process.execPath, ['--import', setup, '--input-type=module', '-e', code], {
    cwd: root,
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', FC_SEED: '4242', ...env },
  });
}
test('a falsified property prints the seed and the way to replay it', () => {
  const r = run("import fc from 'fast-check'; fc.assert(fc.property(fc.integer(), (n) => n < 0));");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Property failed/);
  assert.match(r.stderr, /\[fast-check\] a property failed\. seed: 4242\. Replay with: FC_SEED=4242/);
});
test('an async falsified property prints the seed too', () => {
  const r = run("import fc from 'fast-check'; await fc.assert(fc.asyncProperty(fc.integer(), async (n) => n < 0));");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /\[fast-check\] a property failed\. seed: 4242/);
});
test('a plain assertion that fails prints no seed', () => {
  const r = run("import assert from 'node:assert/strict'; assert.equal(1, 2);");
  assert.notEqual(r.status, 0);
  assert.doesNotMatch(r.stderr, /\[fast-check\]/);
});
test('a passing property prints nothing and keeps the exit code 0', () => {
  const r = run("import fc from 'fast-check'; fc.assert(fc.property(fc.integer(), (n) => n === n));");
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
});
