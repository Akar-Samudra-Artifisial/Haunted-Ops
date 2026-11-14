import { spawn } from 'node:child_process';
import { mkdir, readdir, lstat, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ServiceName } from '@haunted-ops/shared';
import type { TestsResult } from './patch-checks.js';

/** The most test files passed to one run, and the most output read from it. */
export const MAX_TEST_FILES = 100;
export const MAX_CHECK_OUTPUT = 1024 * 1024;
const TEST_FILE = /^[A-Za-z0-9._@-]+\.(test|spec)\.(js|mjs|cjs)$/;
const SAFE_DIR = /^[A-Za-z0-9._@-]+$/;

/**
 * The test files of `services/<service>/` in a clone: `*.test.js`, `*.test.mjs` and `*.test.cjs` (and `.spec`), at
 * most 100, as paths relative to the clone, sorted. Names are checked, so no file can put an option on the command line.
 */
export async function findTestFiles(clone: string, service: ServiceName): Promise<string[]> {
  const out: string[] = [];
  const visit = async (rel: string): Promise<void> => {
    for (const name of (await readdir(join(clone, rel))).sort()) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const path = `${rel}/${name}`;
      const s = await lstat(join(clone, path));
      if (s.isDirectory() && SAFE_DIR.test(name)) await visit(path);
      else if (s.isFile() && TEST_FILE.test(name)) out.push(path);
      if (out.length >= MAX_TEST_FILES) return;
    }
  };
  await visit(`services/${service}`);
  return out.slice(0, MAX_TEST_FILES);
}

export interface CheckRunOptions {
  /** The clone the tests run in. */
  clone: string;
  /** Test files relative to the clone, from `findTestFiles`. */
  testFiles: readonly string[];
  timeoutMs: number;
  /** Test seam: the `node` to run. */
  nodePath?: string;
}

/** The temporary folder the run may write to, inside the clone. */
export const CHECK_TMP = '.fix-tmp';

/**
 * The argument vector of the test run, fixed apart from the clone, the files and the timeout: `node --permission`
 * with read access to the clone, write access to one temporary folder inside it, no child process, no worker, no
 * addon, no WASI and no `--allow-net` (so no network where Node enforces it), and the test runner in the same
 * process (`--test-isolation=none`: a child process per file would need `--allow-child-process`).
 */
export function buildCheckArgv(o: Pick<CheckRunOptions, 'clone' | 'testFiles' | 'timeoutMs'>): string[] {
  return [
    '--permission',
    `--allow-fs-read=${o.clone}`,
    `--allow-fs-write=${join(o.clone, CHECK_TMP)}`,
    '--test',
    '--test-isolation=none',
    '--test-reporter=tap',
    `--test-timeout=${Math.max(1000, o.timeoutMs - 5000)}`,
    ...o.testFiles,
  ];
}

/** The environment of the test run: `PATH` and nothing else. */
export function buildCheckEnv(nodePath: string): Record<string, string> {
  return { PATH: dirname(nodePath) };
}

/** Reads the counts of a TAP report: `# tests N`, `# pass N`, `# fail N`. */
export function parseTap(text: string): { tests: number; pass: number; fail: number } {
  const n = (name: string): number => Number(new RegExp(`^# ${name} (\\d+)`, 'm').exec(text)?.[1] ?? 0);
  return { tests: n('tests'), pass: n('pass'), fail: n('fail') };
}

/**
 * Runs the tests of a candidate under `node --permission`, with an empty environment, in its own process group,
 * and stops the whole group after `timeoutMs` (SIGTERM, then SIGKILL). Only the exit code and the counts of the
 * report are kept: no output text leaves this function. This is the one place the launcher lives, so that
 * `deploy-demo` can replace it with a run as another OS user.
 */
export async function runChecks(o: CheckRunOptions): Promise<TestsResult> {
  if (o.testFiles.length === 0) return { ok: true, ran: 0, timedOut: false };
  const nodePath = o.nodePath ?? process.execPath;
  // The fence is made of real paths: `/var` on macOS is a link, and a grant on a link covers nothing.
  const clone = await realpath(o.clone);
  await mkdir(join(clone, CHECK_TMP), { recursive: true });
  return new Promise((resolve) => {
    let out = '';
    let timedOut = false;
    let settled = false;
    const child = spawn(nodePath, buildCheckArgv({ ...o, clone }), { cwd: clone, env: buildCheckEnv(nodePath), detached: true, stdio: ['ignore', 'pipe', 'ignore'], shell: false, windowsHide: true });
    const killGroup = (signal: NodeJS.Signals): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, signal);
      } catch {
        // Already gone.
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      setTimeout(() => killGroup('SIGKILL'), 2000).unref();
    }, o.timeoutMs);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (out.length < MAX_CHECK_OUTPUT) out += chunk.slice(0, MAX_CHECK_OUTPUT - out.length);
    });
    const done = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killGroup('SIGKILL');
      const counts = parseTap(out);
      resolve({ ok: !timedOut && code === 0 && counts.fail === 0, ran: counts.tests, timedOut });
    };
    child.on('error', () => done(null));
    child.on('close', (code) => done(code));
  });
}

/** `node --check` on one file, with the same empty environment: true when it parses. */
export async function checkSyntax(cloneDir: string, file: string, nodePath: string = process.execPath, timeoutMs = 15_000): Promise<boolean> {
  if (!/^[A-Za-z0-9._@][A-Za-z0-9._/@-]{0,249}$/.test(file) || file.split('/').includes('..')) return false;
  const clone = await realpath(cloneDir).catch(() => null);
  if (clone === null) return false;
  return new Promise((resolve) => {
    const child = spawn(nodePath, ['--permission', `--allow-fs-read=${clone}`, '--check', join(clone, file)], { cwd: clone, env: buildCheckEnv(nodePath), stdio: 'ignore', shell: false, windowsHide: true, timeout: timeoutMs });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}
