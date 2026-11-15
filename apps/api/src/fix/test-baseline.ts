import { SERVICE_NAMES, type ServiceName } from '@haunted-ops/shared';
import { detectRunner, findTestFiles, runVitestFiles, type CheckRunLog } from './check-run.js';
import { cleanDiagnostic } from './lab-deps.js';

/**
 * The sandbox-green set of a service (fix-proposal-flow task 14). The lab's tests were written for a normal process;
 * some of them talk over loopback HTTP, and the test sandbox has no network (`--allow-net` is all or nothing). So the
 * API runs every test file of every vitest service at the lab's `main`, one file at a time, in the same sandbox as a
 * candidate. The files that pass there form the set of the service; a candidate's `tests` check runs only that set.
 * A file that fails at `main` is left out with a short reason, and the pull request says it was not run.
 */

/** `not_at_base`: a test file of the candidate that the baseline at its base commit did not have. */
export const BASELINE_EXCLUSIONS = ['needs_network', 'timeout', 'failed', 'not_at_base'] as const;
export type BaselineExclusion = (typeof BASELINE_EXCLUSIONS)[number];

/** One test file run alone at `main`. */
export interface BaselineFileRun {
  /** Relative to the clone, `services/<S>/...`. */
  file: string;
  ok: boolean;
  /** The whole run hit its timeout and the group was killed. */
  timedOut: boolean;
  /** Suite and test failure messages of the report. */
  messages: readonly string[];
  stderr: string;
}

export interface ServiceBaseline {
  /** Files that pass in the sandbox at `main`, sorted. */
  included: string[];
  /**
   * Files that do not, with why, sorted by file. A `failed` file also has `detail`: the first error line of its run,
   * cleaned (no absolute path, no control character), at most 200 characters, for the `test baseline` log line only.
   */
  excluded: Array<{ file: string; reason: BaselineExclusion; detail?: string }>;
}

/** The most characters of the first error line kept for a `failed` file. */
export const BASELINE_DETAIL_MAX = 200;

/** The first non-empty line of the first message (or of stderr), cleaned and bounded. */
export function firstErrorLine(run: BaselineFileRun): string {
  const text = [...run.messages, run.stderr].find((t) => t.trim() !== '') ?? '';
  const line = text.split('\n').find((l) => l.trim() !== '') ?? '';
  return cleanDiagnostic(line, 1024).slice(0, BASELINE_DETAIL_MAX);
}

export interface TestBaseline {
  /** `<main sha>:<lockfile hash>`: the baseline is made again when either changes. */
  key: string;
  services: Map<ServiceName, ServiceBaseline>;
}

const NET_DENIED = /--allow-net\b/;
const TEST_TIMED_OUT = /\bTest timed out in \d+ ?ms\b/;

/**
 * Why a file that failed at `main` is left out. A message that names `--allow-net` is a denied network call. A test
 * that timed out inside vitest waited for something that never came; in this sandbox that is a socket it was not
 * allowed to open (a denied `listen` or `connect` often only shows as a hang), so it counts as `needs_network` too.
 * A run that hit the API's own timeout is `timeout`; anything else is `failed`.
 */
export function exclusionReason(run: BaselineFileRun): BaselineExclusion {
  const text = [...run.messages, run.stderr].join('\n');
  if (NET_DENIED.test(text)) return 'needs_network';
  if (run.timedOut) return 'timeout';
  if (TEST_TIMED_OUT.test(text)) return 'needs_network';
  return 'failed';
}

/** The set of a service from its runs at `main`: passing files in, the others out with their reason. Pure. */
export function selectSandboxGreen(runs: readonly BaselineFileRun[]): ServiceBaseline {
  const included = runs
    .filter((r) => r.ok)
    .map((r) => r.file)
    .sort();
  const excluded = runs
    .filter((r) => !r.ok)
    .map((r) => {
      const reason = exclusionReason(r);
      const detail = reason === 'failed' ? firstErrorLine(r) : '';
      return detail === '' ? { file: r.file, reason } : { file: r.file, reason, detail };
    })
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return { included, excluded };
}

/** Runs each test file of one vitest service alone, in the sandbox, and selects its set. */
export async function serviceBaseline(clone: string, service: ServiceName, deps: string, timeoutMs: number, log?: (f: CheckRunLog) => void): Promise<ServiceBaseline> {
  const runs: BaselineFileRun[] = [];
  for (const file of await findTestFiles(clone, service)) {
    const d = await runVitestFiles({ clone, testFiles: [file], timeoutMs, runner: 'vitest', service, deps, log });
    runs.push({ file, ok: d.result.ok, timedOut: d.result.timedOut, messages: d.messages, stderr: d.stderr });
  }
  return selectSandboxGreen(runs);
}

/** The sets of every service of a clone at `main` that tests with vitest. Services run under `node --test` are absent. */
export async function buildBaseline(clone: string, deps: string, timeoutMs: number, log?: (f: CheckRunLog) => void): Promise<Map<ServiceName, ServiceBaseline>> {
  const out = new Map<ServiceName, ServiceBaseline>();
  for (const service of SERVICE_NAMES) {
    const exists = await findTestFiles(clone, service).catch(() => null);
    if (exists === null || (await detectRunner(clone, service)) !== 'vitest') continue;
    out.set(service, await serviceBaseline(clone, service, deps, timeoutMs, log));
  }
  return out;
}

/** Text of an exclusion for the pull request body. */
export function exclusionText(reason: BaselineExclusion): string {
  if (reason === 'needs_network') return 'needs network';
  if (reason === 'timeout') return 'timed out at the base commit';
  if (reason === 'not_at_base') return 'not at the base commit';
  return 'failed at the base commit';
}
