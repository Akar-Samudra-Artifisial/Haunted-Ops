#!/usr/bin/env node
// Gate G1 (score): with the lab running and the API polling, apply each lab scenario through the lab
// chaos API, assert that /api/services shows the matching service haunted with the right reason and an
// open incident, reset, assert that the service is calm again, print a table, exit 0 (pass) or 1 (fail).
//
// Environment (names only; values come from the environment, never from a file read here):
//   API_URL      default http://127.0.0.1:3000
//   CHAOS_URL    default http://127.0.0.1:4100
//   CHAOS_TOKEN  required, bearer token of the lab chaos API. It is sent only to CHAOS_URL and never printed.
import { pathToFileURL } from 'node:url';

export const SCENARIOS = Object.freeze([
  { name: 'error-spike', service: 'payments', reason: 'error_rate', minLevel: 2 },
  { name: 'fog', service: 'orders', reason: 'p95', minLevel: 2 },
  { name: 'dark-room', service: 'ledger', reason: 'down', minLevel: 4 },
]);

export const BASELINE_S = 120;
export const DETECT_S = 60;
export const RECOVER_S = 120;
export const POLL_MS = 1000;

export class EnvError extends Error {
  constructor(name) {
    super(`Missing environment variable: ${name}`);
    this.name = 'EnvError';
    this.variable = name;
  }
}

/** Reads the settings. Throws EnvError naming the variable (never a value) when CHAOS_TOKEN is missing. */
export function readEnv(env) {
  const token = env.CHAOS_TOKEN;
  if (token === undefined || token.trim() === '') throw new EnvError('CHAOS_TOKEN');
  const trim = (v) => v.replace(/\/+$/, '');
  return {
    apiUrl: trim(env.API_URL?.trim() || 'http://127.0.0.1:3000'),
    chaosUrl: trim(env.CHAOS_URL?.trim() || 'http://127.0.0.1:4100'),
    token,
  };
}

/** All four services calm and no open incident. */
export function isBaseline(services) {
  return (
    Array.isArray(services) &&
    services.length === 4 &&
    services.every((s) => s.hauntLevel === 0 && (s.openIncident ?? null) === null)
  );
}

export function findService(services, name) {
  return Array.isArray(services) ? services.find((s) => s.name === name) : undefined;
}

/** The scenario's service is haunted enough, for the right reason, with an open incident. */
export function detected(services, scenario) {
  const s = findService(services, scenario.service);
  return (
    s !== undefined &&
    s.hauntLevel >= scenario.minLevel &&
    s.reason?.kind === scenario.reason &&
    (s.openIncident ?? null) !== null
  );
}

export function recovered(services, scenario) {
  return findService(services, scenario.service)?.hauntLevel === 0;
}

/**
 * Polls `check` every pollMs until it returns true, `timeoutS` passed, or `signal` aborted.
 * Returns { ok, secs, last } where `last` is the last value `read` returned.
 */
export async function waitFor(read, pass, { timeoutS, pollMs = POLL_MS, now, sleep, signal }) {
  const start = now();
  let last;
  for (;;) {
    try {
      last = await read();
      if (pass(last)) return { ok: true, secs: (now() - start) / 1000, last };
    } catch {
      // The API may be briefly unreachable; keep trying until the deadline.
    }
    if (signal?.aborted || now() - start >= timeoutS * 1000) return { ok: false, secs: (now() - start) / 1000, last };
    await sleep(pollMs);
  }
}

/** Runs the whole check. `io` has fetch, now, sleep, log. Always sends a final reset. Returns { rows, pass }. */
export async function runCheck({ apiUrl, chaosUrl, token }, io, signal) {
  const { fetch: doFetch, now, sleep } = io;
  const readServices = async () => {
    const res = await doFetch(`${apiUrl}/api/services`, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`GET /api/services answered ${res.status}`);
    return res.json();
  };
  const chaos = async (path) => {
    const res = await doFetch(`${chaosUrl}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`POST ${path} answered ${res.status}`);
  };
  const wait = (pass, timeoutS) => waitFor(readServices, pass, { timeoutS, now, sleep, signal });

  const rows = [];
  try {
    io.log('waiting for a calm baseline');
    const base = await wait(isBaseline, BASELINE_S);
    if (!base.ok) {
      rows.push({ scenario: 'baseline', service: '-', level: '-', reason: '-', detectS: '-', recoverS: '-', result: 'FAIL (not calm)' });
      return { rows, pass: false };
    }
    for (const scenario of SCENARIOS) {
      const row = { scenario: scenario.name, service: scenario.service, level: '-', reason: '-', detectS: '-', recoverS: '-', result: 'FAIL' };
      rows.push(row);
      try {
        io.log(`applying ${scenario.name}`);
        await chaos(`/chaos/scenarios/${scenario.name}/apply`);
      } catch (err) {
        row.result = `FAIL (${err.message})`;
        break;
      }
      const hit = await wait((s) => detected(s, scenario), DETECT_S);
      const seen = findService(hit.last, scenario.service);
      row.level = seen?.hauntLevel ?? '-';
      row.reason = seen?.reason?.kind ?? 'none';
      if (hit.ok) row.detectS = hit.secs.toFixed(1);
      else row.detectS = `>${DETECT_S}`;

      let resetOk = true;
      try {
        io.log(`resetting after ${scenario.name}`);
        await chaos('/chaos/reset');
      } catch (err) {
        resetOk = false;
        row.result = `FAIL (${err.message})`;
      }
      const back = resetOk ? await wait((s) => recovered(s, scenario), RECOVER_S) : { ok: false, secs: 0 };
      row.recoverS = back.ok ? back.secs.toFixed(1) : `>${RECOVER_S}`;
      if (hit.ok && back.ok) row.result = 'PASS';
      else if (resetOk) row.result = hit.ok ? 'FAIL (no recovery)' : 'FAIL (not detected)';
      if (!back.ok) break; // later scenarios need a calm start
      if (signal?.aborted) break;
    }
  } finally {
    try {
      await chaos('/chaos/reset');
    } catch {
      // Best effort: the lab may be down.
    }
  }
  const pass = rows.length === SCENARIOS.length && rows.every((r) => r.result === 'PASS');
  return { rows, pass };
}

export function formatTable(rows) {
  const head = ['scenario', 'service', 'level', 'reason', 'detect s', 'recover s', 'result'];
  const body = rows.map((r) => [r.scenario, r.service, r.level, r.reason, r.detectS, r.recoverS, r.result].map(String));
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();
  return [line(head), line(widths.map((w) => '-'.repeat(w))), ...body.map(line)].join('\n');
}

async function main() {
  let settings;
  try {
    settings = readEnv(process.env);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    return 1;
  }
  const abort = new AbortController();
  const onSignal = () => abort.abort();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  const io = {
    fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(10_000) }),
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: (m) => process.stderr.write(`[g1-score] ${m}\n`),
  };
  const { rows, pass } = await runCheck(settings, io, abort.signal);
  process.stdout.write(`${formatTable(rows)}\n`);
  process.stdout.write(pass && !abort.signal.aborted ? 'G1 score: PASS\n' : 'G1 score: FAIL\n');
  return pass && !abort.signal.aborted ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
