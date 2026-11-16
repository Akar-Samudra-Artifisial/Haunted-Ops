import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { main, readingOf, stringsOf } from './review-replay.mjs';
const { replayReviewHash, validateReplayFile } = await import(pathToFileURL(fileURLToPath(new URL('../../packages/shared/dist/index.js', import.meta.url))).href);
const SYNTHETIC = fileURLToPath(new URL('../../apps/api/test/fixtures/replays/synthetic-error-spike.json', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'review-replay-'));
after(() => rmSync(dir, { recursive: true, force: true }));
let file;
// Always a copy in a temporary folder: a real file under fixtures/replays is never touched by a test.
beforeEach(() => {
  file = join(dir, 'copy.json');
  const unreviewed = { ...JSON.parse(readFileSync(SYNTHETIC, 'utf8')), review: null };
  writeFileSync(file, `${JSON.stringify(unreviewed, null, 2)}\n`);
});
const run = async (argv, today) => {
  const out = [];
  const err = [];
  const code = await main(argv, { out: (s) => out.push(s), err: (s) => err.push(s) }, today);
  return { code, out: out.join(''), err: err.join('') };
};
test('prints every string with its path, frame by frame, and does not approve without --approve', async () => {
  const before = readFileSync(file, 'utf8');
  const r = await run([file, '--by', 'AB']);
  assert.equal(r.code, 0);
  assert.match(r.out, /review: none yet/);
  assert.match(r.out, /^Frame 0 at 0 ms/m);
  assert.match(r.out, /frames\[0\]\.services\[0\]\.name: "gate"/);
  assert.match(r.out, /Not approved/);
  assert.match(r.out, /\$\.title: "Synthetic/);
  assert.equal(readFileSync(file, 'utf8'), before);
});
test('lists each string of the file at least once, and a repeated string only where it changed', () => {
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  const text = readingOf(parsed).join('\n');
  for (const [, value] of stringsOf(parsed.frames)) assert.ok(text.includes(JSON.stringify(value)), value);
  assert.ok((text.match(/frames\[\d+\]\.services\[0\]\.name/g) ?? []).length < parsed.frames.filter((f) => f.services).length);
});
test('with --approve it writes the review block and nothing else', async () => {
  const before = JSON.parse(readFileSync(file, 'utf8'));
  const r = await run([file, '--by', 'AB', '--note', 'Read all of it.', '--approve'], () => '2026-11-16');
  assert.equal(r.code, 0);
  const after = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(after.review, { reviewedOn: '2026-11-16', by: 'AB', note: 'Read all of it.', sha256: replayReviewHash(before) });
  assert.equal(validateReplayFile(after).ok, true);
  assert.deepEqual({ ...after, review: null }, before);
  assert.ok(readFileSync(file, 'utf8').endsWith('\n'));
});
test('refuses initials or a note that make the review invalid, and leaves the file as it was', async () => {
  const before = readFileSync(file, 'utf8');
  for (const args of [['--by', 'A'], ['--by', 'ABCDE'], ['--by', 'A1'], ['--by', 'AB', '--note', 'x '.repeat(101)]]) {
    const r = await run([file, ...args, '--approve']);
    assert.equal(r.code, 1, args.join(' '));
    assert.match(r.err, /review block is not valid/);
    assert.equal(readFileSync(file, 'utf8'), before);
  }
});
test('refuses a file that is not a valid replay, and prints paths only', async () => {
  const bad = JSON.parse(readFileSync(file, 'utf8'));
  bad.title = ['mail', ['ops', 'example.test'].join('@')].join(' ');
  writeFileSync(file, JSON.stringify(bad));
  const before = readFileSync(file, 'utf8');
  const r = await run([file, '--by', 'AB', '--approve']);
  assert.equal(r.code, 1);
  assert.match(r.err, /\$\.title/);
  assert.ok(!r.err.includes('example.test'));
  assert.equal(readFileSync(file, 'utf8'), before);
  writeFileSync(file, '{ nope');
  assert.equal((await run([file, '--by', 'AB'])).code, 1);
});
test('usage: a file and --by are required; an unknown flag is refused', async () => {
  assert.equal((await run([])).code, 2);
  assert.equal((await run([file])).code, 2);
  assert.equal((await run([file, '--by', 'AB', '--force'])).code, 2);
  const copy = join(dir, 'other.json');
  cpSync(file, copy);
  assert.equal((await run([file, copy, '--by', 'AB'])).code, 2);
});
test('the review is bound to the content: editing the file makes it stale, and reviewing again writes a new hash', async () => {
  await run([file, '--by', 'AB', '--approve'], () => '2026-11-16');
  const approved = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(validateReplayFile(approved).ok, true);
  const edited = { ...approved, title: 'Synthetic: edited after the review' };
  assert.equal(validateReplayFile(edited).ok, false);
  writeFileSync(file, `${JSON.stringify(edited, null, 2)}\n`);
  const reading = await run([file, '--by', 'AB']);
  assert.equal(reading.code, 0);
  assert.match(reading.out, /does not match its content any more/);
  const again = await run([file, '--by', 'AB', '--approve'], () => '2026-11-17');
  assert.equal(again.code, 0);
  const renewed = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(validateReplayFile(renewed).ok, true);
  assert.equal(renewed.review.reviewedOn, '2026-11-17');
  assert.notEqual(renewed.review.sha256, approved.review.sha256);
});
