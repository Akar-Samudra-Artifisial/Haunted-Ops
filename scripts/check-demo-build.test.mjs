import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkDemoBuild } from './check-demo-build.mjs';
const SCRIPT = fileURLToPath(new URL('./check-demo-build.mjs', import.meta.url));
const WEB = fileURLToPath(new URL('../apps/web', import.meta.url));
const DOMAIN = 'demo.example.test';
const root = mkdtempSync(join(tmpdir(), 'demo-build-'));
after(() => rmSync(root, { recursive: true, force: true }));
/** A real `vite build` of the web app into a throwaway folder (about a second; no network). */
function viteBuild(name, env) {
  const out = join(root, name);
  const clean = { ...process.env };
  delete clean.VITE_DEMO_MODE;
  delete clean.VITE_API_BASE_URL;
  const res = spawnSync(join(WEB, 'node_modules/.bin/vite'), ['build', '--outDir', out, '--emptyOutDir'], { cwd: WEB, env: { ...clean, ...env }, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  return out;
}
test('a real vite build with the demo settings passes, and the same build without them fails', () => {
  const demo = viteBuild('demo', { VITE_DEMO_MODE: 'true', VITE_API_BASE_URL: `https://${DOMAIN}` });
  assert.deepEqual(checkDemoBuild(demo, DOMAIN), []);
  assert.deepEqual(checkDemoBuild(demo, 'other.example.test'), ['VITE_API_BASE_URL']);
  const plain = viteBuild('plain', {});
  assert.deepEqual(checkDemoBuild(plain, DOMAIN), ['VITE_DEMO_MODE', 'VITE_API_BASE_URL']);
  const other = viteBuild('other', { VITE_DEMO_MODE: 'false', VITE_API_BASE_URL: `https://${DOMAIN}` });
  assert.deepEqual(checkDemoBuild(other, DOMAIN), ['VITE_DEMO_MODE']);
});
test('the CLI exits 0, 1 and 2', () => {
  const dist = join(root, 'cli');
  mkdirSync(join(dist, 'assets'), { recursive: true });
  writeFileSync(join(dist, 'assets', 'chunk.js'), `x({PROD:!0,VITE_API_BASE_URL:\`https://${DOMAIN}\`,VITE_DEMO_MODE:\`true\`})`);
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  assert.equal(run(dist, DOMAIN).status, 0);
  const bad = run(dist, 'other.example.test');
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /lacks: VITE_API_BASE_URL/);
  assert.equal(run(dist).status, 2);
  assert.equal(run(join(root, 'missing'), DOMAIN).status, 2);
});
test('the setting is found in any script, with any quote style, and a mere read of the variable is not enough', () => {
  const dist = join(root, 'styles');
  mkdirSync(join(dist, 'assets'), { recursive: true });
  const base = `{VITE_API_BASE_URL:"https://${DOMAIN}"`;
  const read = 'function f(t){if(t.PROD&&t.VITE_DEMO_MODE!==`true`)return null}';
  for (const [name, text] of [
    ['single', `${base},VITE_DEMO_MODE:'true'}`],
    ['double', `${base},VITE_DEMO_MODE:"true"}`],
    ['key quoted', `${base},"VITE_DEMO_MODE": "true"}`],
    ['spaced', `${base}, VITE_DEMO_MODE : \`true\` }`],
  ]) {
    writeFileSync(join(dist, 'assets', 'index-aaaa.js'), `${read};${text}`);
    assert.deepEqual(checkDemoBuild(dist, DOMAIN), [], name);
  }
  // Only a code line that reads the variable: not a setting.
  writeFileSync(join(dist, 'assets', 'index-aaaa.js'), `${read};${base}}`);
  assert.deepEqual(checkDemoBuild(dist, DOMAIN), ['VITE_DEMO_MODE']);
  // The settings may sit in a chunk that is not named index-*.
  writeFileSync(join(dist, 'assets', 'index-aaaa.js'), read);
  writeFileSync(join(dist, 'assets', 'other-bbbb.js'), `${base},VITE_DEMO_MODE:\`true\`}`);
  assert.deepEqual(checkDemoBuild(dist, DOMAIN), []);
  mkdirSync(join(root, 'empty'));
  assert.deepEqual(checkDemoBuild(join(root, 'empty'), DOMAIN), ['scripts']);
});
