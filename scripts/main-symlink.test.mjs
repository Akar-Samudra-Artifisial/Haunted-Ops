// Scripts started through a symbolic link (the server runs /opt/haunted-ops/current/scripts/...) must run main().
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkTree } from './release-check.mjs';
const SCRIPTS = fileURLToPath(new URL('.', import.meta.url));
const REPO = fileURLToPath(new URL('..', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'main-symlink-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const link = join(dir, 'current');
symlinkSync(SCRIPTS.replace(/\/$/, ''), link);
const KEY = 'abcdefghij0123456789ABCD';
const keyFile = join(dir, 'kiro.env');
writeFileSync(keyFile, `KIRO_API_KEY=${KEY}\n`);
const run = (script, ...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

test('read-env-value.mjs prints the value through a symbolic link, as through the real path', () => {
  const real = run(join(SCRIPTS, 'read-env-value.mjs'), keyFile, 'KIRO_API_KEY');
  const viaLink = run(join(link, 'read-env-value.mjs'), keyFile, 'KIRO_API_KEY');
  assert.equal(real.stdout, KEY);
  assert.equal(viaLink.status, 0);
  assert.equal(viaLink.stdout, KEY);
  const absent = run(join(link, 'read-env-value.mjs'), keyFile, 'OTHER_NAME');
  assert.equal(absent.status, 1);
  assert.equal(absent.stdout, '');
  const emptyFile = join(dir, 'empty.env');
  writeFileSync(emptyFile, 'KIRO_API_KEY=\n');
  assert.equal(run(join(link, 'read-env-value.mjs'), emptyFile, 'KIRO_API_KEY').status, 1);
});
test('demo-env-check.mjs accepts a good file and refuses a bad one through a symbolic link', () => {
  const script = join(link, 'demo-env-check.mjs');
  const ok = run(script, keyFile, 'kiro');
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout.trim(), 'demo-env-check: ok (kiro)');
  assert.equal(ok.stderr.trim(), 'env ok: kiro');
  assert.ok(!ok.stdout.includes(KEY) && !ok.stderr.includes(KEY));
  const badFile = join(dir, 'bad.env');
  writeFileSync(badFile, `KIRO_API_KEY=${KEY}\nEXTRA=1\n`);
  const bad = run(script, badFile, 'kiro');
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /demo-env-check: refused: EXTRA/);
  assert.ok(!bad.stderr.includes('env ok'));
  const real = run(join(SCRIPTS, 'demo-env-check.mjs'), badFile, 'kiro');
  assert.equal(real.status, bad.status);
  assert.equal(real.stderr, bad.stderr);
});
test('the pre-flight requires the env ok line of the guard, not only the exit status', () => {
  const pre = readFileSync(join(REPO, 'deploy/server/preflight.sh'), 'utf8');
  assert.match(pre, /grep -qx "env ok: \$2"/);
  assert.equal((pre.match(/check "env guard accepts [a-z]+\.env" env_guard /g) ?? []).length, 3);
  assert.ok(!/check "env guard[^\n]*\bnode\b/.test(pre), 'no guard check runs node directly');
});
test('no script keeps the old main-module check, and every one that starts main() behind a check uses isMain', () => {
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name === '.git' || e.name === 'spike' || e.name === 'spikes') continue;
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.endsWith('.mjs') && !e.name.endsWith('.test.mjs')) files.push(full);
    }
  };
  for (const top of ['scripts', 'tools', 'deploy', 'packages']) {
    try {
      walk(join(REPO, top));
    } catch {
      /* a folder that does not exist */
    }
  }
  assert.ok(files.length > 10);
  for (const file of files) {
    const rel = relative(REPO, file).split(sep).join('/');
    const text = readFileSync(file, 'utf8');
    assert.ok(!/import\.meta\.url\s*===\s*pathToFileURL\(\s*process\.argv\[1\]/.test(text), `${rel} keeps the old main-module check`);
    assert.ok(!/process\.argv\[1\]\s*\)?\s*===\s*fileURLToPath\(import\.meta\.url\)/.test(text), `${rel} keeps a plain argv[1] comparison`);
    if (rel === 'scripts/is-main.mjs') continue;
    if (/^if \(.*process\.argv\[1\].*import\.meta\.url/m.test(text) || /^if \(.*import\.meta\.url.*process\.argv\[1\]/m.test(text)) assert.fail(`${rel} compares argv[1] with import.meta.url by hand`);
  }
  for (const rel of ['read-env-value.mjs', 'demo-env-check.mjs', 'demo-smoke.mjs']) assert.match(readFileSync(join(SCRIPTS, rel), 'utf8'), /if \(isMain\(import\.meta\.url\)\)/);
});
test('the release ships is-main.mjs and the release check refuses a shipped script without it', () => {
  assert.match(readFileSync(join(REPO, 'deploy/build-release.sh'), 'utf8'), /scripts\/is-main\.mjs/);
  const root = join(dir, 'release');
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'fixtures/replays'), { recursive: true });
  writeFileSync(join(root, 'fixtures/replays/README.md'), '# r\n');
  writeFileSync(join(root, 'scripts/read-env-value.mjs'), "import { isMain } from './is-main.mjs';\n");
  assert.deepEqual(checkTree(root).map((f) => `${f.kind}:${f.path}`), ['script_import_missing:scripts/read-env-value.mjs']);
  writeFileSync(join(root, 'scripts/is-main.mjs'), 'export const isMain = () => false;\n');
  assert.deepEqual(checkTree(root), []);
});
