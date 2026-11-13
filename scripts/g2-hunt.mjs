#!/usr/bin/env node
// Gate G2 (hunt): with the lab and the API running and hunts on (HUNTS_ENABLED=true), apply each lab
// scenario through the chaos API and watch the Hunts the API starts. The lab is one call chain, so one
// fault opens several Incidents and the API may hunt any of them; what counts is the outcome. A scenario
// PASSES when, during it, exactly one Hunt succeeded with the scenario's planted commit and a culprit in
// the scenario's root Service (payments, orders, ledger), whichever Service it hunted, and no Hunt failed.
// Hunts that were withdrawn (cancelled) are reported with their reasons. Between scenarios it waits until
// every Incident is closed. Exit 0 when all three pass, 1 otherwise. A live run spends Credits.
//
// Environment (names only; values come from the environment, never printed):
//   API_URL        default http://127.0.0.1:3000
//   CHAOS_URL      default http://127.0.0.1:4100
//   CHAOS_TOKEN    required, bearer token of the lab chaos API. Sent only to CHAOS_URL.
//   SCENARIO_SHAS  default ../haunted-lab/scripts/scenario-shas.json (planted commits per scenario)
//   HUNT_COOLDOWN_S  optional wait after Incidents closed before the next scenario, default 0
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { RECOVER_S, SCENARIOS, EnvError, isBaseline, readEnv, waitFor } from './g1-score.mjs';

export { EnvError, SCENARIOS, readEnv };

export const BASELINE_S = 120;
export const HUNT_TIMEOUT_S = 180;
/** After every Hunt seen has ended, wait this long for a late one (an Incident that opens after the settle window). */
export const QUIET_S = 25;
/** Hunts queued this long before the scenario was applied still count as older (clock skew allowance). */
export const SKEW_MS = 2000;
const ENDED = new Set(['succeeded', 'failed', 'cancelled']);

/** Settings: the G1 settings plus the planted SHAs and an optional cooldown wait. Names only in errors. */
export function readSettings(env, readText) {
  const base = readEnv(env);
  const here = dirname(fileURLToPath(import.meta.url));
  const shaPath = env.SCENARIO_SHAS?.trim() || resolve(here, '..', '..', 'haunted-lab', 'scripts', 'scenario-shas.json');
  let shas;
  try {
    shas = parseShas(readText(shaPath));
  } catch {
    throw new EnvError('SCENARIO_SHAS');
  }
  const cooldown = Number(env.HUNT_COOLDOWN_S ?? 0);
  return { ...base, shas, cooldownS: Number.isFinite(cooldown) && cooldown >= 0 && cooldown <= 3600 ? cooldown : 0 };
}

/** The `shas` map of scenario-shas.json: each scenario of G1 needs a 40-hex SHA. */
export function parseShas(text) {
  const parsed = JSON.parse(text);
  const shas = parsed?.shas;
  for (const s of SCENARIOS) {
    if (typeof shas?.[s.name] !== 'string' || !/^[0-9a-f]{40}$/.test(shas[s.name])) throw new Error('bad shas');
  }
  return shas;
}

/** Seconds between two ISO times, or null. */
export function durationS(startedAt, finishedAt) {
  const a = Date.parse(startedAt);
  const b = Date.parse(finishedAt);
  return Number.isFinite(a) && Number.isFinite(b) && b >= a ? (b - a) / 1000 : null;
}

/** All Incidents are closed (the Services may still be settling their level). */
export function noOpenIncident(services) {
  return Array.isArray(services) && services.length === 4 && services.every((s) => (s.openIncident ?? null) === null);
}

/**
 * The verdict of a scenario from the Hunts it produced (Hunt details). It passes when exactly one Hunt
 * succeeded, with the planted commit and a culprit in the root Service, and no Hunt failed.
 */
export function judgeScenario(hunts, expectedSha, rootService) {
  if (hunts.length === 0) return { pass: false, text: 'FAIL (no hunt)', match: '-', hunt: null };
  const failed = hunts.filter((h) => h.status === 'failed');
  if (failed.length > 0) {
    const list = failed.map((h) => `${h.service}:${h.reason ?? 'no reason'}`).join(', ');
    return { pass: false, text: `FAIL (failed ${list})`, match: '-', hunt: hunts.find((h) => h.status === 'succeeded') ?? null };
  }
  const succeeded = hunts.filter((h) => h.status === 'succeeded');
  if (succeeded.length === 0) return { pass: false, text: 'FAIL (no hunt succeeded)', match: '-', hunt: null };
  const hunt = succeeded[0];
  if (succeeded.length > 1) return { pass: false, text: `FAIL (${succeeded.length} hunts succeeded)`, match: '-', hunt };
  if (hunt.diagnosis?.culpritSha !== expectedSha) return { pass: false, text: 'FAIL (wrong commit)', match: 'no', hunt };
  if (hunt.diagnosis?.culpritService !== rootService) return { pass: false, text: 'FAIL (wrong service)', match: 'yes', hunt };
  return { pass: true, text: 'PASS', match: 'yes', hunt };
}

/** The Hunts other than `hunt`, as `N (service:reason, ...)`. */
export function describeOthers(hunts, hunt) {
  const others = hunts.filter((h) => h !== hunt);
  return others.length === 0 ? '0' : `${others.length} (${others.map((h) => `${h.service}:${h.reason ?? h.status}`).join(', ')})`;
}

export function formatTable(rows) {
  const head = ['scenario', 'hunted', 'status', 'sha match', 'culprit in', 'other hunts', 'credits', 'duration s', 'result'];
  const body = rows.map((r) => [r.scenario, r.service, r.status, r.match, r.culpritService, r.others, r.credits, r.duration, r.result].map(String));
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();
  return [line(head), line(widths.map((w) => '-'.repeat(w))), ...body.map(line)].join('\n');
}

const blankRow = (scenario) => ({ scenario, service: '-', status: '-', match: '-', culpritService: '-', others: '-', credits: '-', duration: '-', result: 'FAIL' });

/** Runs the whole gate. `io` has fetch, now, sleep, log. Always sends a final reset. Returns { rows, pass }. */
export async function runGate({ apiUrl, chaosUrl, token, shas, cooldownS = 0 }, io, signal) {
  const { fetch: doFetch, now, sleep } = io;
  const getJson = async (url, what) => {
    const res = await doFetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`${what} answered ${res.status}`);
    return res.json();
  };
  const readServices = () => getJson(`${apiUrl}/api/services`, 'GET /api/services');
  const chaos = async (path) => {
    const res = await doFetch(`${chaosUrl}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`POST ${path} answered ${res.status}`);
  };
  const calm = () => waitFor(readServices, isBaseline, { timeoutS: BASELINE_S, now, sleep, signal });

  /**
   * Watches the latest Hunt of every Service during a scenario. Each Service shows only its latest Hunt,
   * so the watcher notes every Hunt it sees by id and when its status last changed.
   */
  const watcher = (since) => {
    const seen = new Map();
    let changedAt = now();
    const read = async () => {
      const services = await readServices();
      for (const s of Array.isArray(services) ? services : []) {
        const h = s.hunt;
        if (!h || !(Date.parse(h.queuedAt) >= since - SKEW_MS)) continue;
        if (seen.get(h.id)?.status !== h.status) changedAt = now();
        seen.set(h.id, { id: h.id, service: s.name, status: h.status });
      }
      return { seen, changedAt };
    };
    const settled = (r) => r.seen.size > 0 && [...r.seen.values()].every((h) => ENDED.has(h.status)) && now() - r.changedAt >= QUIET_S * 1000;
    return { read, settled, seen };
  };

  const rows = [];
  try {
    io.log('waiting for a calm baseline');
    if (!(await calm()).ok) {
      const row = blankRow('baseline');
      row.result = 'FAIL (not calm)';
      rows.push(row);
      return { rows, pass: false };
    }
    for (const scenario of SCENARIOS) {
      const row = blankRow(scenario.name);
      rows.push(row);
      const appliedAt = now();
      try {
        io.log(`applying ${scenario.name}`);
        await chaos(`/chaos/scenarios/${scenario.name}/apply`);
      } catch (err) {
        row.result = `FAIL (${err.message})`;
        break;
      }
      io.log(`watching the hunts of ${scenario.name} (root ${scenario.service})`);
      const w = watcher(appliedAt);
      const done = await waitFor(w.read, w.settled, { timeoutS: HUNT_TIMEOUT_S, now, sleep, signal });

      // The detail of every Hunt seen: the final status, the reason, the diagnosis, the credits and the times.
      const hunts = [];
      for (const s of w.seen.values()) {
        try {
          hunts.push(await getJson(`${apiUrl}/api/hunts/${encodeURIComponent(s.id)}`, 'GET /api/hunts/:id'));
        } catch {
          hunts.push({ id: s.id, service: s.service, status: s.status, reason: 'detail unavailable', credits: 0, diagnosis: null });
        }
      }
      const verdict = judgeScenario(hunts, shas[scenario.name], scenario.service);
      const hunt = verdict.hunt ?? hunts[0] ?? null;
      row.service = hunt?.service ?? '-';
      row.status = hunt?.status ?? 'no hunt';
      row.match = verdict.match;
      row.culpritService = hunt?.diagnosis?.culpritService ?? '-';
      row.others = hunts.length === 0 ? '0' : describeOthers(hunts, hunt);
      row.credits = hunts.reduce((sum, h) => sum + Number(h.credits ?? 0), 0).toFixed(2);
      const secs = hunt ? durationS(hunt.startedAt, hunt.finishedAt) : null;
      row.duration = secs === null ? '-' : secs.toFixed(1);
      row.result = done.ok || hunts.length > 0 ? verdict.text : `FAIL (no result in ${HUNT_TIMEOUT_S} s)`;
      if (!done.ok && hunts.length > 0 && verdict.pass) row.result = `FAIL (hunts did not settle in ${HUNT_TIMEOUT_S} s)`;

      let resetOk = true;
      try {
        io.log(`resetting after ${scenario.name}`);
        await chaos('/chaos/reset');
      } catch (err) {
        resetOk = false;
        row.result = `FAIL (${err.message})`;
      }
      // Every Incident closes before the next scenario: a leftover one would join its cascade.
      const closed = resetOk ? await waitFor(readServices, noOpenIncident, { timeoutS: RECOVER_S, now, sleep, signal }) : { ok: false };
      if (!closed.ok) {
        if (resetOk && row.result === 'PASS') row.result = 'FAIL (incidents did not close)';
        break; // later scenarios need a calm start
      }
      if (cooldownS > 0) await sleep(cooldownS * 1000);
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

async function main() {
  let settings;
  try {
    settings = readSettings(process.env, (p) => readFileSync(p, 'utf8'));
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
    log: (m) => process.stderr.write(`[g2-hunt] ${m}\n`),
  };
  const { rows, pass } = await runGate(settings, io, abort.signal);
  process.stdout.write(`${formatTable(rows)}\n`);
  const ok = pass && !abort.signal.aborted;
  process.stdout.write(ok ? 'G2 hunt: PASS\n' : 'G2 hunt: FAIL\n');
  return ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
