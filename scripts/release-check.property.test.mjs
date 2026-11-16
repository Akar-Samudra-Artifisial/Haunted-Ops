import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import fc from 'fast-check';
import { checkTree, formatFindings } from './release-check.mjs';

const root = mkdtempSync(join(tmpdir(), 'release-prop-'));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
/** Makes a fresh tree folder from { path: content } and returns it. */
function make(files) {
  const dir = join(root, `t${n++}`);
  mkdirSync(dir);
  // A release always carries the replay folder (the README keeps it in the tarball).
  mkdirSync(join(dir, 'fixtures/replays'), { recursive: true });
  writeFileSync(join(dir, 'fixtures/replays/README.md'), '# Replays\n');
  mkdirSync(join(dir, 'deploy/server'), { recursive: true });
  writeFileSync(join(dir, 'deploy/server/env-guard.sh'), '#!/usr/bin/env bash\n');
  for (const [rel, content] of files) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

// Harmless names and text: lower-case letters, digits, dashes, spaces. Never a forbidden name, path or pattern.
const segment = fc.stringMatching(/^[a-z][a-z0-9-]{0,7}$/).filter((s) => !['spike', 'spikes'].includes(s));
const harmlessPath = fc.tuple(fc.array(segment, { minLength: 0, maxLength: 3 }), segment, fc.constantFrom('.js', '.json', '.txt', '.md', '')).map(([dirs, name, ext]) => [...dirs, `${name}${ext}`].join('/'));
const harmlessText = fc.stringMatching(/^[a-z0-9 \n-]{0,60}$/);
const harmlessFiles = fc.uniqueArray(fc.tuple(harmlessPath, harmlessText), { selector: ([p]) => p, maxLength: 8 }).filter((files) => {
  // No path may be both a file and the folder of another file.
  const paths = files.map(([p]) => p);
  return paths.every((p) => !paths.some((q) => q !== p && q.startsWith(`${p}/`)));
});

// One forbidden item: [kind, path, content]. Pieces are joined at run time so this file holds no secret or home path whole.
const forbidden = fc.constantFrom(
  ['native_binary', 'lib/addon.node', 'x'],
  ['native_binary', 'bin/elf', Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0, 0])],
  ['native_binary', 'bin/macho', Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0])],
  ['env_file', '.env', 'a=b'],
  ['env_file', '.env.production', 'a=b'],
  ['forbidden_path', 'spike/a.txt', 'x'],
  ['forbidden_path', 'spikes/a.txt', 'x'],
  ['forbidden_path', '.agents/a.txt', 'x'],
  ['source_map', 'a/b.js.map', '{}'],
  ['vite_dir', '.vite/manifest.json', '{}'],
  ['home_path', 'h.txt', `see /${'Users'}/me/code`],
  ['home_path', 'h2.txt', `see /${'home'}/me/code`],
  ['token', 't.txt', `${'github'}_${'pat'}_${'0123456789abcdef0123456789'}`],
  ['token', 't2.txt', `${'AS'}${'IA'}${'0123456789ABCDEF'}`],
  ['token', 't3.txt', `${'xox'}b-${'0123456789'}-abc`],
  ['token', 't4.txt', `-----BEGIN RSA ${'PRIVATE'} KEY-----`],
);

test('Property 3: a harmless tree is clean', () => {
  // Feature: deploy-demo, Property 3
  fc.assert(
    fc.property(harmlessFiles, (files) => {
      assert.deepEqual(checkTree(make(files)), []);
    }),
    { numRuns: 100 },
  );
});

test('Property 3: one forbidden item, at any depth, is found with its kind and path, without its text', () => {
  // Feature: deploy-demo, Property 3
  fc.assert(
    fc.property(harmlessFiles, forbidden, fc.array(segment, { minLength: 0, maxLength: 2 }), (files, [kind, path, content], prefix) => {
      const where = [...prefix, path].join('/');
      const dir = make([...files, [where, content]]);
      const found = checkTree(dir);
      assert.ok(found.some((f) => f.kind === kind && f.path === where), `${kind} not found at ${where}`);
      const printed = formatFindings(found);
      if (typeof content === 'string' && content.length > 8) assert.ok(!printed.includes(content), 'the match is printed');
    }),
    { numRuns: 150 },
  );
});
