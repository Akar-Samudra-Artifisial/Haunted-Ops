#!/usr/bin/env node
// Builds a replay file (`fixtures/replays/<id>.json`, `review: null`) from ONE recorded incident of a database, read only.
//
//   DATABASE_URL=<url> node tools/replay-build/build-replay.mjs --incident <incident id> --id <replay id> \
//     --scenario error-spike|fog|dark-room [--title <text>] [--out-dir <dir>] [--lead-s 60] [--tail-s 30]
//
// It reads the Incident, its latest Hunt with the Steps and the Evidence, the latest Proposal of that Hunt and the Signal
// rows of the window, and writes one file of frames. Every string goes through the scrubber of
// `tools/sanitize-replay/sanitize-hunt-stream.mjs` and through `sanitizePrText` (the rules of the pull request text); ids
// become stable fake ids derived from the replay id; times are moved so that the window starts at 12:00:00 UTC of the
// recording date, and every clock time inside a string gets the same shift (`rewriteClocks`), so that the hour of the real
// incident is not in the file and the file has one clock. If the result still fails `validateReplayFile` the tool stops with field paths, never values.
// The database URL comes from the environment variable `DATABASE_URL` only (an argument would show in `ps` and in the shell
// history) and is never printed. A person reads and approves the file afterwards with `review-replay.mjs`.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { scrub } from '../sanitize-replay/sanitize-hunt-stream.mjs';
import { isMain } from '../../scripts/is-main.mjs';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SCENARIOS = ['error-spike', 'fog', 'dark-room'];
export const LAB_REPO_URL = 'https://github.com/Akar-Samudra-Artifisial/Haunted-Lab';
export const MAX_FRAMES = 400;
export const MAX_DURATION_MS = 900_000;
/** Text limits of the Hunt view (`HUNT_LIMITS` of the shared package). */
const CAPS = { step: 120, ref: 80, detail: 200, summary: 400, fixHint: 300, stopDetail: 200 };
const SERVICE_ORDER = ['gate', 'orders', 'payments', 'ledger'];
/** Cuts after the scrubber that the validator also checks: hosts of the cloud, `/root/` paths and long unbroken runs. */
const EXTRA = [
  { re: /\b[a-z0-9.-]+\.amazonaws\.com\b/gi, to: '[host]' },
  { re: /(?<![\w.-])\/root\/\S*/g, to: '[path]' },
  { re: /@[A-Za-z0-9_][A-Za-z0-9_-]*/g, to: '[mention]' },
  // `sanitizePrText` splits `#12` with a zero-width space (an issue reference on GitHub); that character is removed below, so the reference is split with a plain space.
  { re: /#(?=[0-9])/g, to: '# ' },
  { re: /[A-Za-z0-9_-]{32,}/g, to: (m) => (/^[0-9a-f]{40}$/.test(m) ? m : '[token]') },
];
/** Zero-width and direction characters, which the validator refuses. */
const INVISIBLE = /[\u061C\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u{E0000}-\u{E007F}]/gu;
/** Host names (`staging.example.com`) and IPv6 addresses, by the rules of the validator (the same functions). */
function maskNetwork(text, deps) {
  return text
    .replace(/[A-Za-z0-9._-]+/g, (m) => (deps.hasHostName(m) ? '[host]' : m))
    .replace(/(?<![A-Za-z0-9_])[0-9A-Fa-f:]{2,}(?![A-Za-z0-9_])/g, (m) => (deps.hasIpv6(m) ? '[ip]' : m));
}
const DAY_MS = 86_400_000;
/** A clock that lands further than this from the window is not rewritten and stops the build (`clock_out_of_range`). */
export const CLOCK_RANGE_MS = 7 * 3_600_000;
/** The recording date of a window and the instant 12:00:00 UTC of that date, where the window start is moved to. */
export function replayBase(startMs) {
  const recordedOn = new Date(startMs).toISOString().slice(0, 10);
  return { recordedOn, baseMs: Date.parse(`${recordedOn}T12:00:00.000Z`) };
}
/** The epoch numbers that count: 10 digits (seconds) in 1400000000..2100000000 and 13 digits (milliseconds) in 1400000000000..2100000000000. */
const EPOCH_MIN_S = 1_400_000_000;
const EPOCH_MAX_S = 2_100_000_000;
// One pass over the text, left to right: a full ISO time with `Z` or an offset `+HH:MM` / `-HH:MM` first (one instant, so the clock and the offset
// inside it are not read twice), then a bare date, then an epoch number of 10 or 13 digits that stands alone (no letter, digit, `_` or `.` before
// it, no letter, digit or `_` after it), then a clock `HH:MM:SSZ`, `HH:MM:SS` or `HH:MM` that is not part of a longer number or of an offset
// (a digit, `:`, `.`, `+` or `-` before; a digit, or `:` and a digit, after).
const CLOCK_TOKEN = /(?<![\d])(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})|(?<![\d-])(\d{4}-\d{2}-\d{2})(?![\d-])|(?<![A-Za-z0-9_.])(\d{10}|\d{13})(?![A-Za-z0-9_])|(?<![\d:.+-])([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?(Z)?(?!\d)(?!:\d)/g;
const two = (n) => String(n).padStart(2, '0');
/**
 * Moves every clock time inside `text` with the shift the timestamps of the file get (`shift = base - start of the window`, base
 * 12:00 UTC of the recording date), each kept in its own format: `YYYY-MM-DDTHH:MM:SS(.sss)Z` (an ISO time with an offset `+HH:MM` or `-HH:MM` is one
 * instant, shifted and written in `Z` form), `HH:MM:SSZ`, `HH:MM:SS`, `HH:MM`, an epoch number (10 digits of seconds or 13 of milliseconds,
 * kept in its own number of digits) whose instant is within one day of the window, and a bare date of the incident or of the day before (both
 * stay as written: the recording date is the date of the window start). A bare clock is read on the date of the window start, the day before
 * or the day after, whichever lands nearest to the window. A clock or an ISO time more than 7 hours from the window is left as it is and
 * `outOfRange` is true; an epoch-shaped number more than one day from the window is left as it is too (the validator refuses it, as its date is
 * not the recording date). The result is as long as the text, except that an offset is replaced by `Z`.
 * @param {string} text @param {{ startMs: number, endMs: number }} win
 * @returns {{ text: string, outOfRange: boolean }}
 */
export function rewriteClocks(text, win) {
  const { recordedOn, baseMs } = replayBase(win.startMs);
  const shift = baseMs - win.startMs;
  const day0 = Date.parse(`${recordedOn}T00:00:00.000Z`);
  const distance = (t) => (t < win.startMs ? win.startMs - t : t > win.endMs ? t - win.endMs : 0);
  let outOfRange = false;
  const out = text.replace(CLOCK_TOKEN, (match, isoHead, frac, zone, date, epoch, hh, mm, ss, z) => {
    if (isoHead !== undefined) {
      // Milliseconds from the first 3 digits of the fraction; digits past them are kept as written.
      const ms3 = frac === undefined ? '000' : frac.slice(0, 3).padEnd(3, '0');
      const t = Date.parse(`${isoHead}.${ms3}${zone}`);
      if (Number.isNaN(t) || distance(t) > CLOCK_RANGE_MS) {
        outOfRange = true;
        return match;
      }
      const moved = new Date(t + shift).toISOString();
      if (frac === undefined) return `${moved.slice(0, 19)}Z`;
      return `${moved.slice(0, 19)}.${moved.slice(20, 20 + Math.min(3, frac.length))}${frac.slice(3)}Z`;
    }
    if (epoch !== undefined) {
      const n = Number(epoch);
      const seconds = epoch.length === 10;
      const inRange = (seconds ? n : n / 1000) >= EPOCH_MIN_S && (seconds ? n : n / 1000) <= EPOCH_MAX_S;
      const t = seconds ? n * 1000 : n;
      if (!inRange || distance(t) > DAY_MS) return match;
      return String(seconds ? Math.floor((t + shift) / 1000) : t + shift);
    }
    if (date !== undefined) {
      const d = Date.parse(`${date}T00:00:00.000Z`);
      // The incident date and the day before map to the recording date and the day before it. The recording date is the
      // date of the window start, so the shift moves no bare date to another day: both stay as written. Other dates are left alone.
      if (Number.isNaN(d) || (d !== day0 && d !== day0 - DAY_MS)) return match;
      return new Date(d).toISOString().slice(0, 10);
    }
    const secs = ss === undefined ? 0 : Number(ss);
    const inDay = (Number(hh) * 3600 + Number(mm) * 60 + secs) * 1000;
    const best = [0, -1, 1].map((k) => day0 + k * DAY_MS + inDay).reduce((a, b) => (distance(b) < distance(a) ? b : a));
    if (distance(best) > CLOCK_RANGE_MS) {
      outOfRange = true;
      return match;
    }
    const m = new Date(best + shift);
    return `${two(m.getUTCHours())}:${two(m.getUTCMinutes())}${ss === undefined ? '' : `:${two(m.getUTCSeconds())}`}${z ?? ''}`;
  });
  return { text: out, outOfRange };
}
/** The field paths (`$.frames[2].hunt.summary`) of the strings of `value` that are in `bad`. Never the strings. */
function pathsOfStrings(value, bad, path = '$', out = []) {
  if (typeof value === 'string') {
    if (bad.has(value)) out.push(path);
  } else if (Array.isArray(value)) value.forEach((v, i) => pathsOfStrings(v, bad, `${path}[${i}]`, out));
  else if (value !== null && typeof value === 'object') for (const [k, v] of Object.entries(value)) pathsOfStrings(v, bad, `${path}.${k}`, out);
  return out;
}
export class ReplayBuildError extends Error {
  /** @param {string} code @param {string[]} [paths] */
  constructor(code, paths = []) {
    super(paths.length === 0 ? code : `${code}: ${paths.join(' ')}`);
    this.name = 'ReplayBuildError';
    this.code = code;
    this.paths = paths;
  }
}
/** The newest modification time (ms) of the files of `dir` whose name passes `keep`, or 0. */
function newestMtime(dir, keep) {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    // `generated` is the Prisma client, rewritten by `prisma generate` on every build.
    if (entry.isDirectory()) newest = entry.name === 'generated' ? newest : Math.max(newest, newestMtime(full, keep));
    else if (entry.isFile() && keep(entry.name)) newest = Math.max(newest, statSync(full).mtimeMs);
  }
  return newest;
}
/**
 * Stops when the built folder is missing or older than the sources it was built from: an old build would validate and
 * sanitize with old rules. The message names the package and says how to build.
 * @param {string} name label for the message, @param {string} distDir @param {string} srcDir
 */
export function assertBuildFresh(name, distDir, srcDir) {
  const built = existsSync(distDir) ? newestMtime(distDir, (n) => n.endsWith('.js')) : 0;
  const edited = existsSync(srcDir) ? newestMtime(srcDir, (n) => n.endsWith('.ts') && !n.endsWith('.d.ts') && !/\.(?:test|property\.test)\.ts$/.test(n)) : 0;
  if (built === 0 || edited > built) throw new ReplayBuildError('build_stale', [`${name} (run "pnpm build" first)`]);
}
/** The shared validator, the haunt scorer and the pull request text rules, from the built packages (which must be current). */
export async function loadDeps({ check = true } = {}) {
  if (check) {
    assertBuildFresh('packages/shared', join(ROOT, 'packages/shared/dist'), join(ROOT, 'packages/shared/src'));
    assertBuildFresh('apps/api', join(ROOT, 'apps/api/dist'), join(ROOT, 'apps/api/src'));
  }
  const shared = await import(pathToFileURL(join(ROOT, 'packages/shared/dist/index.js')).href);
  const prText = await import(pathToFileURL(join(ROOT, 'apps/api/dist/fix/pr-text.js')).href);
  return {
    validateReplayFile: shared.validateReplayFile,
    hasHostName: shared.hasHostName,
    hasIpv6: shared.hasIpv6,
    initialHauntState: shared.initialHauntState,
    stepHaunt: shared.stepHaunt,
    sanitizePrText: prText.sanitizePrText,
  };
}
/** Reads the rows of one incident. Only `find*` calls: nothing is written. */
export async function readIncidentRows(prisma, incidentId, { leadMs = 60_000, tailMs = 30_000 } = {}) {
  const incident = await prisma.incident.findUnique({ where: { id: incidentId }, include: { service: { select: { name: true } } } });
  if (incident === null) throw new ReplayBuildError('incident_not_found');
  const hunt = await prisma.hunt.findFirst({
    where: { incidentId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    include: { service: { select: { name: true } }, steps: { orderBy: { index: 'asc' } }, evidence: { orderBy: { order: 'asc' } } },
  });
  const proposal =
    hunt === null ? null : await prisma.proposal.findFirst({ where: { huntId: hunt.id }, orderBy: [{ attempt: 'desc' }] });
  const times = [incident.openedAt, incident.closedAt, hunt?.createdAt, hunt?.finishedAt, proposal?.createdAt, proposal?.openedAt, proposal?.mergedAt, proposal?.deployedAt, proposal?.finishedAt]
    .filter((d) => d instanceof Date)
    .map((d) => d.getTime());
  const startMs = incident.openedAt.getTime() - leadMs;
  const endMs = Math.max(...times) + tailMs;
  if (endMs - startMs > MAX_DURATION_MS) throw new ReplayBuildError('window_too_long');
  const services = await prisma.service.findMany({ select: { name: true, roomX: true, roomY: true } });
  const signals = await prisma.signal.findMany({
    where: { at: { gte: new Date(startMs), lte: new Date(endMs) } },
    orderBy: [{ at: 'asc' }, { id: 'asc' }],
    select: { kind: true, value: true, at: true, service: { select: { name: true } } },
  });
  return {
    incident: { id: incident.id, service: incident.service.name, openedAt: incident.openedAt, closedAt: incident.closedAt, peakLevel: incident.peakLevel },
    services,
    signals: signals.map((s) => ({ service: s.service.name, kind: s.kind, value: s.value, at: s.at })),
    hunt:
      hunt === null
        ? null
        : { ...hunt, service: hunt.service.name, steps: hunt.steps.map(({ index, tool, summary, at }) => ({ index, tool, summary, at })), evidence: hunt.evidence.map(({ order, kind, ref, detail, cited }) => ({ order, kind, ref, detail, cited })) },
    proposal,
    window: { startMs, endMs },
  };
}
const ms = (d) => (d instanceof Date ? d.getTime() : null);
/** A stable fake cuid (25 lowercase letters and digits) per replay id, kind and order of appearance. */
function idMaker(replayId) {
  const seen = new Map();
  return (kind, real) => {
    if (real === null || real === undefined) return null;
    const key = `${kind}:${real}`;
    if (!seen.has(key)) {
      const n = [...seen.keys()].filter((k) => k.startsWith(`${kind}:`)).length + 1;
      seen.set(key, `r${createHash('sha256').update(`${replayId}:${kind}:${n}`).digest('hex').slice(0, 24)}`);
    }
    return seen.get(key);
  };
}
/**
 * Builds the replay file from rows (see `readIncidentRows`). Pure apart from `deps`. Throws `ReplayBuildError`.
 * @param {object} rows
 * @param {{ id: string, title: string, scenario: string }} opts
 * @param {Awaited<ReturnType<typeof loadDeps>>} deps
 */
export function buildReplay(rows, opts, deps) {
  if (!SCENARIOS.includes(opts.scenario)) throw new ReplayBuildError('bad_scenario');
  const { incident, hunt, proposal } = rows;
  const startMs = rows.window.startMs;
  const endMs = rows.window.endMs;
  if (!(endMs > startMs)) throw new ReplayBuildError('bad_window');
  if (endMs - startMs > MAX_DURATION_MS) throw new ReplayBuildError('window_too_long');
  // One clock for the whole file: the window start is moved to 12:00:00 UTC of the recording date (so a `since` up to 6 hours
  // before the incident stays on that date), timestamps and the clock times inside strings get the same shift.
  const { recordedOn, baseMs } = replayBase(startMs);
  const iso = (t) => new Date(baseMs + (t - startMs)).toISOString();
  /** Final texts that hold a clock far from the window (left as they are): their field paths stop the build. */
  const farClock = new Set();
  const fake = idMaker(opts.id);
  const scrubAll = (text) => {
    let out = scrub(text);
    for (const { re, to } of EXTRA) out = out.replace(re, to);
    return maskNetwork(out, deps);
  };
  // Scrub, then the rules of the pull request text, then again until nothing changes: removing an invisible character or a
  // piece of markup can join two parts into a token that the first pass did not see. `sanitizePrText` writes a zero-width
  // space after every `@` (to defuse a mention on GitHub); a replay is not GitHub text and the validator refuses invisible
  // characters, so they are removed each time (a mention itself was already replaced by `[mention]`).
  const clean = (text, cap) => {
    let out = String(text ?? '');
    for (let i = 0; i < 5; i++) {
      const next = deps.sanitizePrText(scrubAll(out.replace(INVISIBLE, '')), cap).replace(INVISIBLE, '');
      if (next === out) break;
      out = next;
    }
    // Once, after the text is stable (the rewrite is not idempotent: a second pass would move the clocks again).
    const moved = rewriteClocks(out, rows.window);
    if (moved.outOfRange) farClock.add(moved.text);
    return moved.text;
  };
  // `min1` fields (step summary, evidence ref, diagnosis summary) cannot be empty.
  const cleanReq = (text, cap) => clean(text, cap) || '[removed]';
  const rooms = new Map(rows.services.map((s) => [s.name, { x: s.roomX, y: s.roomY }]));
  const roomOf = (name) => rooms.get(name) ?? { x: SERVICE_ORDER.indexOf(name) % 2, y: Math.floor(SERVICE_ORDER.indexOf(name) / 2) };
  // --- signals: one sample per service and second ---
  const polls = new Map();
  for (const s of rows.signals) {
    const sec = Math.floor((s.at.getTime() - startMs) / 1000);
    if (sec < 0) continue;
    if (!polls.has(sec)) polls.set(sec, new Map());
    const perService = polls.get(sec);
    const cur = perService.get(s.service) ?? { errorRate: null, p95Ms: null, up: null, at: s.at.getTime() };
    if (s.kind === 'error_rate') cur.errorRate = s.value;
    else if (s.kind === 'p95_ms') cur.p95Ms = s.value;
    else if (s.kind === 'up') cur.up = s.value;
    cur.at = Math.max(cur.at, s.at.getTime());
    perService.set(s.service, cur);
  }
  // --- hunt and proposal timelines ---
  const huntTimes = hunt === null ? [] : [ms(hunt.createdAt), ms(hunt.startedAt), ms(hunt.finishedAt), ...hunt.steps.map((s) => ms(s.at))];
  const stage = proposal === null ? [] : proposalStages(proposal);
  const proposalTimes = stage.map((s) => s.at);
  const secOf = (t) => Math.min(Math.max(0, Math.floor((t - startMs) / 1000)), Math.floor((endMs - startMs) / 1000));
  const eventSecs = new Set([0, ...polls.keys(), ...[...huntTimes, ...proposalTimes].filter((t) => t !== null).map(secOf)]);
  const secs = [...eventSecs].sort((a, b) => a - b);
  // --- services: the haunt level of each poll, with the hysteresis of the ingest ---
  const haunt = new Map(SERVICE_ORDER.map((n) => [n, { state: deps.initialHauntState(0, null), metrics: null, updatedMs: startMs, peak: 0 }]));
  const huntSummaryAt = (t) => (hunt === null ? null : huntViews(hunt, proposal, stage, t, { clean, cleanReq, fake, iso }).summary);
  const proposalSummaryAt = (t) => {
    const v = proposal === null ? null : proposalViewAt(proposal, stage, t, hunt, { fake, iso, service: hunt?.service ?? incident.service });
    return v === null ? null : summaryOf(v);
  };
  const servicesAt = (t) => {
    const hs = huntSummaryAt(t);
    const ps = proposalSummaryAt(t);
    return SERVICE_ORDER.map((name) => {
      const h = haunt.get(name);
      const open = name === incident.service && t >= ms(incident.openedAt) && (incident.closedAt === null || t < ms(incident.closedAt));
      return {
        name,
        room: roomOf(name),
        hauntLevel: h.state.level,
        reason: h.state.reason === null ? null : { kind: h.state.reason.kind, value: h.state.reason.value },
        metrics: h.metrics,
        openIncident: open ? { id: fake('incident', incident.id), openedAt: iso(ms(incident.openedAt)), peakLevel: Math.min(4, Math.max(h.peak, 0)) } : null,
        updatedAt: iso(h.updatedMs),
        hunt: hunt !== null && hunt.service === name ? hs : null,
        proposal: hunt !== null && hunt.service === name ? ps : null,
      };
    });
  };
  const frames = [];
  let last = { services: '', hunt: '', proposal: '' };
  for (const sec of secs) {
    const t = startMs + sec * 1000 + 999;
    for (const [name, sample] of polls.get(sec) ?? []) {
      const h = haunt.get(name);
      if (h === undefined) continue;
      const before = h.state;
      h.state = deps.stepHaunt(h.state, { errorRate: sample.errorRate, p95Ms: sample.p95Ms, up: sample.up });
      h.metrics = { errorRate: sample.errorRate, p95Ms: sample.p95Ms, up: sample.up, at: iso(sample.at) };
      if (before.level !== h.state.level || before.reason?.kind !== h.state.reason?.kind) h.updatedMs = sample.at;
      if (name === incident.service && sample.at >= ms(incident.openedAt)) h.peak = Math.max(h.peak, h.state.level);
    }
    const services = servicesAt(t);
    const huntView = hunt === null ? null : huntViews(hunt, proposal, stage, t, { clean, cleanReq, fake, iso }).detail;
    const proposalView = proposal === null ? null : proposalViewAt(proposal, stage, t, hunt, { fake, iso, service: hunt?.service ?? incident.service });
    const cur = { services: JSON.stringify(services), hunt: JSON.stringify(huntView), proposal: JSON.stringify(proposalView) };
    const first = frames.length === 0;
    const frame = { t: sec * 1000 };
    if (first || cur.services !== last.services) frame.services = services;
    if (first || cur.hunt !== last.hunt) frame.hunt = huntView;
    if (first || cur.proposal !== last.proposal) frame.proposal = proposalView;
    last = cur;
    if (!first && Object.keys(frame).length === 1) continue;
    frames.push(frame);
  }
  const thinned = thin(frames);
  const lastT = (thinned[thinned.length - 1] ?? { t: 0 }).t;
  const durationMs = Math.max(1000, Math.min(MAX_DURATION_MS, Math.ceil((endMs - startMs) / 1000) * 1000), lastT);
  const cleanTitle = cleanReq(opts.title, 80);
  const title = cleanTitle.replace(/\s+/g, ' ');
  if (farClock.has(cleanTitle)) farClock.add(title);
  const file = {
    version: 1,
    id: opts.id,
    title,
    scenario: opts.scenario,
    recordedOn,
    durationMs,
    review: null,
    frames: thinned,
  };
  const farPaths = farClock.size === 0 ? [] : pathsOfStrings(file, farClock);
  if (farPaths.length > 0) throw new ReplayBuildError('clock_out_of_range', farPaths);
  const checked = deps.validateReplayFile(file);
  if (!checked.ok) throw new ReplayBuildError('invalid_replay', checked.errors);
  return file;
}
/** The whole file as UTF-8 JSON must stay under this (`REPLAY_LIMITS.bytes`). A little room is left for the header. */
export const MAX_BYTES = 256 * 1024 - 1024;
/**
 * Keeps at most 400 frames and at most 256 KiB: frames that carry a hunt or a proposal stay (and the first), the other
 * frames (only the services changed) are dropped evenly until both limits hold.
 */
function thin(frames) {
  const keep = (f, i) => i === 0 || 'hunt' in f || 'proposal' in f;
  const optional = frames.map((f, i) => ({ f, i })).filter(({ f, i }) => !keep(f, i));
  const must = frames.length - optional.length;
  const bytesOf = (list) => Buffer.byteLength(JSON.stringify(list));
  const pick = (count) => {
    const chosen = new Set();
    for (let k = 0; k < count; k++) chosen.add(optional[Math.floor(((k + 0.5) * optional.length) / count)]?.i);
    return frames.filter((f, i) => keep(f, i) || chosen.has(i));
  };
  let count = Math.min(optional.length, MAX_FRAMES - must);
  if (count < 0) throw new ReplayBuildError('too_many_frames');
  for (;;) {
    const out = count === optional.length ? frames : pick(count);
    if (bytesOf(out) <= MAX_BYTES) return out;
    if (count === 0) throw new ReplayBuildError('too_large');
    count = Math.floor(count * 0.85);
  }
}
/** Status stages of a Proposal: `{ at, status }` in time order, from the stored times. */
function proposalStages(p) {
  const out = [{ at: ms(p.createdAt), status: 'drafting' }];
  if (p.openedAt) out.push({ at: ms(p.openedAt), status: 'open' });
  if (p.mergedAt && (p.status === 'merged' || p.status === 'deployed')) out.push({ at: ms(p.mergedAt), status: 'merged' });
  if (p.deployedAt && p.status === 'deployed') out.push({ at: ms(p.deployedAt), status: 'deployed' });
  if (p.status === 'checks_failed' || p.status === 'failed' || p.status === 'rejected') {
    // `updatedAt` is the time of the last write (a wall-clock time): it is never used, only `finishedAt`.
    out.push({ at: Math.max(ms(p.finishedAt) ?? 0, out[out.length - 1].at), status: p.status });
  }
  return out;
}
function proposalViewAt(p, stages, t, hunt, ctx) {
  const reached = stages.filter((s) => s.at <= t);
  if (reached.length === 0) return null;
  const cur = reached[reached.length - 1];
  const status = cur.status;
  const pastOpen = stages.some((s) => s.status === 'open' && s.at <= t);
  const hasPr = pastOpen && p.prNumber !== null && p.prNumber !== undefined;
  const mergedStage = status === 'merged' || status === 'deployed';
  const stamp = (name) => (stages.some((s) => s.status === name && s.at <= t) ? ctx.iso(ms(p[`${name === 'open' ? 'opened' : name}At`])) : null);
  return {
    id: ctx.fake('proposal', p.id),
    huntId: ctx.fake('hunt', p.huntId),
    attempt: p.attempt,
    kind: status === 'drafting' ? null : (p.kind ?? null),
    status,
    prNumber: hasPr ? p.prNumber : null,
    prUrl: hasPr ? `${LAB_REPO_URL}/pull/${p.prNumber}` : null,
    // A login is a person: the file only says that somebody merged.
    mergedBy: mergedStage && p.mergedBy ? 'reviewer' : null,
    checks: status === 'drafting' ? [] : (Array.isArray(p.checks) ? p.checks : []),
    failReason: status === 'failed' || status === 'checks_failed' ? (p.failReason ?? null) : null,
    aiFailReason: status === 'drafting' ? null : (p.aiFailReason ?? null),
    updatedAt: ctx.iso(cur.at),
    // `aiFailDetail` is internal: it is never in a replay.
    aiFailDetail: null,
    service: ctx.service,
    credits: status === 'drafting' ? 0 : p.credits,
    creditsEstimated: status === 'drafting' ? false : Boolean(p.creditsEstimated),
    createdAt: ctx.iso(ms(p.createdAt)),
    openedAt: stamp('open'),
    mergedAt: mergedStage ? stamp('merged') : null,
    deployedAt: status === 'deployed' ? stamp('deployed') : null,
  };
}
function summaryOf(v) {
  const { aiFailDetail: _a, service: _s, credits: _c, creditsEstimated: _e, createdAt: _cr, openedAt: _o, mergedAt: _m, deployedAt: _d, ...summary } = v;
  return summary;
}
/** The Hunt as of time `t`: its summary and its detail. Texts are cleaned; only the total credits are kept. */
function huntViews(h, proposal, stages, t, ctx) {
  const created = ms(h.createdAt);
  if (t < created) return { summary: null, detail: null };
  const finishedAt = ms(h.finishedAt);
  const ended = ['succeeded', 'failed', 'cancelled'].includes(h.status);
  const finished = ended && (finishedAt === null ? true : finishedAt <= t);
  const started = ms(h.startedAt) !== null && ms(h.startedAt) <= t;
  const status = finished ? h.status : started ? 'running' : 'queued';
  const visible = h.steps.filter((s) => ms(s.at) <= t).sort((a, b) => a.index - b.index);
  const stepView = (s) => ({ index: s.index, tool: s.tool, summary: ctx.cleanReq(s.summary, CAPS.step), at: ctx.iso(ms(s.at)) });
  const evidence = finished ? [...h.evidence].sort((a, b) => a.order - b.order) : [];
  const succeeded = finished && h.status === 'succeeded';
  const proposalNow = proposal === null ? null : proposalViewAt(proposal, stages, t, h, { fake: ctx.fake, iso: ctx.iso, service: h.service });
  const summary = {
    id: ctx.fake('hunt', h.id),
    incidentId: ctx.fake('incident', h.incidentId),
    service: h.service,
    trigger: h.trigger,
    status,
    reason: finished ? h.endReason : null,
    steps: visible.slice(-8).map(stepView),
    stepCount: visible.length,
    evidenceCount: evidence.length,
    diagnosis: succeeded
      ? { culpritDeploy: h.culpritDeploy, culpritSha: h.culpritSha, culpritService: h.culpritService, summary: ctx.cleanReq(h.summary, CAPS.summary) }
      : null,
    credits: finished ? h.credits : 0,
    queuedAt: ctx.iso(created),
    startedAt: status === 'queued' ? null : ctx.iso(ms(h.startedAt) ?? created),
    finishedAt: finished ? ctx.iso(finishedAt ?? ms(visible[visible.length - 1]?.at) ?? created) : null,
    diagnosedBy: finished ? (h.diagnosedBy ?? null) : null,
  };
  const detail = {
    ...summary,
    model: h.model,
    toolCalls: finished ? h.toolCalls : visible.length,
    durationMs: finished ? h.durationMs : null,
    invalidCheck: finished ? (h.invalidCheck ?? null) : null,
    stopDetail: finished && h.stopDetail ? ctx.clean(h.stopDetail, CAPS.stopDetail) || null : null,
    creditsEstimated: finished ? Boolean(h.creditsEstimated) : false,
    linkedHuntId: finished && h.linkedHuntId ? ctx.fake('hunt', h.linkedHuntId) : null,
    allSteps: visible.map(stepView),
    evidence: evidence.map((e) => ({ index: e.order, kind: e.kind, ref: ctx.cleanReq(e.ref, CAPS.ref), detail: ctx.clean(e.detail, CAPS.detail), cited: Boolean(e.cited) })),
    fixHint: succeeded && h.fixHint ? ctx.clean(h.fixHint, CAPS.fixHint) || null : null,
    proposal: proposalNow === null ? null : summaryOf(proposalNow),
  };
  return { summary, detail };
}
/** Writes the file; refuses to replace one that exists (it may carry a review). */
export function writeReplay(file, outDir) {
  const path = join(outDir, `${file.id}.json`);
  if (existsSync(path)) throw new ReplayBuildError('file_exists');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, { flag: 'wx' });
  return path;
}
function parseArgs(argv) {
  const out = {};
  const known = new Set(['incident', 'id', 'scenario', 'title', 'out-dir', 'lead-s', 'tail-s']);
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.startsWith('--') ? argv[i].slice(2) : null;
    if (key === null || !known.has(key) || argv[i + 1] === undefined) throw new ReplayBuildError('usage');
    out[key] = argv[i + 1];
  }
  return out;
}
export async function main(
  argv,
  io = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) },
  // Test seams: the real ones read the built packages and open a Prisma client on the URL.
  seams = {},
) {
  let prisma = null;
  try {
    const a = parseArgs(argv);
    for (const k of ['incident', 'id', 'scenario']) if (a[k] === undefined) throw new ReplayBuildError('usage');
    const databaseUrl = (seams.env ?? process.env).DATABASE_URL;
    if (typeof databaseUrl !== 'string' || databaseUrl === '') throw new ReplayBuildError('no_database_url');
    const lead = a['lead-s'] === undefined ? 60 : Number(a['lead-s']);
    const tail = a['tail-s'] === undefined ? 30 : Number(a['tail-s']);
    if (!Number.isInteger(lead) || !Number.isInteger(tail) || lead < 0 || tail < 0 || lead > 600 || tail > 600) throw new ReplayBuildError('usage');
    const deps = await (seams.loadDeps ?? loadDeps)();
    const createPrisma = seams.createPrisma ?? (async (url) => (await import(pathToFileURL(join(ROOT, 'apps/api/dist/prisma/client.js')).href)).createPrismaClient(url));
    prisma = await createPrisma(databaseUrl);
    const rows = await readIncidentRows(prisma, a.incident, { leadMs: lead * 1000, tailMs: tail * 1000 });
    const file = buildReplay(rows, { id: a.id, title: a.title ?? `${rows.incident.service} ${a.scenario}`, scenario: a.scenario }, deps);
    const path = writeReplay(file, resolve(a['out-dir'] ?? join(ROOT, 'fixtures/replays')));
    io.out(`Wrote ${path}\nframes: ${file.frames.length}, duration: ${file.durationMs} ms, review: none yet.\nRead it with tools/replay-build/review-replay.mjs before approving it.\n`);
    return 0;
  } catch (err) {
    // Codes and field paths only: never a database error (it can name the host) and never a value.
    io.err(`replay build failed: ${err instanceof ReplayBuildError ? err.message : 'database or internal error'}\n`);
    const usage = err instanceof ReplayBuildError && (err.code === 'usage' || err.code === 'no_database_url');
    if (usage) io.err('usage: DATABASE_URL=<url> build-replay.mjs --incident <id> --id <replay id> --scenario <error-spike|fog|dark-room> [--title <text>] [--out-dir <dir>] [--lead-s <n>] [--tail-s <n>]\nThe database URL is read from the environment variable DATABASE_URL only.\n');
    return usage ? 2 : 1;
  } finally {
    if (prisma !== null) await Promise.resolve(prisma.$disconnect()).catch(() => undefined);
  }
}
if (isMain(import.meta.url)) process.exit(await main(process.argv.slice(2)));
