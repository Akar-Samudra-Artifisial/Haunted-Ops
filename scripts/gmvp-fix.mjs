#!/usr/bin/env node
// Gate G-MVP (fix): with the lab supervisor, Prometheus and the API running (hunts and fixes on), apply one lab
// scenario through the chaos API, wait for the Hunt and for the Proposal to be `open`, print the pull request
// URL, wait for a HUMAN to merge it on GitHub (this script never merges, closes or edits a pull request), wait
// for the Proposal to be `deployed` and for every Incident to close, print a table and reset the lab. The reset
// also runs on failure and on Ctrl-C. Exit 0 when the whole loop passed, 1 otherwise. A live run spends Credits.
//
// Environment (names only; values come from the environment, never printed):
//   API_URL        default http://127.0.0.1:3100
//   CHAOS_URL      default http://127.0.0.1:4100
//   CHAOS_TOKEN    required, bearer token of the lab chaos API. It is sent only to CHAOS_URL and never printed.
//   SCENARIO       default error-spike (error-spike, fog or dark-room)
//   MERGE_WAIT_MS  default 900000 (15 minutes): how long a human has to merge the pull request
//   HUNT_WORKDIR   optional, only to print where the Hunt stream file is (default: the OS temp folder)
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RECOVER_S, SCENARIOS, EnvError, isBaseline, waitFor } from './g1-score.mjs';
import { SKEW_MS, durationS, noOpenIncident } from './g2-hunt.mjs';
export { EnvError, SCENARIOS };
export const BASELINE_S = 120;
/** From applying the scenario to an `open` Proposal: the Hunt (up to 180 s), then the fixer and the Checks. */
export const OPEN_TIMEOUT_S = 420;
/** From the merge to `deployed`: the watcher poll, the deploy and the Deploy Record confirmation. */
export const DEPLOY_TIMEOUT_S = 480;
/** From `deployed` until every Incident is closed. */
export const CLOSE_TIMEOUT_S = RECOVER_S + 60;
export const DEFAULT_MERGE_WAIT_MS = 900_000;
const MAX_MERGE_WAIT_MS = 3_600_000;
const FAILED = new Set(['checks_failed', 'rejected', 'failed']);
const ENDED = new Set(['succeeded', 'failed', 'cancelled']);
const PR_URL = /^https:\/\/github\.com\/[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}\/pull\/\d{1,8}$/;
/** Settings. Throws EnvError naming the variable, never a value. */
export function readSettings(env) {
  const token = env.CHAOS_TOKEN;
  if (token === undefined || token.trim() === '') throw new EnvError('CHAOS_TOKEN');
  const trim = (v) => v.replace(/\/+$/, '');
  const scenarioName = env.SCENARIO?.trim() || 'error-spike';
  const scenario = SCENARIOS.find((s) => s.name === scenarioName);
  if (scenario === undefined) throw new EnvError('SCENARIO');
  const rawWait = env.MERGE_WAIT_MS?.trim();
  const wait = rawWait === undefined || rawWait === '' ? DEFAULT_MERGE_WAIT_MS : Number(rawWait);
  if (!Number.isInteger(wait) || wait < 1000 || wait > MAX_MERGE_WAIT_MS) throw new EnvError('MERGE_WAIT_MS');
  return {
    apiUrl: trim(env.API_URL?.trim() || 'http://127.0.0.1:3100'),
    chaosUrl: trim(env.CHAOS_URL?.trim() || 'http://127.0.0.1:4100'),
    token,
    scenario,
    mergeWaitMs: wait,
    huntWorkdir: env.HUNT_WORKDIR?.trim() || join(tmpdir(), 'haunted-ops-hunts'),
  };
}
/** Where the reduced stream of a Hunt is kept by the API. */
export const streamFile = (workdir, huntId) => join(workdir, `${huntId}.stream.jsonl`);
/** The Hunts of a scenario: the latest Hunt of each Service that was queued since `since`. */
export function huntsSince(services, since) {
  const out = [];
  for (const s of Array.isArray(services) ? services : []) {
    const h = s.hunt;
    if (h && Date.parse(h.queuedAt) >= since - SKEW_MS) out.push({ ...h, service: s.name });
  }
  return out;
}
/** The Proposal of a Hunt of this scenario that the Services show, the latest one when there are several. */
export function trackedProposal(services, since) {
  let best = null;
  for (const s of Array.isArray(services) ? services : []) {
    const p = s.proposal;
    const h = s.hunt;
    if (!p || !h || p.huntId !== h.id || !(Date.parse(h.queuedAt) >= since - SKEW_MS)) continue;
    if (best === null || Date.parse(p.updatedAt) > Date.parse(best.proposal.updatedAt)) best = { service: s.name, hunt: h, proposal: p };
  }
  return best;
}
/**
 * Where the loop is, from `GET /api/services`:
 *   waiting     no Proposal yet and a Hunt may still produce one
 *   drafting | open | merged | deployed   the status of the tracked Proposal
 *   failed      the Proposal ended `checks_failed`, `rejected` or `failed`, or every Hunt ended with a failure and
 *               no Proposal exists; `reason` says which, in fixed words
 */
export function judgePhase(services, since) {
  const tracked = trackedProposal(services, since);
  if (tracked !== null) {
    const { proposal } = tracked;
    if (FAILED.has(proposal.status)) {
      return { phase: 'failed', reason: `proposal ${proposal.status}${proposal.failReason ? ` (${proposal.failReason})` : ''}`, tracked };
    }
    return { phase: proposal.status, reason: null, tracked };
  }
  const hunts = huntsSince(services, since);
  if (hunts.length > 0 && hunts.every((h) => ENDED.has(h.status))) {
    const failed = hunts.filter((h) => h.status === 'failed');
    if (failed.length > 0) return { phase: 'failed', reason: `hunt failed (${failed.map((h) => `${h.service}:${h.reason ?? 'no reason'}`).join(', ')})`, tracked: null };
  }
  return { phase: 'waiting', reason: null, tracked: null };
}
/** `5/5 ok` or `3/5 ok (failed: size, tests)`; `-` without Checks. */
export function checksText(checks) {
  if (!Array.isArray(checks) || checks.length === 0) return '-';
  const bad = checks.filter((c) => c.ok !== true).map((c) => c.name);
  return `${checks.length - bad.length}/${checks.length} ok${bad.length > 0 ? ` (failed: ${bad.join(', ')})` : ''}`;
}
/** Seconds as text with one decimal, or `-`. */
export const secs = (n) => (typeof n === 'number' && Number.isFinite(n) ? n.toFixed(1) : '-');
export function formatTable(rows) {
  const head = ['scenario', 'kind', 'checks', 'pull request', 'merged by', 'credits', 'hunt s', 'draft s', 'merge wait s', 'deploy s', 'result'];
  const body = rows.map((r) => [r.scenario, r.kind, r.checks, r.pr, r.mergedBy, r.credits, r.huntS, r.draftS, r.mergeWaitS, r.deployS, r.result].map(String));
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();
  return [line(head), line(widths.map((w) => '-'.repeat(w))), ...body.map(line)].join('\n');
}
const blankRow = (scenario) => ({ scenario, kind: '-', checks: '-', pr: '-', mergedBy: '-', credits: '-', huntS: '-', draftS: '-', mergeWaitS: '-', deployS: '-', result: 'FAIL' });
/**
 * Runs the whole gate. `io` has fetch, now, sleep, log (stderr) and print (stdout). The chaos token goes only to
 * `chaosUrl`; the only requests to the API are GET. Always sends a final reset. Returns { rows, pass }.
 */
export async function runGate(settings, io, signal) {
  const { apiUrl, chaosUrl, token, scenario, mergeWaitMs, huntWorkdir } = settings;
  const { fetch: doFetch, now, sleep } = io;
  const getJson = async (path, what) => {
    const res = await doFetch(`${apiUrl}${path}`, { method: 'GET', headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`${what} answered ${res.status}`);
    return res.json();
  };
  const readServices = () => getJson('/api/services', 'GET /api/services');
  const chaos = async (path) => {
    const res = await doFetch(`${chaosUrl}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`POST ${path} answered ${res.status}`);
  };
  const row = blankRow(scenario.name);
  const fail = (text) => {
    row.result = `FAIL (${text})`;
    return { rows: [row], pass: false };
  };
  try {
    io.log('waiting for a calm baseline');
    if (!(await waitFor(readServices, isBaseline, { timeoutS: BASELINE_S, now, sleep, signal })).ok) return fail(signal?.aborted ? 'interrupted' : 'not calm');
    const appliedAt = now();
    io.log(`applying ${scenario.name}`);
    try {
      await chaos(`/chaos/scenarios/${scenario.name}/apply`);
    } catch (err) {
      return fail(err.message);
    }
    // 1. The Hunt, then the Proposal, until it is open (or something ended).
    io.log('waiting for the Hunt and an open Proposal');
    const opened = await waitFor(readServices, (s) => ['open', 'merged', 'deployed', 'failed'].includes(judgePhase(s, appliedAt).phase), { timeoutS: OPEN_TIMEOUT_S, pollMs: 2000, now, sleep, signal });
    if (signal?.aborted) return fail('interrupted');
    const first = judgePhase(opened.last, appliedAt);
    if (!opened.ok) return fail(`no open Proposal in ${OPEN_TIMEOUT_S} s, last phase ${first.phase}`);
    if (first.phase === 'failed') return fail(first.reason);
    const { tracked } = first;
    const huntId = tracked.hunt.id;
    const proposalId = tracked.proposal.id;
    io.print(`hunt id: ${huntId}`);
    io.print(`stream file: ${streamFile(huntWorkdir, huntId)}`);
    row.huntS = secs(durationS(tracked.hunt.startedAt, tracked.hunt.finishedAt));
    // 2. The pull request, for a human.
    const url = tracked.proposal.prUrl;
    if (typeof url !== 'string' || !PR_URL.test(url)) return fail('the Proposal has no GitHub pull request URL');
    io.print('');
    io.print('PULL REQUEST: review it and merge it on GitHub (this script never merges):');
    io.print(url);
    io.print('');
    row.pr = `#${tracked.proposal.prNumber ?? '?'}`;
    row.kind = tracked.proposal.kind ?? '-';
    row.checks = checksText(tracked.proposal.checks);
    // 3. A human merges it, within MERGE_WAIT_MS.
    io.log(`waiting up to ${Math.round(mergeWaitMs / 1000)} s for the merge`);
    const merged = await waitFor(readServices, (s) => judgePhase(s, appliedAt).phase !== 'open', { timeoutS: mergeWaitMs / 1000, pollMs: 5000, now, sleep, signal });
    if (signal?.aborted) return fail('interrupted');
    const afterMerge = judgePhase(merged.last, appliedAt);
    if (!merged.ok) return fail(`not merged within ${Math.round(mergeWaitMs / 60000)} min`);
    if (afterMerge.phase === 'failed') return fail(afterMerge.reason);
    // 4. The deploy of the merged commit.
    io.log('merged; waiting for the deploy');
    const deployed = await waitFor(readServices, (s) => ['deployed', 'failed'].includes(judgePhase(s, appliedAt).phase), { timeoutS: DEPLOY_TIMEOUT_S, pollMs: 3000, now, sleep, signal });
    if (signal?.aborted) return fail('interrupted');
    const afterDeploy = judgePhase(deployed.last, appliedAt);
    if (!deployed.ok) return fail(`not deployed in ${DEPLOY_TIMEOUT_S} s`);
    if (afterDeploy.phase === 'failed') return fail(afterDeploy.reason);
    // 5. The Incidents close.
    io.log('deployed; waiting for every Incident to close');
    const closed = await waitFor(readServices, noOpenIncident, { timeoutS: CLOSE_TIMEOUT_S, now, sleep, signal });
    // The final numbers come from the public read routes.
    try {
      const view = await getJson(`/api/proposals/${encodeURIComponent(proposalId)}`, 'GET /api/proposals/:id');
      const hunt = await getJson(`/api/hunts/${encodeURIComponent(huntId)}`, 'GET /api/hunts/:id').catch(() => null);
      row.mergedBy = view.mergedBy ?? '-';
      row.checks = checksText(view.checks);
      row.credits = (Number(view.credits ?? 0) + Number(hunt?.credits ?? 0)).toFixed(2);
      row.draftS = secs(durationS(view.createdAt, view.openedAt));
      row.mergeWaitS = secs(durationS(view.openedAt, view.mergedAt));
      row.deployS = secs(durationS(view.mergedAt, view.deployedAt));
    } catch {
      // The table keeps its dashes; the verdict below does not depend on it.
    }
    if (signal?.aborted) return fail('interrupted');
    if (!closed.ok) return fail('incidents did not close');
    row.result = 'PASS';
    return { rows: [row], pass: true };
  } catch (err) {
    return fail(err?.message ?? 'error');
  } finally {
    try {
      io.log('resetting the lab');
      await chaos('/chaos/reset');
    } catch {
      // Best effort: the lab may be down.
    }
  }
}
async function main() {
  let settings;
  try {
    settings = readSettings(process.env);
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
    log: (m) => process.stderr.write(`[gmvp-fix] ${m}\n`),
    print: (m) => process.stdout.write(`${m}\n`),
  };
  const { rows, pass } = await runGate(settings, io, abort.signal);
  process.stdout.write(`${formatTable(rows)}\n`);
  const ok = pass && !abort.signal.aborted;
  process.stdout.write(ok ? 'G-MVP fix: PASS\n' : 'G-MVP fix: FAIL\n');
  return ok ? 0 : 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
