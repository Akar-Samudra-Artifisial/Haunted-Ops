import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkTree, formatFindings } from './release-check.mjs';

const SCRIPT = fileURLToPath(new URL('./release-check.mjs', import.meta.url));
const roots = [];
/** A fixture tree: { 'relative/path': string | Buffer }. */
function tree(files) {
  const root = mkdtempSync(join(tmpdir(), 'release-check-'));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

// Strings that look like secrets, built from pieces so that this file holds none of them whole.
const fakeGithubToken = `${'gh'}${'p'}_${'A1b2C3d4E5f6G7h8I9j0'}${'K1l2M3n4'}`;
const fakeAwsKey = `${'AK'}${'IA'}${'ABCDEFGHIJKLMNOP'}`;
const fakeHome = `/${'Users'}/someone/project`;
const fakeBearer = `Authorization: ${'Bearer'} ${'abcdefghijklmnopqrstuvwxyz0123456789'}`;
const fakeKeyBlock = `-----BEGIN ${'PRIVATE'} KEY-----`;

const CLEAN = {
  'package.json': '{"name":"x"}\n',
  'apps/web/dist/index.html': '<!doctype html><title>x</title>\n',
  'apps/web/dist/assets/index-abc.js': 'console.log("hello")\n',
  'apps/api/dist/main.js': 'export const a = 1;\n',
  'deploy/server/env/api.env.example': 'NODE_ENV=production\nHUNT_ADMIN_TOKEN=CHANGE_ME_HUNT_ADMIN_TOKEN\n',
};

test('a clean tree has no finding', () => {
  assert.deepEqual(checkTree(tree(CLEAN)), []);
});

test('each forbidden item is found with its kind and path', () => {
  const cases = [
    ['native_binary', 'apps/api/node_modules/x/addon.node', 'not really a binary'],
    ['native_binary', 'bin/tool', Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0])],
    ['native_binary', 'bin/mac', Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 7, 0, 0, 1])],
    ['native_binary', 'bin/fat', Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 2])],
    ['env_file', '.env', 'A=1\n'],
    ['env_file', 'apps/api/.env.local', 'A=1\n'],
    ['forbidden_path', 'spike/notes.md', 'x'],
    ['forbidden_path', 'spikes/g0/a.js', 'x'],
    ['forbidden_path', '.agents/tasks/a.md', 'x'],
    ['source_map', 'apps/web/dist/assets/index-abc.js.map', '{}'],
    ['vite_dir', 'apps/web/dist/.vite/manifest.json', '{}'],
    ['home_path', 'apps/api/dist/leak.js', `const p = "${fakeHome}/a";`],
    ['home_path', 'notes.txt', 'C:\\' + 'Users' + '\\someone\\x'],
    ['token', 'apps/api/dist/t1.js', `const t = "${fakeGithubToken}";`],
    ['token', 'apps/api/dist/t2.js', `k = ${fakeAwsKey}`],
    ['token', 'apps/api/dist/t3.js', fakeBearer],
    ['token', 'apps/api/dist/t4.js', fakeKeyBlock],
  ];
  for (const [kind, path, content] of cases) {
    const found = checkTree(tree({ ...CLEAN, [path]: content }));
    assert.ok(
      found.some((f) => f.kind === kind && f.path === path),
      `${kind} at ${path}: ${JSON.stringify(found)}`,
    );
    // The folder that holds the item may be flagged too (for example `.vite`), nothing else.
    assert.ok(found.every((f) => f.path === path || path.startsWith(`${f.path}/`)), 'only the added path is flagged');
  }
});

test('an .example env file is allowed, but its tokens are not', () => {
  assert.deepEqual(checkTree(tree({ ...CLEAN, 'deploy/server/env/lab.env.example': 'CHAOS_TOKEN=CHANGE_ME_CHAOS_TOKEN\n' })), []);
  const found = checkTree(tree({ ...CLEAN, 'deploy/server/env/x.env.example': `T=${fakeGithubToken}\n` }));
  assert.deepEqual(found.map((f) => f.kind), ['token']);
});

test('a symlink is a finding and is not followed', () => {
  const root = tree(CLEAN);
  symlinkSync('/etc', join(root, 'link'));
  const found = checkTree(root);
  assert.deepEqual(found, [{ path: 'link', kind: 'forbidden_path' }]);
});

test('findings never hold the matched text, and the CLI prints no match', () => {
  const root = tree({ ...CLEAN, 'leak.js': `a = "${fakeGithubToken}"; b = "${fakeHome}/x"` });
  const text = formatFindings(checkTree(root));
  assert.ok(!text.includes(fakeGithubToken) && !text.includes('someone'));
  const res = spawnSync(process.execPath, [SCRIPT, root], { encoding: 'utf8' });
  assert.equal(res.status, 1);
  assert.ok(!res.stderr.includes(fakeGithubToken) && !res.stderr.includes('someone'));
  assert.match(res.stderr, /release-check: token: leak\.js/);
  assert.match(res.stderr, /release-check: home_path: leak\.js/);
});

test('the CLI exits 0 on a clean tree and 2 on a usage error', () => {
  const ok = spawnSync(process.execPath, [SCRIPT, tree(CLEAN)], { encoding: 'utf8' });
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout.trim(), 'release-check: ok');
  assert.equal(spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' }).status, 2);
  assert.equal(spawnSync(process.execPath, [SCRIPT, join(tmpdir(), 'does-not-exist-release-check')], { encoding: 'utf8' }).status, 2);
});
