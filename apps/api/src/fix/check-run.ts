import { spawn } from 'node:child_process';
import { lstat, mkdir, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ServiceName } from '@haunted-ops/shared';
import { cleanDiagnostic, LabDepsError, linkDeps, runBounded, unlinkDeps } from './lab-deps.js';
import type { TestsResult } from './patch-checks.js';

/** The most test files passed to one run, and the most output read from it. */
export const MAX_TEST_FILES = 100;
export const MAX_CHECK_OUTPUT = 1024 * 1024;
const TEST_FILE = /^[A-Za-z0-9._@-]+\.(test|spec)\.(js|mjs|cjs|ts|mts|cts)$/;
const SAFE_DIR = /^[A-Za-z0-9._@-]+$/;

/**
 * The test files of `services/<service>/` in a clone: `*.test.{js,mjs,cjs,ts,mts,cts}` (and `.spec`), at most 100,
 * as paths relative to the clone, sorted. Names are checked, so no file can put an option on the command line.
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

/** How a service runs its tests: `node --test`, or the lab's own vitest (its `scripts.test` starts with `vitest`). */
export type TestRunner = 'node' | 'vitest';

/** Reads `services/<service>/package.json` of the clone (a regular file, at most 64 KiB) and picks the runner. */
export async function detectRunner(clone: string, service: ServiceName): Promise<TestRunner> {
  const file = join(clone, 'services', service, 'package.json');
  try {
    const s = await lstat(file);
    if (!s.isFile() || s.size > 64 * 1024) return 'node';
    const pkg = JSON.parse(await readFile(file, 'utf8')) as { scripts?: { test?: unknown } };
    return typeof pkg.scripts?.test === 'string' && /^vitest(\s|$)/.test(pkg.scripts.test.trim()) ? 'vitest' : 'node';
  } catch {
    return 'node';
  }
}

/** Config files vitest would load and run in its main process. The lab has none; a clone that has one is refused. */
const VITEST_CONFIG = /^(vitest|vite)\.(config|workspace|projects)\.[cm]?[jt]s$|^vitest\.(workspace|projects)\.json$/;

export async function hasVitestConfig(clone: string, service: ServiceName): Promise<boolean> {
  for (const dir of [clone, join(clone, 'services', service)]) {
    const names = await readdir(dir).catch(() => [] as string[]);
    if (names.some((n) => VITEST_CONFIG.test(n))) return true;
  }
  return false;
}

/** One line for the API log about a test run: counts, the exit, and the first 2 KiB of stderr with paths removed. */
export interface CheckRunLog {
  runner: TestRunner;
  code: string | null;
  exitCode: number | null;
  timedOut: boolean;
  tests: number;
  pass: number;
  fail: number;
  stderr: string;
  /** The first failing suite's message (vitest), cleaned like stderr, at most 300 characters. */
  suiteError?: string;
}

export interface CheckRunOptions {
  /** The clone the tests run in. */
  clone: string;
  /** Test files relative to the clone, from `findTestFiles`. */
  testFiles: readonly string[];
  timeoutMs: number;
  /** `node` (the default) or `vitest`, from `detectRunner`. */
  runner?: TestRunner;
  /** The service whose tests run (needed by vitest, which runs from the service folder). */
  service?: ServiceName;
  /** The lab dependency tree (`LabDeps.ensure`); required by vitest. */
  deps?: string | null;
  /** Where the diagnostics line goes (the API log). */
  log?: (fields: CheckRunLog) => void;
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

export interface VitestArgvInput {
  /** Real paths. */
  clone: string;
  deps: string;
  /** The real path of the `node` binary (a forked worker reads it). */
  nodeBinary: string;
  /** The real path of `vitest.mjs` inside `deps`. */
  vitestEntry: string;
  service: ServiceName;
  /** Test files relative to the service folder. */
  files: readonly string[];
  /** The JSON report, inside the temporary folder. */
  outFile: string;
}

/**
 * The argument vector of a vitest run. Two fences, both `node --permission`:
 *  - The vitest main process reads the clone, the tree and the node binary, writes only the temporary folder, may
 *    start child processes (its `forks` pool) and load addons (the native binding of its bundler, rolldown, which
 *    has no other build here). It never runs code of the clone: test and source files are only transformed there,
 *    and no config file is allowed (`hasVitestConfig`).
 *  - Each test worker is forked with its own `--permission` set, passed with `--execArgv`: the same reads, the same
 *    write folder, and no child process, no worker, no addon, no WASI, no network. A forked child gets exactly the
 *    flags it is given, so the main process's two extra grants do not reach the code under test.
 * `threads` is not used: a worker thread started with an `execArgv` of its own runs outside the permission model on
 * Node 26 (checked by a test), and vitest always passes one. One worker, no file parallelism, no module cache.
 */
export function buildVitestArgv(o: VitestArgvInput): string[] {
  const tmp = join(o.clone, CHECK_TMP);
  const reads = [o.clone, o.deps, o.nodeBinary];
  const fence = ['--permission', ...reads.map((r) => `--allow-fs-read=${r}`), `--allow-fs-write=${tmp}`];
  return [
    ...fence,
    '--allow-child-process',
    '--allow-addons',
    o.vitestEntry,
    'run',
    `--root=${join(o.clone, 'services', o.service)}`,
    '--pool=forks',
    '--maxWorkers=1',
    '--no-file-parallelism',
    '--fsModuleCache=false',
    ...fence.map((f) => `--execArgv=${f}`),
    '--reporter=json',
    `--outputFile=${o.outFile}`,
    ...o.files,
  ];
}

/**
 * The environment of a vitest run: `PATH`, plus `HOME` and `TMPDIR` pointing into the temporary folder. vitest writes
 * an API token file under the user data folder of `HOME` and its forks pool writes temporary files under `TMPDIR`;
 * both must be places the fence lets it write. No other name.
 */
export function buildVitestEnv(nodePath: string, clone: string): Record<string, string> {
  const tmp = join(clone, CHECK_TMP);
  return { PATH: dirname(nodePath), HOME: join(tmp, 'home'), TMPDIR: tmp };
}

/** Reads the counts of a TAP report: `# tests N`, `# pass N`, `# fail N`. */
export function parseTap(text: string): { tests: number; pass: number; fail: number } {
  const n = (name: string): number => Number(new RegExp(`^# ${name} (\\d+)`, 'm').exec(text)?.[1] ?? 0);
  return { tests: n('tests'), pass: n('pass'), fail: n('fail') };
}

export interface VitestCounts {
  tests: number;
  pass: number;
  fail: number;
  /** Every suite passed and the report says success. */
  success: boolean;
  /** The message of the first suite that failed (a load error, for example), raw. */
  firstError: string | null;
  /** Every suite message and test failure message, raw, at most 20, each at most 500 characters. */
  messages: string[];
}

/** Reads a vitest JSON report. Anything that is not one counts as a failed run with no test. */
export function parseVitestJson(text: string): VitestCounts {
  const none: VitestCounts = { tests: 0, pass: 0, fail: 0, success: false, firstError: null, messages: [] };
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return none;
  }
  if (typeof v !== 'object' || v === null) return none;
  const r = v as Record<string, unknown>;
  const num = (k: string): number => (typeof r[k] === 'number' && Number.isInteger(r[k]) && (r[k] as number) >= 0 ? (r[k] as number) : 0);
  const suites = Array.isArray(r.testResults) ? (r.testResults as Array<Record<string, unknown>>) : [];
  const failedSuite = suites.find((s) => s?.status !== 'passed');
  // The suite's own message (a load error), or else the first failed test: its name and the start of its message.
  const failedTest = Array.isArray(failedSuite?.assertionResults)
    ? (failedSuite.assertionResults as Array<Record<string, unknown>>).find((a) => a?.status === 'failed')
    : undefined;
  const testMessage = failedTest === undefined ? null : `${String(failedTest.fullName ?? '')}: ${Array.isArray(failedTest.failureMessages) ? String(failedTest.failureMessages[0] ?? '') : ''}`;
  const firstError =
    failedSuite === undefined ? null : typeof failedSuite.message === 'string' && failedSuite.message !== '' ? failedSuite.message : (testMessage ?? 'suite failed');
  const success = r.success === true && num('numFailedTests') === 0 && num('numFailedTestSuites') === 0 && failedSuite === undefined && suites.length > 0;
  const messages: string[] = [];
  for (const s of suites) {
    if (typeof s?.message === 'string' && s.message !== '') messages.push(s.message.slice(0, 500));
    for (const a of Array.isArray(s?.assertionResults) ? (s.assertionResults as Array<Record<string, unknown>>) : []) {
      if (Array.isArray(a?.failureMessages)) for (const m of a.failureMessages) if (typeof m === 'string') messages.push(m.slice(0, 500));
    }
  }
  return { tests: num('numTotalTests'), pass: num('numPassedTests'), fail: num('numFailedTests'), success, firstError, messages: messages.slice(0, 20) };
}

/**
 * Runs the tests of a candidate under `node --permission`, with an empty environment, in its own process group,
 * and stops the whole group after `timeoutMs` (SIGTERM, then SIGKILL). Only the exit code and the counts of the
 * report are kept in the result; the diagnostics line goes to `log` (the API log) only. This is the one place the
 * launcher lives, so that `deploy-demo` can replace it with a run as another OS user.
 */
export async function runChecks(o: CheckRunOptions): Promise<TestsResult> {
  if (o.testFiles.length === 0) return { ok: true, ran: 0, timedOut: false };
  const nodePath = o.nodePath ?? process.execPath;
  // The fence is made of real paths: `/var` on macOS is a link, and a grant on a link covers nothing.
  const clone = await realpath(o.clone);
  await mkdir(join(clone, CHECK_TMP), { recursive: true });
  if ((o.runner ?? 'node') === 'vitest') return runVitest(o, clone, nodePath);
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let timedOut = false;
    let settled = false;
    const child = spawn(nodePath, buildCheckArgv({ ...o, clone }), { cwd: clone, env: buildCheckEnv(nodePath), detached: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true });
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
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (out.length < MAX_CHECK_OUTPUT) out += chunk.slice(0, MAX_CHECK_OUTPUT - out.length);
    });
    child.stderr?.on('data', (chunk: string) => {
      if (err.length < 2048) err += chunk.slice(0, 2048 - err.length);
    });
    const done = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killGroup('SIGKILL');
      const counts = parseTap(out);
      const ok = !timedOut && code === 0 && counts.fail === 0;
      if (!ok) o.log?.({ runner: 'node', code: timedOut ? 'timeout' : 'tests_failed', exitCode: code, timedOut, ...counts, stderr: cleanDiagnostic(err) });
      resolve({ ok, ran: counts.tests, timedOut });
    };
    child.on('error', () => done(null));
    child.on('close', (code) => done(code));
  });
}

/** A vitest run with what the baseline needs to judge it: the failure messages and the start of stderr (raw). */
export interface VitestRunDetail {
  result: TestsResult;
  /** Suite and test failure messages, at most 20, each at most 500 characters. */
  messages: string[];
  stderr: string;
  /** Why the run could not start, or null when it ran. */
  setupCode: string | null;
}

async function runVitest(o: CheckRunOptions, clone: string, nodePath: string): Promise<TestsResult> {
  return (await runVitestDetail(o, clone, nodePath)).result;
}

/** Runs vitest on `o.testFiles` and returns the result with its messages. Used by `runChecks` and the baseline. */
export async function runVitestFiles(o: CheckRunOptions): Promise<VitestRunDetail> {
  const clone = await realpath(o.clone);
  await mkdir(join(clone, CHECK_TMP), { recursive: true });
  return runVitestDetail(o, clone, o.nodePath ?? process.execPath);
}

async function runVitestDetail(o: CheckRunOptions, clone: string, nodePath: string): Promise<VitestRunDetail> {
  const fail = (code: string): VitestRunDetail => {
    o.log?.({ runner: 'vitest', code, exitCode: null, timedOut: false, tests: 0, pass: 0, fail: 0, stderr: '' });
    return { result: { ok: false, ran: 0, timedOut: false }, messages: [], stderr: '', setupCode: code };
  };
  const service = o.service;
  if (service === undefined) return fail('no_service');
  if (o.deps === undefined || o.deps === null) return fail('lab_deps_unavailable');
  if (await hasVitestConfig(clone, service)) return fail('vitest_config_present');
  const prefix = `services/${service}/`;
  const files = o.testFiles.filter((f) => f.startsWith(prefix)).map((f) => f.slice(prefix.length));
  if (files.length !== o.testFiles.length) return fail('file_outside_service');
  const deps = await realpath(o.deps).catch(() => null);
  if (deps === null) return fail('lab_deps_unavailable');
  const vitestEntry = await realpath(join(deps, 'node_modules', 'vitest', 'vitest.mjs')).catch(() => null);
  if (vitestEntry === null || !vitestEntry.startsWith(`${deps}/`)) return fail('vitest_missing');
  const nodeBinary = await realpath(nodePath);
  const tmp = join(clone, CHECK_TMP);
  await mkdir(join(tmp, 'home'), { recursive: true });
  const outFile = join(tmp, 'vitest-report.json');
  await rm(outFile, { force: true });
  let made: string[];
  try {
    made = await linkDeps(deps, clone);
  } catch (err) {
    return fail(err instanceof LabDepsError ? err.code : 'link_failed');
  }
  try {
    const argv = buildVitestArgv({ clone, deps, nodeBinary, vitestEntry, service, files, outFile });
    const run = await runBounded(nodeBinary, argv, { cwd: join(clone, 'services', service), env: buildVitestEnv(nodeBinary, clone), timeoutMs: o.timeoutMs });
    const report = await readFile(outFile, 'utf8').catch(() => '');
    const counts = parseVitestJson(report.length > MAX_CHECK_OUTPUT * 4 ? '' : report);
    const ok = !run.timedOut && run.code === 0 && counts.success && counts.fail === 0 && counts.tests > 0;
    if (!ok) {
      o.log?.({
        runner: 'vitest',
        code: run.timedOut ? 'timeout' : report === '' ? 'no_report' : 'tests_failed',
        exitCode: run.code,
        timedOut: run.timedOut,
        tests: counts.tests,
        pass: counts.pass,
        fail: counts.fail,
        stderr: cleanDiagnostic(run.stderr),
        ...(counts.firstError === null ? {} : { suiteError: cleanDiagnostic(counts.firstError, 300) }),
      });
    }
    return { result: { ok, ran: counts.tests, timedOut: run.timedOut }, messages: counts.messages, stderr: run.stderr, setupCode: null };
  } finally {
    await unlinkDeps(made);
  }
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

/** The outcome of the syntax check of one file: parsed, refused, or no checker for its kind. */
export type SyntaxResult = 'ok' | 'failed' | 'skipped';

/**
 * The fixed script of the TypeScript step, run in a sandboxed child: strip the types with Node's own
 * `module.stripTypeScriptTypes` (strip-only, which is what the lab's `erasableSyntaxOnly` allows) and write the
 * JavaScript next to it in the temporary folder. Exit 3: the file is not valid TypeScript, or uses syntax that is not
 * erasable (an enum, a namespace with code). No file content reaches the argv or the output.
 */
const STRIP_SCRIPT = [
  "import { stripTypeScriptTypes } from 'node:module';",
  "import { readFileSync, writeFileSync } from 'node:fs';",
  'const [src, out] = process.argv.slice(1);',
  "try { writeFileSync(out, stripTypeScriptTypes(readFileSync(src, 'utf8'))); } catch { process.exit(3); }",
].join('\n');

/** File kinds the syntax check knows: JavaScript is checked as is, TypeScript after its types are stripped. */
const JS_FILE = /\.(js|mjs|cjs)$/;
const TS_FILE = /\.(ts|mts|cts)$/;

/**
 * The syntax check of one written file, all in sandboxed children (`--permission`, reads limited to the clone, the
 * environment `PATH` only): a `.js`/`.mjs`/`.cjs` file is `node --check`ed; a `.ts`/`.mts`/`.cts` file is first
 * stripped to JavaScript in `<clone>/.fix-tmp/syntax/` (which `node --check` on the `.ts` itself does not do: on
 * Node 26 it reports success for a broken `.ts` file) and the result is `node --check`ed. Any other kind is
 * `skipped`, never `ok`.
 */
export async function checkFileSyntax(cloneDir: string, file: string, index: number, nodePath: string = process.execPath, timeoutMs = 15_000): Promise<SyntaxResult> {
  if (JS_FILE.test(file)) return (await checkSyntax(cloneDir, file, nodePath, timeoutMs)) ? 'ok' : 'failed';
  if (!TS_FILE.test(file)) return 'skipped';
  if (!/^[A-Za-z0-9._@][A-Za-z0-9._/@-]{0,249}$/.test(file) || file.split('/').includes('..')) return 'failed';
  const clone = await realpath(cloneDir).catch(() => null);
  if (clone === null) return 'failed';
  const dir = join(clone, CHECK_TMP, 'syntax');
  await mkdir(dir, { recursive: true });
  const outRel = `${CHECK_TMP}/syntax/${index}.${file.endsWith('.cts') ? 'cjs' : 'mjs'}`;
  const stripped = await new Promise<boolean>((resolve) => {
    const child = spawn(
      nodePath,
      ['--permission', `--allow-fs-read=${clone}`, `--allow-fs-write=${dir}`, '--disable-warning=ExperimentalWarning', '--input-type=module', '-e', STRIP_SCRIPT, join(clone, file), join(clone, outRel)],
      { cwd: clone, env: buildCheckEnv(nodePath), stdio: 'ignore', shell: false, windowsHide: true, timeout: timeoutMs },
    );
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
  if (!stripped) return 'failed';
  return (await checkSyntax(clone, outRel, nodePath, timeoutMs)) ? 'ok' : 'failed';
}
