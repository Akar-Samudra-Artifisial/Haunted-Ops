#!/usr/bin/env node
// Prints a plain-text reading of a replay file for the person who approves it, and, only with `--approve`, writes the
// `review` block. Nothing is approved without that flag, and the file is checked again before the block is written.
//
//   node tools/replay-build/review-replay.mjs <file> --by <initials> [--note <text>] [--approve]
//
// The reading lists every string of every frame with its path (a string that has not changed since the last frame that
// had it is not repeated). Read all of it. Look for names, hosts, paths, secrets and anything that identifies a person or
// a machine, then run the command again with `--approve`.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
/** Every string leaf of `value` as `[path, text]`. */
export function stringsOf(value, path = '$') {
  if (typeof value === 'string') return [[path, value]];
  if (Array.isArray(value)) return value.flatMap((v, i) => stringsOf(v, `${path}[${i}]`));
  if (isRecord(value)) return Object.entries(value).flatMap(([k, v]) => stringsOf(v, `${path}.${k}`));
  return [];
}
const show = (text) => JSON.stringify(text);
/** The reading, as lines. */
export function readingOf(file) {
  const lines = [];
  lines.push(`Replay ${show(file.id)}: ${show(file.title)}`);
  lines.push(`scenario ${file.scenario}, recorded on ${file.recordedOn}, ${file.durationMs} ms, ${file.frames.length} frames`);
  lines.push(file.review === null ? 'review: none yet' : `review: ${file.review.reviewedOn} by ${file.review.by}: ${show(file.review.note)} (sha256 ${file.review.sha256})`);
  lines.push('', 'Header strings');
  for (const key of ['id', 'title', 'scenario', 'recordedOn']) lines.push(`  $.${key}: ${show(file[key])}`);
  const shown = new Map();
  file.frames.forEach((frame, i) => {
    lines.push('', `Frame ${i} at ${frame.t} ms (${['services', 'hunt', 'proposal'].filter((k) => k in frame).join(', ') || 'nothing'})`);
    let count = 0;
    for (const [path, text] of stringsOf(frame, `frames[${i}]`)) {
      const key = path.replace(/^frames\[\d+\]/, '');
      if (shown.get(key) === text) continue;
      shown.set(key, text);
      lines.push(`  ${path}: ${show(text)}`);
      count += 1;
    }
    if (count === 0) lines.push('  (no new string)');
  });
  return lines;
}
async function loadValidator() {
  const shared = await import(pathToFileURL(join(ROOT, 'packages/shared/dist/index.js')).href);
  return { validate: shared.validateReplayFile, reviewHash: shared.replayReviewHash };
}
function parseArgs(argv) {
  const out = { approve: false, file: null, by: null, note: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--approve') out.approve = true;
    else if (a === '--by' && argv[i + 1] !== undefined) out.by = argv[++i];
    else if (a === '--note' && argv[i + 1] !== undefined) out.note = argv[++i];
    else if (!a.startsWith('--') && out.file === null) out.file = a;
    else return null;
  }
  return out.file === null || out.by === null ? null : out;
}
export async function main(argv, io = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) }, today = () => new Date().toISOString().slice(0, 10)) {
  const args = parseArgs(argv);
  if (args === null) {
    io.err('usage: review-replay.mjs <file> --by <initials> [--note <text>] [--approve]\n');
    return 2;
  }
  let file;
  try {
    file = JSON.parse(readFileSync(args.file, 'utf8'));
  } catch {
    io.err('cannot read the file as JSON\n');
    return 1;
  }
  const { validate, reviewHash } = await loadValidator();
  // The file is checked as it would be without a review: an edit after an earlier review makes its hash stale, and this
  // is the tool that reads the file again and writes a new one.
  const before = validate({ ...file, review: null });
  if (!before.ok) {
    io.err(`the file is not a valid replay: ${before.errors.join(' ')}\n`);
    return 1;
  }
  const stale = file.review !== null && !validate(file).ok;
  io.out(`${readingOf(file).join('\n')}\n`);
  if (stale) io.out('\nThe review in this file does not match its content any more (it was edited, or the review is not valid). Read it again.\n');
  if (!args.approve) {
    io.out('\nNot approved. Read the text above, then run the same command with --approve.\n');
    return 0;
  }
  // The review is bound to the content: `sha256` is the hash of the file with `review` set to null. Edit the file
  // afterwards and the hash no longer matches, so the validator, the release check and the seed refuse it.
  const next = { ...file, review: { reviewedOn: today(), by: args.by, note: args.note, sha256: reviewHash(file) } };
  const after = validate(next);
  if (!after.ok) {
    io.err(`the review block is not valid: ${after.errors.join(' ')}\n`);
    return 1;
  }
  writeFileSync(args.file, `${JSON.stringify(next, null, 2)}\n`);
  io.out(`\nApproved by ${args.by} on ${next.review.reviewedOn}.\n`);
  return 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(await main(process.argv.slice(2)));
