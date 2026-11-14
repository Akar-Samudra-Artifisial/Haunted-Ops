/**
 * Settings of the fix flow. Values come only from the environment. Error messages name variables and
 * never include their values (the GitHub token and the chaos token are in here).
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isOrigin } from '../config/config.js';
import {
  currentUid,
  isLabOrigin,
  isSafeWorkdir,
  isTokenValid,
  parseDecimal,
  parseInteger,
  resolveExecutable,
  statDir,
  type HuntConfig,
} from '../hunts/hunt-config.js';

export interface FixConfig {
  /** Off by default: a fix spends Credits and writes to GitHub. */
  readonly enabled: boolean;
  /** A fine-grained token. Required when enabled. Never logged. */
  readonly githubToken: string | null;
  /** `owner/name` of the Lab repo. Required when enabled. */
  readonly repo: string | null;
  readonly chaosUrl: string;
  readonly chaosToken: string | null;
  /** `WEB_ORIGIN`, for the link in the pull request. Required when enabled. */
  readonly webOrigin: string | null;
  /** An absolute path to `git` when enabled; the name otherwise. */
  readonly gitPath: string;
  readonly model: string;
  readonly creditCap: number;
  readonly timeoutMs: number;
  readonly maxToolCalls: number;
  readonly testTimeoutMs: number;
  readonly requireTests: boolean;
  readonly pollMs: number;
  readonly branchTtlDays: number;
  /**
   * How long after the merge a Deploy Record of the merge commit may take to show up. Until then a missing record keeps
   * the Proposal `merged` and the next ticks look again; after it, the Proposal ends `failed` / `deploy_unconfirmed`.
   */
  readonly deployConfirmMs: number;
  /** The root folder of the fix flow: the API's own clone, the export and work folders, the pid notes. */
  readonly workdir: string;
}

export const FIX_VARS = [
  'FIX_ENABLED',
  'GITHUB_TOKEN',
  'LAB_GITHUB_REPO',
  'CHAOS_URL',
  'CHAOS_TOKEN',
  'WEB_ORIGIN',
  'FIX_MODEL',
  'FIX_CREDIT_CAP',
  'FIX_TIMEOUT_MS',
  'FIX_MAX_TOOL_CALLS',
  'FIX_TEST_TIMEOUT_MS',
  'FIX_REQUIRE_TESTS',
  'FIX_POLL_MS',
  'FIX_BRANCH_TTL_DAYS',
  'FIX_DEPLOY_CONFIRM_MS',
  'FIX_WORKDIR',
] as const;
export type FixVar = (typeof FIX_VARS)[number];

export const FIX_DEFAULTS = {
  enabled: false,
  chaosUrl: 'http://127.0.0.1:4100',
  model: 'claude-sonnet-5.5',
  creditCap: 1.5,
  timeoutMs: 120_000,
  maxToolCalls: 30,
  testTimeoutMs: 90_000,
  requireTests: true,
  pollMs: 30_000,
  branchTtlDays: 7,
  deployConfirmMs: 300_000,
  gitPath: 'git',
} as const;

/**
 * The test run of a candidate relies on the network gate of `node --permission` (no `--allow-net`: no socket, no
 * fetch), which Node has from version 25. `.nvmrc` pins Node 26; an older Node refuses `FIX_ENABLED=true`.
 */
export const MIN_NODE_MAJOR_FOR_FIX = 25;

export function nodeMajor(version: string): number {
  const m = /^v?(\d+)\./.exec(version);
  return m === null ? 0 : Number(m[1]);
}

/** A fine-grained token: `github_pat_` and the allowed characters. A classic `ghp_`, OAuth `gho_` and placeholders do not match. */
export const GITHUB_TOKEN_PATTERN = /^github_pat_[A-Za-z0-9_]{22,255}$/;
/** `owner/name`. */
export const REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;
const MODEL_PATTERN = /^[a-z0-9][a-z0-9.-]{1,63}$/;

export const isGithubToken = (value: string): boolean => GITHUB_TOKEN_PATTERN.test(value);

/** `owner/name` where neither part is a dot segment. */
export const isRepo = (value: string): boolean => REPO_PATTERN.test(value) && value.split('/').every((p) => p !== '.' && p !== '..' && !p.endsWith('.git'));

export class FixConfigError extends Error {
  constructor(readonly variables: readonly FixVar[]) {
    super(`Invalid configuration: ${variables.join(', ')}`);
    this.name = 'FixConfigError';
  }
}

export interface FixConfigDeps {
  resolveExecutable?: (nameOrPath: string, pathEnv: string | undefined) => string | null;
  tmpDir?: () => string;
  statDir?: (path: string) => { uid: number; mode: number } | null;
  currentUid?: () => number;
  /** The running Node version (`process.versions.node`); tests pass an old one. */
  nodeVersion?: string;
}

type Hunts = Pick<HuntConfig, 'enabled' | 'adminToken' | 'labReadToken' | 'workdir' | 'kiroCliPath' | 'labAllowRemote'>;

/**
 * Reads and checks the fix settings. Throws `FixConfigError` naming the variables, in the order of
 * `FIX_VARS`. With `FIX_ENABLED=true` the Hunt settings must be on, and the token, the repository,
 * the chaos token, `WEB_ORIGIN`, `git` and an executable `kiro-cli` are required.
 */
export function parseFixConfig(env: Readonly<Record<string, string | undefined>>, hunts: Hunts, deps: FixConfigDeps = {}): FixConfig {
  const bad = new Set<FixVar>();
  const read = (name: FixVar): string | undefined => {
    const v = env[name];
    return v === undefined || v.trim() === '' ? undefined : v;
  };
  const flag = (name: FixVar, fallback: boolean): boolean => {
    const raw = read(name);
    if (raw === undefined) return fallback;
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    bad.add(name);
    return fallback;
  };
  const int = (name: FixVar, fallback: number, min: number, max: number): number => {
    const raw = read(name);
    if (raw === undefined) return fallback;
    const n = parseInteger(raw, min, max);
    if (n === null) {
      bad.add(name);
      return fallback;
    }
    return n;
  };

  const enabled = flag('FIX_ENABLED', FIX_DEFAULTS.enabled);
  if (enabled && !hunts.enabled) bad.add('FIX_ENABLED');

  // The token is checked for its form even when the flow is off: a classic or placeholder token never gets in.
  const tokenRaw = read('GITHUB_TOKEN');
  let githubToken: string | null = null;
  if (tokenRaw !== undefined) {
    if (isGithubToken(tokenRaw)) githubToken = tokenRaw;
    else bad.add('GITHUB_TOKEN');
  } else if (enabled) bad.add('GITHUB_TOKEN');

  const repoRaw = read('LAB_GITHUB_REPO');
  let repo: string | null = null;
  if (repoRaw !== undefined) {
    if (isRepo(repoRaw)) repo = repoRaw;
    else bad.add('LAB_GITHUB_REPO');
  } else if (enabled) bad.add('LAB_GITHUB_REPO');

  const chaosRaw = read('CHAOS_URL');
  if (chaosRaw !== undefined && !isLabOrigin(chaosRaw, hunts.labAllowRemote)) bad.add('CHAOS_URL');
  const chaosUrl = chaosRaw !== undefined && !bad.has('CHAOS_URL') ? chaosRaw : FIX_DEFAULTS.chaosUrl;

  const chaosTokenRaw = read('CHAOS_TOKEN');
  let chaosToken: string | null = null;
  if (chaosTokenRaw !== undefined) {
    if (!isTokenValid(chaosTokenRaw) || chaosTokenRaw === hunts.adminToken || chaosTokenRaw === hunts.labReadToken) bad.add('CHAOS_TOKEN');
    else chaosToken = chaosTokenRaw;
  } else if (enabled) bad.add('CHAOS_TOKEN');

  const originRaw = read('WEB_ORIGIN');
  let webOrigin: string | null = null;
  if (originRaw !== undefined && isOrigin(originRaw)) webOrigin = originRaw;
  else if (enabled) bad.add('WEB_ORIGIN');

  const modelRaw = read('FIX_MODEL') ?? FIX_DEFAULTS.model;
  if (!MODEL_PATTERN.test(modelRaw) || modelRaw === 'auto') bad.add('FIX_MODEL');

  const capRaw = read('FIX_CREDIT_CAP');
  const creditCap = capRaw === undefined ? FIX_DEFAULTS.creditCap : parseDecimal(capRaw, 0.1, 10);
  if (creditCap === null) bad.add('FIX_CREDIT_CAP');

  const timeoutMs = int('FIX_TIMEOUT_MS', FIX_DEFAULTS.timeoutMs, 10_000, 300_000);
  const maxToolCalls = int('FIX_MAX_TOOL_CALLS', FIX_DEFAULTS.maxToolCalls, 3, 60);
  const testTimeoutMs = int('FIX_TEST_TIMEOUT_MS', FIX_DEFAULTS.testTimeoutMs, 10_000, 300_000);
  const requireTests = flag('FIX_REQUIRE_TESTS', FIX_DEFAULTS.requireTests);
  const pollMs = int('FIX_POLL_MS', FIX_DEFAULTS.pollMs, 5_000, 300_000);
  const branchTtlDays = int('FIX_BRANCH_TTL_DAYS', FIX_DEFAULTS.branchTtlDays, 1, 60);
  const deployConfirmMs = int('FIX_DEPLOY_CONFIRM_MS', FIX_DEFAULTS.deployConfirmMs, 10_000, 3_600_000);
  // The test run is fenced from the network only on a Node that gates it under `--permission`.
  if (enabled && nodeMajor(deps.nodeVersion ?? process.versions.node) < MIN_NODE_MAJOR_FOR_FIX) bad.add('FIX_ENABLED');

  // The default folder is next to the Hunt folder: `HuntWorkdir.prepare` removes everything it did not make.
  const workdirRaw = read('FIX_WORKDIR');
  if (workdirRaw !== undefined && !isSafeWorkdir(workdirRaw)) bad.add('FIX_WORKDIR');
  const workdir = workdirRaw !== undefined && isSafeWorkdir(workdirRaw) ? workdirRaw : join((deps.tmpDir ?? tmpdir)(), 'haunted-ops-fix');
  if (enabled && env.NODE_ENV === 'production') {
    if (workdirRaw === undefined) bad.add('FIX_WORKDIR');
    else if (isSafeWorkdir(workdirRaw)) {
      const st = (deps.statDir ?? statDir)(workdirRaw);
      const uid = (deps.currentUid ?? currentUid)();
      if (st !== null && (st.uid !== uid || (st.mode & 0o777) !== 0o700)) bad.add('FIX_WORKDIR');
    }
  }

  let gitPath: string = FIX_DEFAULTS.gitPath;
  if (enabled) {
    const resolved = (deps.resolveExecutable ?? resolveExecutable)('git', env.PATH);
    if (resolved === null) bad.add('FIX_ENABLED');
    else gitPath = resolved;
  }

  if (bad.size > 0) throw new FixConfigError(FIX_VARS.filter((v) => bad.has(v)));
  return Object.freeze({
    enabled,
    githubToken,
    repo,
    chaosUrl,
    chaosToken,
    webOrigin,
    gitPath,
    model: modelRaw,
    creditCap: creditCap as number,
    timeoutMs,
    maxToolCalls,
    testTimeoutMs,
    requireTests,
    pollMs,
    branchTtlDays,
    deployConfirmMs,
    workdir,
  });
}

/** Validates before the app is created; on failure prints the variable names (never values) and exits 1. */
export function loadFixConfigOrExit(hunts: Hunts, env: Readonly<Record<string, string | undefined>> = process.env): FixConfig {
  try {
    return parseFixConfig(env, hunts);
  } catch (err) {
    if (err instanceof FixConfigError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
}
