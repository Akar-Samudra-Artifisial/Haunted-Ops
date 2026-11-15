// deploy/pack-release.sh on a fixture stage with private modes (0600 files, 0700 folders) and different times:
// the tarball has public modes, owner 0/0, sorted names, and is the same bytes for the same content.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
const PACK = fileURLToPath(new URL('../deploy/pack-release.sh', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'pack-release-'));
after(() => rmSync(root, { recursive: true, force: true }));
const EPOCH = 1_794_737_505;
const FILES = [
  ['package.json', '{"name":"x"}\n', 0o600],
  ['apps/web/dist/index.html', '<!doctype html>\n', 0o600],
  ['apps/web/dist/assets/app.js', 'console.log(1)\n', 0o400],
  ['deploy/server/install.sh', '#!/usr/bin/env bash\n', 0o700],
  ['deploy/server/versions.env', 'A=1\n', 0o640],
  ['RELEASE-INFO', 'commit=x\n', 0o600],
];
/** Makes a stage with private modes; `mtime` differs between stages so that the pack has to normalise it. */
function makeStage(name, mtime, order = FILES) {
  const stage = join(root, name);
  mkdirSync(stage, { mode: 0o700 });
  for (const [rel, text, mode] of order) {
    const full = join(stage, rel);
    mkdirSync(dirname(full), { recursive: true, mode: 0o700 });
    writeFileSync(full, text);
    chmodSync(full, mode);
    utimesSync(full, mtime, mtime);
  }
  // Every folder is private too.
  for (const dir of ['apps', 'apps/web', 'apps/web/dist', 'apps/web/dist/assets', 'deploy', 'deploy/server']) chmodSync(join(stage, dir), 0o700);
  chmodSync(stage, 0o700);
  return stage;
}
const pack = (stage, name, epoch = EPOCH) => {
  const tarball = join(root, name);
  const res = spawnSync('bash', [PACK, stage, tarball, String(epoch)], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  return tarball;
};
const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
/** A small tar reader: name, mode, uid, gid and mtime of each file entry (handles pax path records). */
function readTar(file) {
  const data = gunzipSync(readFileSync(file));
  const entries = [];
  let nextPath = null;
  const octal = (start, end) => Number.parseInt(data.toString('latin1', start, end).replace(/\0.*$/s, '').trim() || '0', 8);
  for (let at = 0; at + 512 <= data.length; ) {
    const name = data.toString('latin1', at, at + 100).replace(/\0.*$/s, '');
    if (name === '') break;
    const type = String.fromCharCode(data[at + 156] ?? 0);
    const size = octal(at + 124, at + 136);
    const body = data.toString('latin1', at + 512, at + 512 + size);
    if (type === 'x') {
      const m = /\d+ path=([^\n]*)\n/.exec(body);
      nextPath = m ? m[1] : null;
    } else if (type === '0' || type === '\0') {
      entries.push({ name: nextPath ?? name, mode: octal(at + 100, at + 108) & 0o7777, uid: octal(at + 108, at + 116), gid: octal(at + 116, at + 124), mtime: octal(at + 136, at + 148) });
      nextPath = null;
    }
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}
test('modes are public, owner is 0/0, scripts are executable, the time is the commit time, names are sorted', () => {
  const tarball = pack(makeStage('a', 1_000_000), 'a.tar.gz');
  const entries = readTar(tarball);
  assert.equal(entries.length, FILES.length);
  const names = entries.map((e) => e.name.replace(/^\.\//, ''));
  assert.deepEqual(names, [...names].sort());
  for (const e of entries) {
    const name = e.name.replace(/^\.\//, '');
    assert.equal(e.mode, name === 'deploy/server/install.sh' ? 0o755 : 0o644, name);
    assert.equal(e.uid, 0, `${name}: uid`);
    assert.equal(e.gid, 0, `${name}: gid`);
    assert.equal(e.mtime, EPOCH, `${name}: mtime`);
  }
});
test('the stage itself gets 0755 folders and 0644 files', async () => {
  const { statSync } = await import('node:fs');
  const stage = makeStage('b', 5);
  pack(stage, 'b.tar.gz');
  assert.equal(statSync(join(stage, 'apps/web/dist')).mode & 0o7777, 0o755);
  assert.equal(statSync(stage).mode & 0o7777, 0o755);
  assert.equal(statSync(join(stage, 'package.json')).mode & 0o7777, 0o644);
  assert.equal(statSync(join(stage, 'deploy/server/install.sh')).mode & 0o7777, 0o755);
});
test('two builds of the same content give the same sha256, whatever the times, modes and creation order', () => {
  const first = pack(makeStage('c1', 1_000), 'c1.tar.gz');
  const second = pack(makeStage('c2', 2_000_000_000, [...FILES].reverse()), 'c2.tar.gz');
  assert.equal(sha(first), sha(second));
  const other = pack(makeStage('c3', 1_000), 'c3.tar.gz', EPOCH + 1);
  assert.notEqual(sha(first), sha(other), 'the commit time is part of the archive');
});
test('usage errors exit 2', () => {
  assert.equal(spawnSync('bash', [PACK], { encoding: 'utf8' }).status, 2);
  assert.equal(spawnSync('bash', [PACK, root, join(root, 'x.tar.gz'), 'soon'], { encoding: 'utf8' }).status, 2);
  assert.equal(spawnSync('bash', [PACK, join(root, 'missing'), join(root, 'x.tar.gz'), '1'], { encoding: 'utf8' }).status, 1);
});
