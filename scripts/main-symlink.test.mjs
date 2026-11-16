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
  // The line is required inside env-guard.sh, which the pre-flight, install.sh and the units all use.
  assert.match(readFileSync(join(REPO, 'deploy/server/env-guard.sh'), 'utf8'), /grep -qxF "env ok: \$PROFILE"/);
  assert.match(pre, /deploy\/server\/env-guard\.sh/);
  assert.equal((pre.match(/check "env guard accepts [a-z]+\.env" env_guard /g) ?? []).length, 3);
  assert.ok(!/check "env guard[^\n]*\bnode\b/.test(pre), 'no guard check runs node directly');
});
// --- the env guard wrapper (deploy/server/env-guard.sh) through a symbolic link to the release folder ---
const GUARD_REAL = join(dir, 'release-real');
const GUARD_LINK = join(dir, 'release-link');
// The node binary comes from the option `--node` only (tests pass the running node); the environment is not read for it.
const guardRun = (file, profile, node = process.execPath) => spawnSync('bash', [join(GUARD_LINK, 'deploy/server/env-guard.sh'), '--node', node, file, profile], { encoding: 'utf8' });
const checkScript = join(GUARD_REAL, 'scripts/demo-env-check.mjs');
const realCheck = readFileSync(join(SCRIPTS, 'demo-env-check.mjs'), 'utf8');
mkdirSync(join(GUARD_REAL, 'deploy/server'), { recursive: true });
mkdirSync(join(GUARD_REAL, 'scripts'), { recursive: true });
writeFileSync(join(GUARD_REAL, 'deploy/server/env-guard.sh'), readFileSync(join(REPO, 'deploy/server/env-guard.sh'), 'utf8'), { mode: 0o755 });
writeFileSync(join(GUARD_REAL, 'scripts/is-main.mjs'), readFileSync(join(SCRIPTS, 'is-main.mjs'), 'utf8'));
symlinkSync(GUARD_REAL, GUARD_LINK);
const badKeyFile = join(dir, 'guard-bad.env');
writeFileSync(badKeyFile, `KIRO_API_KEY=${KEY}\nEXTRA=1\n`);
const apiFile = join(dir, 'guard-api.env');
writeFileSync(apiFile, 'NODE_ENV=production\n');

test('env-guard.sh through a symlinked release folder: exit 0 with a good file, 1 with a bad one', () => {
  writeFileSync(checkScript, realCheck);
  const ok = guardRun(keyFile, 'kiro');
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stderr, /^env ok: kiro$/m);
  assert.ok(!ok.stderr.includes(KEY) && !ok.stdout.includes(KEY));
  const bad = guardRun(badKeyFile, 'kiro');
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /refused: EXTRA/);
  assert.ok(!bad.stderr.includes(KEY));
});
test('env-guard.sh exits 1 when the guard exits 0 and prints nothing', () => {
  writeFileSync(checkScript, 'process.exit(0);\n');
  const res = guardRun(badKeyFile, 'kiro');
  assert.equal(res.status, 1);
  assert.match(res.stderr, /did not print its ok line/);
  writeFileSync(checkScript, realCheck);
});
test('env-guard.sh exits 1 when the guard prints the ok line of another profile', () => {
  writeFileSync(checkScript, "process.stderr.write('env ok: lab\\n');\n");
  const res = guardRun(apiFile, 'api');
  assert.equal(res.status, 1);
  assert.match(res.stderr, /did not print its ok line for api/);
  writeFileSync(checkScript, realCheck);
});
test('env-guard.sh exits 1 for a wrong argument count and for a node that is missing, relative, not executable or not a file', () => {
  writeFileSync(checkScript, realCheck);
  const sh = join(GUARD_LINK, 'deploy/server/env-guard.sh');
  assert.equal(spawnSync('bash', [sh, keyFile], { encoding: 'utf8' }).status, 1);
  assert.equal(spawnSync('bash', [sh, keyFile, 'kiro'], { encoding: 'utf8' }).status, 1, 'no --node option');
  assert.equal(spawnSync('bash', [sh, '--node', process.execPath, keyFile], { encoding: 'utf8' }).status, 1);
  assert.equal(spawnSync('bash', [sh, '--other', process.execPath, keyFile, 'kiro'], { encoding: 'utf8' }).status, 1);
  const plain = join(dir, 'plain-file');
  writeFileSync(plain, '#!/bin/sh\nexit 0\n', { mode: 0o644 });
  for (const node of [join(dir, 'no-such-node'), 'node', './node', plain, dir]) {
    const res = guardRun(keyFile, 'kiro', node);
    assert.equal(res.status, 1, node);
    assert.match(res.stderr, /^env-guard: --node (must be an absolute path|is not an executable file)$/m, node);
  }
});
test('env-guard.sh never reads the node binary from the environment', () => {
  writeFileSync(checkScript, realCheck);
  // A HAUNTED_NODE (or NODE) that would fail or pass on its own changes nothing: the option is the only source.
  const sh = join(GUARD_LINK, 'deploy/server/env-guard.sh');
  const env = { ...process.env, HAUNTED_NODE: '/usr/bin/false', NODE: '/usr/bin/false' };
  const withOption = spawnSync('bash', [sh, '--node', process.execPath, keyFile, 'kiro'], { encoding: 'utf8', env });
  assert.equal(withOption.status, 0, withOption.stderr);
  const without = spawnSync('bash', [sh, keyFile, 'kiro'], { encoding: 'utf8', env: { ...process.env, HAUNTED_NODE: process.execPath } });
  assert.equal(without.status, 1);
  // And the script has no code that names the variable (its comments do).
  const code = readFileSync(join(REPO, 'deploy/server/env-guard.sh'), 'utf8').split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n');
  assert.ok(!code.includes('HAUNTED_NODE'));
});
test('no unit or shell file under deploy/server/ runs demo-env-check.mjs except env-guard.sh', () => {
  const found = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && !e.name.endsWith('.example')) found.push(full);
    }
  };
  walk(join(REPO, 'deploy/server'));
  assert.ok(found.length > 10);
  for (const file of found) {
    const rel = relative(REPO, file).split(sep).join('/');
    if (rel === 'deploy/server/env-guard.sh') continue;
    assert.ok(!readFileSync(file, 'utf8').includes('demo-env-check.mjs'), `${rel} calls the guard directly: use env-guard.sh`);
  }
  assert.match(readFileSync(join(REPO, 'deploy/server/env-guard.sh'), 'utf8'), /demo-env-check\.mjs/);
});
test('isMain fails closed: a module whose base name is the started file but another real path throws, exit code 1', () => {
  const a = join(dir, 'ismain-a');
  const b = join(dir, 'ismain-b');
  mkdirSync(a);
  mkdirSync(b);
  const isMainText = readFileSync(join(SCRIPTS, 'is-main.mjs'), 'utf8');
  writeFileSync(join(b, 'is-main.mjs'), isMainText);
  writeFileSync(join(b, 'probe.mjs'), "import { isMain } from './is-main.mjs';\nexport default () => isMain(import.meta.url);\n");
  writeFileSync(join(a, 'probe.mjs'), "import run from '../ismain-b/probe.mjs';\nconsole.log(String(run()));\n");
  writeFileSync(join(a, 'other.mjs'), "import run from '../ismain-b/probe.mjs';\nconsole.log(String(run()));\n");
  const clash = run(join(a, 'probe.mjs'));
  assert.equal(clash.status, 1);
  assert.match(clash.stderr, /is-main: cannot confirm that probe\.mjs is the started file/);
  assert.ok(!clash.stderr.includes(a), 'the message holds no path');
  const other = run(join(a, 'other.mjs'));
  assert.equal(other.status, 0);
  assert.equal(other.stdout.trim(), 'false');
  // The started file itself, directly and through a link, is still true.
  writeFileSync(join(b, 'main.mjs'), "import { isMain } from './is-main.mjs';\nconsole.log(String(isMain(import.meta.url)));\n");
  assert.equal(run(join(b, 'main.mjs')).stdout.trim(), 'true');
  symlinkSync(b, join(a, 'dirlink'));
  assert.equal(run(join(a, 'dirlink/main.mjs')).stdout.trim(), 'true');
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
  mkdirSync(join(root, 'deploy/server'), { recursive: true });
  writeFileSync(join(root, 'deploy/server/env-guard.sh'), '#!/usr/bin/env bash\n');
  writeFileSync(join(root, 'scripts/read-env-value.mjs'), "import { isMain } from './is-main.mjs';\n");
  assert.deepEqual(checkTree(root).map((f) => `${f.kind}:${f.path}`), ['script_import_missing:scripts/read-env-value.mjs']);
  writeFileSync(join(root, 'scripts/is-main.mjs'), 'export const isMain = () => false;\n');
  assert.deepEqual(checkTree(root), []);
});
