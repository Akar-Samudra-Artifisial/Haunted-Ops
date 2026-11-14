// Makes a small executable that runs the fake fixer with one fixture, for `KIRO_CLI_PATH`-style use by the fix
// runner. The fixer environment is a fixed list of names and cannot carry the fixture name, so the wrapper sets it.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const fake = join(dirname(fileURLToPath(import.meta.url)), 'fake-kiro-fixer.mjs');
const q = (s) => `'${String(s).replaceAll("'", `'\\''`)}'`;

/**
 * @param {{ fixture: string, dir?: string, observe?: boolean }} opts
 *   `fixture`: a name in `fixtures/fixer/` (without suffix) or an absolute path;
 *   `observe`: also write what the fake saw to `<dir>/observed.json`.
 */
export function createFakeKiroFixer(opts) {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), 'fake-fixer-'));
  const path = join(dir, 'kiro-cli');
  const observePath = join(dir, 'observed.json');
  const lines = ['#!/bin/sh', `export FAKE_KIRO_FIXTURE=${q(opts.fixture)}`];
  if (opts.observe) lines.push(`export FAKE_KIRO_OBSERVE=${q(observePath)}`);
  lines.push(`exec ${q(process.execPath)} ${q(fake)} "$@"`);
  writeFileSync(path, `${lines.join('\n')}\n`, { mode: 0o755 });
  chmodSync(path, 0o755);
  return { path, observePath, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export const FAKE_KIRO_FIXER = fake;
