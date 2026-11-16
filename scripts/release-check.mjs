#!/usr/bin/env node
// Release check: refuses a staged release tree that holds anything that must not reach the demo server.
//   node scripts/release-check.mjs <dir>
// It names the path and the kind of each finding and never prints the text that matched.
import { lstatSync, openSync, closeSync, readSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** @typedef {'native_binary' | 'env_file' | 'forbidden_path' | 'source_map' | 'vite_dir' | 'home_path' | 'token' | 'replay_unreviewed' | 'replay_invalid' | 'replay_folder_missing'} FindingKind */

/** First bytes of ELF and Mach-O files (thin and fat, both byte orders). */
const MAGIC = [
  [0x7f, 0x45, 0x4c, 0x46],
  [0xfe, 0xed, 0xfa, 0xce],
  [0xfe, 0xed, 0xfa, 0xcf],
  [0xce, 0xfa, 0xed, 0xfe],
  [0xcf, 0xfa, 0xed, 0xfe],
  [0xca, 0xfe, 0xba, 0xbe],
];

/** Folders that never ship, at any depth. */
const FORBIDDEN_DIRS = ['spike', 'spikes', '.agents'];

const MAX_TEXT_BYTES = 8 * 1024 * 1024;

// Patterns are built from pieces so that this file does not match itself.
const HOME_PATH = new RegExp(`(?:/${'Users'}/|/${'home'}/)[A-Za-z0-9._-]+/|[A-Za-z]:\\\\${'Users'}\\\\`);
const TOKEN_PATTERNS = [
  new RegExp(`\\b(?:${'ghp'}|${'gho'}|${'ghs'}|${'ghu'}|${'ghr'})_[A-Za-z0-9]{20,}`),
  new RegExp(`\\b${'github'}_${'pat'}_[A-Za-z0-9_]{20,}`),
  new RegExp(`\\b(?:${'AKIA'}|${'ASIA'})[A-Z0-9]{16}\\b`),
  new RegExp(`\\b${'xox'}[abprs]-[A-Za-z0-9-]{10,}`),
  new RegExp(`-----BEGIN [A-Z ]*${'PRIVATE'} KEY-----`),
  new RegExp(`${'Authorization'}:\\s*${'Bearer'}\\s+[A-Za-z0-9._~+/=-]{24,}`, 'i'),
  new RegExp(`\\b${'sk'}-[A-Za-z0-9_-]{32,}`),
];

/** @param {string} file */
function startsWithMagic(file) {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(4);
    const n = readSync(fd, buf, 0, 4, 0);
    if (n < 4) return false;
    return MAGIC.some((m) => m.every((b, i) => buf[i] === b));
  } finally {
    closeSync(fd);
  }
}

/**
 * The full validator of the replay file (`validateReplayFile` of the built shared package), or `null` when the package is
 * not built. It checks the whole file, the review and the hash that binds the review to the content.
 * @type {null | ((input: unknown) => { ok: boolean })}
 */
let sharedValidator = null;
try {
  const shared = await import(pathToFileURL(fileURLToPath(new URL('../packages/shared/dist/index.js', import.meta.url))).href);
  sharedValidator = shared.validateReplayFile;
} catch {
  sharedValidator = null;
}
const REPLAY_PATH = /^fixtures\/replays\/[^/]+\.json$/;
/** The pretty-printed file on disk is longer than the 256 KiB of compact JSON the validator allows; nothing near a MiB is a replay. */
const MAX_REPLAY_BYTES = 1024 * 1024;
/**
 * A replay file ships only when a person reviewed it (`review` has a `reviewedOn` and a `by`, both strings) and the whole file
 * passes the validator, whose check of the review hash refuses a file edited after the review. The file is named `<id>.json`.
 * @param {string} rel @param {string} text @param {typeof sharedValidator} validate
 * @returns {FindingKind[]}
 */
function replayKinds(rel, text, validate) {
  /** @type {any} */
  let file;
  try {
    file = JSON.parse(text);
  } catch {
    return ['replay_unreviewed'];
  }
  const review = file?.review;
  const named = typeof review === 'object' && review !== null && !Array.isArray(review) && typeof review.reviewedOn === 'string' && typeof review.by === 'string';
  if (!named) return ['replay_unreviewed'];
  if (validate === null) throw new Error('the shared package is not built');
  return validate(file).ok && rel === `fixtures/replays/${file.id}.json` ? [] : ['replay_invalid'];
}
/** @param {string} rel posix-style relative path */
function pathKinds(rel) {
  const parts = rel.split('/');
  const name = parts[parts.length - 1] ?? '';
  /** @type {FindingKind[]} */
  const kinds = [];
  if (name.endsWith('.node')) kinds.push('native_binary');
  if (name.startsWith('.env') && !name.endsWith('.example')) kinds.push('env_file');
  if (parts.some((p) => FORBIDDEN_DIRS.includes(p))) kinds.push('forbidden_path');
  if (name.endsWith('.map')) kinds.push('source_map');
  if (parts.includes('.vite')) kinds.push('vite_dir');
  return kinds;
}

/**
 * Walks `root` without following links and returns the findings, sorted by path then kind.
 * A finding holds a path (relative, with `/`) and a kind. It never holds matched text.
 * @param {string} root
 * @param {{ validateReplayFile?: typeof sharedValidator }} [options] the validator of the replays (default: the built shared package)
 * @returns {{ path: string; kind: FindingKind }[]}
 */
export function checkTree(root, options = {}) {
  const validate = options.validateReplayFile ?? sharedValidator;
  /** @type {{ path: string; kind: FindingKind }[]} */
  const out = [];
  /** @param {string} rel @param {FindingKind} kind */
  const add = (rel, kind) => {
    if (!out.some((f) => f.path === rel && f.kind === kind)) out.push({ path: rel, kind });
  };
  /** @param {string} dir */
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const rel = relative(root, full).split(sep).join('/');
      const st = lstatSync(full);
      for (const kind of pathKinds(rel)) add(rel, kind);
      if (st.isSymbolicLink()) {
        add(rel, 'forbidden_path');
        continue;
      }
      if (st.isDirectory()) {
        walk(full);
        continue;
      }
      if (!st.isFile()) {
        add(rel, 'forbidden_path');
        continue;
      }
      if (startsWithMagic(full)) add(rel, 'native_binary');
      if (REPLAY_PATH.test(rel) && st.size > MAX_REPLAY_BYTES) add(rel, 'replay_invalid');
      if (st.size > MAX_TEXT_BYTES) continue;
      const data = readFileSync(full);
      if (data.includes(0)) continue;
      const text = data.toString('utf8');
      if (REPLAY_PATH.test(rel) && st.size <= MAX_REPLAY_BYTES) for (const kind of replayKinds(rel, text, validate)) add(rel, kind);
      if (HOME_PATH.test(text)) add(rel, 'home_path');
      if (TOKEN_PATTERNS.some((re) => re.test(text))) add(rel, 'token');
    }
  };
  walk(root);
  // The seed refuses a missing replay folder, and the tarball keeps a folder only through a file in it (the README).
  try {
    if (!lstatSync(join(root, 'fixtures', 'replays')).isDirectory() && !out.some((f) => f.path === 'fixtures/replays')) add('fixtures/replays', 'replay_folder_missing');
  } catch {
    add('fixtures/replays', 'replay_folder_missing');
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
}

/** @param {{ path: string; kind: string }[]} findings */
export function formatFindings(findings) {
  return findings.map((f) => `release-check: ${f.kind}: ${f.path}`).join('\n');
}

function main() {
  const dir = process.argv[2];
  if (!dir || process.argv.length > 3) {
    process.stderr.write(`usage: ${basename(process.argv[1] ?? 'release-check.mjs')} <dir>\n`);
    process.exit(2);
  }
  let findings;
  try {
    findings = checkTree(dir);
  } catch (err) {
    process.stderr.write(err instanceof Error && err.message === 'the shared package is not built' ? 'release-check: the shared package is not built (run pnpm build)\n' : 'release-check: cannot read the tree\n');
    process.exit(2);
  }
  if (findings.length === 0) {
    process.stdout.write('release-check: ok\n');
    return;
  }
  process.stderr.write(`${formatFindings(findings)}\n`);
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
