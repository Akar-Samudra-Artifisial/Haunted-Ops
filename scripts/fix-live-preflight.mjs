#!/usr/bin/env node
// The pre-flight of the opt-in live fix test (task 22.7 of fix-proposal-flow). It checks everything the live test
// needs WITHOUT calling the model and without spending Credits, and prints one `OK` or `FAIL` line per check:
//
//   pnpm --filter @haunted-ops/api preflight:live
//
//  1. `kiro-cli --version` is 3.3.0;
//  2. `kiro-cli whoami` succeeds (the CLI is logged in);
//  3. the login folder `~/Library/Application Support/kiro-cli` is a real folder with owner rwx;
//  4. the environment names the live test needs are set (names only, never values);
//  5. the lab answers on LAB_URL, and Prometheus on PROMETHEUS_URL;
//  6. TEST_DATABASE_URL is reachable;
//  7. the GitHub token can read the lab repository (`GET /repos/<repo>`; only the HTTP status is printed).
//
// Exit code 0 only when every check passes. No value of the environment, no token and no path is printed.
import { execFile } from 'node:child_process';
import { existsSync, lstatSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './is-main.mjs';

export const EXPECTED_KIRO_CLI = '3.3.0';
/** The environment names of the live test (`apps/api/test-live/fix.live.ts`). `HUNTS_ENABLED` and `FIX_ENABLED` are set by the test. */
export const REQUIRED_ENV = Object.freeze([
  'GITHUB_TOKEN',
  'LAB_GITHUB_REPO',
  'CHAOS_URL',
  'CHAOS_TOKEN',
  'WEB_ORIGIN',
  'LAB_URL',
  'LAB_READ_TOKEN',
  'HUNT_ADMIN_TOKEN',
  'KIRO_CLI_PATH',
  'PROMETHEUS_URL',
  'TEST_DATABASE_URL',
]);
const GITHUB_API = 'https://api.github.com';
const TIMEOUT_MS = 10_000;
const REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;

/** `execFile` with a small environment: the CLI gets its `HOME` and nothing else of ours (no token). */
export function defaultExec(file, args, env) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: TIMEOUT_MS, env: { PATH: env.PATH ?? '/usr/bin:/bin', HOME: env.HOME ?? '', LANG: env.LANG ?? 'en_US.UTF-8' }, maxBuffer: 64 * 1024 }, (err, stdout) => {
      resolve({ ok: err === null, stdout: String(stdout ?? '') });
    });
  });
}

/** `SELECT 1` against the URL, with the `pg` package of `apps/api`. Never prints the URL. */
export async function defaultPgCheck(url) {
  const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
  const { Client } = require('pg');
  const client = new Client({ connectionString: url, connectionTimeoutMillis: TIMEOUT_MS });
  try {
    await client.connect();
    await client.query('select 1');
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

const ok = (name, detail) => ({ name, ok: true, detail });
const fail = (name, detail) => ({ name, ok: false, detail });
const set = (v) => typeof v === 'string' && v.trim() !== '';

/** The HTTP status of a GET, or null when nothing answered. Redirects are errors. */
async function status(fetchFn, url, headers = {}) {
  try {
    const res = await fetchFn(url, { method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
    await res.body?.cancel().catch(() => undefined);
    return res.status;
  } catch {
    return null;
  }
}

/**
 * Runs the checks. `deps` are the seams of the tests: `exec`, `fetchFn`, `lstat`, `pgCheck`, the GitHub base URL.
 * Returns `[{ name, ok, detail }]`; a detail never holds a value of the environment.
 */
export async function runPreflight(env, deps = {}) {
  const exec = deps.exec ?? defaultExec;
  const fetchFn = deps.fetchFn ?? fetch;
  const lstat = deps.lstat ?? lstatSync;
  const pgCheck = deps.pgCheck ?? defaultPgCheck;
  const githubApi = deps.githubApi ?? GITHUB_API;
  const results = [];
  const kiro = set(env.KIRO_CLI_PATH) ? env.KIRO_CLI_PATH : 'kiro-cli';

  const version = await exec(kiro, ['--version'], env);
  const found = /\b(\d+\.\d+\.\d+)\b/.exec(version.stdout)?.[1] ?? null;
  results.push(version.ok && found === EXPECTED_KIRO_CLI ? ok('kiro-cli version', found) : fail('kiro-cli version', `expected ${EXPECTED_KIRO_CLI}, found ${version.ok ? (found ?? 'none') : 'no answer'}`));

  const who = await exec(kiro, ['whoami'], env);
  results.push(who.ok ? ok('kiro-cli whoami', 'logged in') : fail('kiro-cli whoami', 'not logged in or no answer'));

  const folder = set(env.HOME) ? join(env.HOME, 'Library', 'Application Support', 'kiro-cli') : null;
  if (folder === null) results.push(fail('kiro-cli login folder', 'HOME is not set'));
  else {
    try {
      const st = lstat(folder);
      const mode = st.mode & 0o777;
      if (st.isSymbolicLink() || !st.isDirectory()) results.push(fail('kiro-cli login folder', 'not a real folder'));
      else if ((mode & 0o700) !== 0o700) results.push(fail('kiro-cli login folder', `mode ${mode.toString(8)} lacks owner rwx`));
      else results.push(ok('kiro-cli login folder', `folder, mode ${mode.toString(8)}`));
    } catch {
      results.push(fail('kiro-cli login folder', 'missing'));
    }
  }

  const missing = REQUIRED_ENV.filter((name) => !set(env[name]));
  results.push(missing.length === 0 ? ok('environment names', `${REQUIRED_ENV.length} set`) : fail('environment names', `not set: ${missing.join(', ')}`));

  if (set(env.LAB_URL)) {
    const since = encodeURIComponent(new Date(Date.now() - 3600_000).toISOString());
    const code = await status(fetchFn, `${env.LAB_URL.replace(/\/+$/, '')}/lab/deploys?since=${since}`, { authorization: `Bearer ${env.LAB_READ_TOKEN ?? ''}` });
    results.push(code === 200 ? ok('lab', 'HTTP 200') : fail('lab', code === null ? 'no answer' : `HTTP ${code}`));
  } else results.push(fail('lab', 'LAB_URL is not set'));

  if (set(env.PROMETHEUS_URL)) {
    const code = await status(fetchFn, `${env.PROMETHEUS_URL.replace(/\/+$/, '')}/-/ready`);
    results.push(code === 200 ? ok('prometheus', 'HTTP 200') : fail('prometheus', code === null ? 'no answer' : `HTTP ${code}`));
  } else results.push(fail('prometheus', 'PROMETHEUS_URL is not set'));

  results.push(set(env.TEST_DATABASE_URL) && (await pgCheck(env.TEST_DATABASE_URL)) ? ok('test database', 'reachable') : fail('test database', set(env.TEST_DATABASE_URL) ? 'not reachable' : 'TEST_DATABASE_URL is not set'));

  if (set(env.GITHUB_TOKEN) && set(env.LAB_GITHUB_REPO) && REPO_PATTERN.test(env.LAB_GITHUB_REPO)) {
    // The token goes to the GitHub API and nowhere else.
    const code = await status(fetchFn, `${githubApi}/repos/${env.LAB_GITHUB_REPO}`, {
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'haunted-ops-preflight',
    });
    results.push(code === 200 ? ok('github repository', 'HTTP 200') : fail('github repository', code === null ? 'no answer' : `HTTP ${code}`));
  } else results.push(fail('github repository', 'GITHUB_TOKEN or LAB_GITHUB_REPO is not set or not valid'));

  return results;
}

/** One line per check. */
export const formatResults = (results) => results.map((r) => `${r.ok ? 'OK  ' : 'FAIL'} ${r.name}: ${r.detail}`);

async function main() {
  // The same local file the live test reads (`apps/api/.env`); variables that are already set win.
  const envFile = fileURLToPath(new URL('../apps/api/.env', import.meta.url));
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const results = await runPreflight(process.env);
  process.stdout.write(`${formatResults(results).join('\n')}\n`);
  return results.every((r) => r.ok) ? 0 : 1;
}

if (isMain(import.meta.url)) process.exitCode = await main();
