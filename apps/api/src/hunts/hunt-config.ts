/**
 * Settings of the Hunt runner. Values come only from the environment. Error messages name
 * variables and never include their values (the tokens are in here).
 */
import { accessSync, constants, lstatSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { isLinkLocalHost, isOrigin } from '../config/config.js';

export interface HuntConfig {
  /** Off by default: a Hunt spends Credits. */
  readonly enabled: boolean;
  readonly labUrl: string;
  readonly labAllowRemote: boolean;
  /** Required when enabled. */
  readonly labReadToken: string | null;
  /** Required when enabled. */
  readonly adminToken: string | null;
  /** An absolute path when enabled; the configured value otherwise. */
  readonly kiroCliPath: string;
  readonly model: string;
  readonly creditCap: number;
  readonly dailyCreditCap: number;
  readonly timeoutMs: number;
  readonly cooldownMs: number;
  /** How long an automatic Hunt waits after an Incident opens, so a cascade can open all its Incidents first. */
  readonly settleMs: number;
  /** The most Hunts that may start in one UTC day, both triggers together. */
  readonly dailyMax: number;
  readonly maxToolCalls: number;
  readonly workdir: string;
}

export const HUNT_VARS = [
  'LAB_URL',
  'LAB_READ_TOKEN',
  'LAB_ALLOW_REMOTE',
  'HUNTS_ENABLED',
  'HUNT_ADMIN_TOKEN',
  'KIRO_CLI_PATH',
  'EXORCIST_MODEL',
  'HUNT_CREDIT_CAP',
  'HUNT_DAILY_CREDIT_CAP',
  'HUNT_TIMEOUT_MS',
  'HUNT_COOLDOWN_MS',
  'HUNT_SETTLE_MS',
  'HUNT_DAILY_MAX',
  'HUNT_MAX_TOOL_CALLS',
  'HUNT_WORKDIR',
] as const;
export type HuntVar = (typeof HUNT_VARS)[number];

export const HUNT_DEFAULTS = {
  labUrl: 'http://127.0.0.1:4100',
  labAllowRemote: false,
  enabled: false,
  kiroCliPath: 'kiro-cli',
  model: 'claude-sonnet-5.5',
  creditCap: 1.5,
  dailyCreditCap: 30,
  timeoutMs: 90_000,
  cooldownMs: 120_000,
  settleMs: 10_000,
  dailyMax: 40,
  maxToolCalls: 20,
} as const;

/** Tokens: this many characters or more, and not the placeholder of `.env.example`. */
export const MIN_TOKEN_LENGTH = 24;
export const PLACEHOLDER_PREFIX = 'change-me';

export class HuntConfigError extends Error {
  constructor(readonly variables: readonly HuntVar[]) {
    super(`Invalid configuration: ${variables.join(', ')}`);
    this.name = 'HuntConfigError';
  }
}

export interface HuntConfigDeps {
  /** Finds an executable. Injected so the rules can be tested without a `kiro-cli`. */
  resolveExecutable?: (nameOrPath: string, pathEnv: string | undefined) => string | null;
  tmpDir?: () => string;
  /** Owner and permission bits of an existing folder, or null when it does not exist. Injected for tests. */
  statDir?: (path: string) => { uid: number; mode: number } | null;
  currentUid?: () => number;
}

/** An absolute path to an executable file, or null. A bare name is searched on `PATH`. */
export function resolveExecutable(nameOrPath: string, pathEnv: string | undefined): string | null {
  const isExecutable = (p: string): boolean => {
    try {
      if (!statSync(p).isFile()) return false;
      accessSync(p, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  if (nameOrPath.includes('/')) return isAbsolute(nameOrPath) && isExecutable(nameOrPath) ? nameOrPath : null;
  for (const dir of (pathEnv ?? '').split(delimiter)) {
    if (dir === '' || !isAbsolute(dir)) continue;
    const candidate = join(dir, nameOrPath);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

export const isTokenValid = (value: string): boolean =>
  value.length >= MIN_TOKEN_LENGTH && !/\s/.test(value) && !value.toLowerCase().startsWith(PLACEHOLDER_PREFIX);

const MODEL_PATTERN = /^[a-z0-9][a-z0-9.-]{1,63}$/;
const DECIMAL = /^\d{1,6}(\.\d{1,3})?$/;

export function parseDecimal(value: string, min: number, max: number): number | null {
  if (!DECIMAL.test(value)) return null;
  const n = Number(value);
  return n >= min && n <= max ? n : null;
}

export function parseInteger(value: string, min: number, max: number): number | null {
  if (!/^\d{1,9}$/.test(value)) return null;
  const n = Number(value);
  return n >= min && n <= max ? n : null;
}

export function statDir(path: string): { uid: number; mode: number } | null {
  try {
    const s = lstatSync(path);
    return { uid: s.uid, mode: s.mode };
  } catch {
    return null;
  }
}

export const currentUid = (): number => (typeof process.getuid === 'function' ? process.getuid() : -1);

/** Hosts a default LAB_URL may name. `new URL` writes an IPv6 host in brackets. */
const LOOPBACK_HOSTS: readonly string[] = ['127.0.0.1', '[::1]', 'localhost'];

export function isLabOrigin(value: string, allowRemote: boolean): boolean {
  if (!isOrigin(value)) return false;
  const { hostname } = new URL(value);
  if (isLinkLocalHost(hostname)) return false;
  return allowRemote || LOOPBACK_HOSTS.includes(hostname);
}

/** An absolute path with no `..` segment, no NUL and a sane length. */
export function isSafeWorkdir(value: string): boolean {
  return isAbsolute(value) && value.length <= 200 && !value.includes('\0') && !value.split('/').includes('..');
}

/**
 * Reads and checks the Hunt settings. Throws `HuntConfigError` naming the variables, in the order
 * of `HUNT_VARS`. Optional settings may be missing; with `HUNTS_ENABLED=true` the tokens and an
 * executable `KIRO_CLI_PATH` are required.
 */
export function parseHuntConfig(env: Readonly<Record<string, string | undefined>>, deps: HuntConfigDeps = {}): HuntConfig {
  const bad = new Set<HuntVar>();
  const read = (name: HuntVar): string | undefined => {
    const v = env[name];
    return v === undefined || v.trim() === '' ? undefined : v;
  };
  const flag = (name: HuntVar): boolean => {
    const raw = read(name);
    if (raw === undefined) return false;
    if (raw === 'true') return true;
    if (raw !== 'false') bad.add(name);
    return false;
  };

  const enabled = flag('HUNTS_ENABLED');
  const labAllowRemote = flag('LAB_ALLOW_REMOTE');

  const labUrlRaw = read('LAB_URL');
  if (labUrlRaw !== undefined && !isLabOrigin(labUrlRaw, labAllowRemote)) bad.add('LAB_URL');
  const labUrl = labUrlRaw !== undefined && !bad.has('LAB_URL') ? labUrlRaw : HUNT_DEFAULTS.labUrl;

  const token = (name: 'LAB_READ_TOKEN' | 'HUNT_ADMIN_TOKEN'): string | null => {
    const raw = read(name);
    if (raw === undefined) {
      if (enabled) bad.add(name);
      return null;
    }
    if (!isTokenValid(raw)) {
      bad.add(name);
      return null;
    }
    return raw;
  };
  const labReadToken = token('LAB_READ_TOKEN');
  const adminToken = token('HUNT_ADMIN_TOKEN');
  if (labReadToken !== null && labReadToken === adminToken) bad.add('HUNT_ADMIN_TOKEN');

  const kiroRaw = read('KIRO_CLI_PATH') ?? HUNT_DEFAULTS.kiroCliPath;
  let kiroCliPath = kiroRaw;
  if (enabled) {
    const resolved = (deps.resolveExecutable ?? resolveExecutable)(kiroRaw, env.PATH);
    if (resolved === null) bad.add('KIRO_CLI_PATH');
    else kiroCliPath = resolved;
  } else if (kiroRaw.includes('\0') || kiroRaw.length > 500) {
    bad.add('KIRO_CLI_PATH');
  }

  const modelRaw = read('EXORCIST_MODEL') ?? HUNT_DEFAULTS.model;
  if (!MODEL_PATTERN.test(modelRaw) || modelRaw === 'auto') bad.add('EXORCIST_MODEL');

  const creditCapRaw = read('HUNT_CREDIT_CAP');
  const creditCap = creditCapRaw === undefined ? HUNT_DEFAULTS.creditCap : parseDecimal(creditCapRaw, 0.1, 10);
  if (creditCap === null) bad.add('HUNT_CREDIT_CAP');
  const dailyRaw = read('HUNT_DAILY_CREDIT_CAP');
  const dailyCreditCap = dailyRaw === undefined ? HUNT_DEFAULTS.dailyCreditCap : parseDecimal(dailyRaw, 0.1, 500);
  if (dailyCreditCap === null) bad.add('HUNT_DAILY_CREDIT_CAP');
  if (creditCap !== null && dailyCreditCap !== null && creditCap > dailyCreditCap) bad.add('HUNT_CREDIT_CAP');

  const int = (name: HuntVar, fallback: number, min: number, max: number): number => {
    const raw = read(name);
    if (raw === undefined) return fallback;
    const n = parseInteger(raw, min, max);
    if (n === null) {
      bad.add(name);
      return fallback;
    }
    return n;
  };
  const timeoutMs = int('HUNT_TIMEOUT_MS', HUNT_DEFAULTS.timeoutMs, 10_000, 300_000);
  const cooldownMs = int('HUNT_COOLDOWN_MS', HUNT_DEFAULTS.cooldownMs, 0, 3_600_000);
  const settleMs = int('HUNT_SETTLE_MS', HUNT_DEFAULTS.settleMs, 0, 60_000);
  const dailyMax = int('HUNT_DAILY_MAX', HUNT_DEFAULTS.dailyMax, 1, 500);
  const maxToolCalls = int('HUNT_MAX_TOOL_CALLS', HUNT_DEFAULTS.maxToolCalls, 3, 30);

  const workdirRaw = read('HUNT_WORKDIR');
  if (workdirRaw !== undefined && !isSafeWorkdir(workdirRaw)) bad.add('HUNT_WORKDIR');
  const workdir = workdirRaw !== undefined && isSafeWorkdir(workdirRaw) ? workdirRaw : join((deps.tmpDir ?? tmpdir)(), 'haunted-ops-hunts');
  // In production, with Hunts on, the folder is named on purpose, and an existing one belongs to this user and is private.
  if (enabled && env.NODE_ENV === 'production') {
    if (workdirRaw === undefined) bad.add('HUNT_WORKDIR');
    else if (isSafeWorkdir(workdirRaw)) {
      const st = (deps.statDir ?? statDir)(workdirRaw);
      const uid = (deps.currentUid ?? currentUid)();
      if (st !== null && (st.uid !== uid || (st.mode & 0o777) !== 0o700)) bad.add('HUNT_WORKDIR');
    }
  }

  if (bad.size > 0) throw new HuntConfigError(HUNT_VARS.filter((v) => bad.has(v)));

  return Object.freeze({
    enabled,
    labUrl,
    labAllowRemote,
    labReadToken,
    adminToken,
    kiroCliPath,
    model: modelRaw,
    creditCap: creditCap as number,
    dailyCreditCap: dailyCreditCap as number,
    timeoutMs,
    cooldownMs,
    settleMs,
    dailyMax,
    maxToolCalls,
    workdir,
  });
}

/** Validates before the app is created; on failure prints the variable names (never values) and exits 1. */
export function loadHuntConfigOrExit(env: Readonly<Record<string, string | undefined>> = process.env): HuntConfig {
  try {
    return parseHuntConfig(env);
  } catch (err) {
    if (err instanceof HuntConfigError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
}
