import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { MAX_FRAMES, ReplayBuildError, assertBuildFresh, buildReplay, loadDeps, main, readIncidentRows, rewriteClocks, writeReplay } from './build-replay.mjs';
import { PLANTED, SHA, at, makeRows } from './test-support.mjs';
let deps;
const dir = mkdtempSync(join(tmpdir(), 'replay-build-'));
before(async () => {
  deps = await loadDeps({ check: false });
});
after(() => rmSync(dir, { recursive: true, force: true }));
const OPTS = { id: 'unit-replay', title: 'Synthetic unit replay', scenario: 'error-spike' };
const build = (rows = makeRows(), opts = OPTS) => buildReplay(rows, opts, deps);
const lastOf = (file, key) => file.frames.filter((f) => f[key]).at(-1)[key];
test('builds a valid file with review null, a first frame at 0 and the recording date', () => {
  const file = build();
  assert.equal(file.version, 1);
  assert.equal(file.review, null);
  assert.equal(file.recordedOn, '2026-11-15');
  assert.equal(file.frames[0].t, 0);
  assert.ok('services' in file.frames[0] && 'hunt' in file.frames[0] && 'proposal' in file.frames[0]);
  assert.ok(file.durationMs >= file.frames.at(-1).t);
  assert.equal(deps.validateReplayFile(file).ok, true);
});
test('only frames where something changed, and the times are those of the recording date', () => {
  const file = build();
  for (const [i, frame] of file.frames.entries()) {
    if (i > 0) assert.ok(Object.keys(frame).length > 1, `frame ${i} is empty`);
  }
  const text = JSON.stringify(file);
  assert.ok(!text.includes('2026-11-15T09:'), 'the hour of the incident is in the file');
  // The window start is moved to 12:00:00 UTC of the recording date.
  assert.ok(text.includes('2026-11-15T12:00:'));
  assert.equal(file.frames[0].services[0].updatedAt, '2026-11-15T12:00:00.000Z');
});
// Real-looking strings of a hunt (replay task 12): the window starts at 04:20:00 UTC on 2026-11-16.
const CLOCK_START = Date.UTC(2026, 10, 16, 4, 20, 0);
const clockWindow = { startMs: CLOCK_START, endMs: CLOCK_START + 10 * 60_000 };
test('rewriteClocks moves every clock of a hunt into the replay clock, each in its own format', () => {
  const cases = [
    ['errors orders since 04:21', 'errors orders since 12:01'],
    ['deploys since 03:30', 'deploys since 11:10'],
    ['(04:25:55Z)', '(12:05:55Z)'],
    ['04:26:44 2026-11-16T04:26:44.885Z orders req POST /orders 200 1622ms rid=r-57a77f9c09504281', '12:06:44 2026-11-16T12:06:44.885Z orders req POST /orders 200 1622ms rid=r-57a77f9c09504281'],
    ['d-107 orders scenario/fog 739d121 04:25:55', 'd-107 orders scenario/fog 739d121 12:05:55'],
    ['on 2026-11-16 and 2026-11-15', 'on 2026-11-16 and 2026-11-15'],
    ['2026-11-16T04:26:44Z', '2026-11-16T12:06:44Z'],
  ];
  for (const [input, want] of cases) {
    const r = rewriteClocks(input, clockWindow);
    assert.equal(r.text, want, input);
    assert.equal(r.outOfRange, false, input);
  }
});
test('rewriteClocks leaves durations, ratios in prose, versions and longer numbers alone', () => {
  for (const text of ['200 1622ms', 'a ratio of 3:2 in prose', 'v1.2.3 and 12:30:45:10', '0.35 error ratio', '1:04:21', 'd-107', 'id 12345:67', '24:00 and 12:60']) {
    const r = rewriteClocks(text, clockWindow);
    assert.equal(r.text, text, text);
    assert.equal(r.outOfRange, false, text);
  }
});
// Replay task 13: epoch numbers and zone offsets. The window is 04:20:00 to 04:30:00 UTC on 2026-11-16; the shift is +7 h 40 min.
const SHIFT_MS = 27_600_000;
test('rewriteClocks shifts an epoch number of seconds or milliseconds of the window, in its own number of digits', () => {
  const t = Date.UTC(2026, 10, 16, 4, 21, 5);
  const r = rewriteClocks(`ts=${t / 1000} and ${t} and (${t / 1000}).`, clockWindow);
  assert.equal(r.text, `ts=${(t + SHIFT_MS) / 1000} and ${t + SHIFT_MS} and (${(t + SHIFT_MS) / 1000}).`);
  assert.equal(r.outOfRange, false);
  // Within one day of the window (19 hours after its end) it is still shifted.
  const later = Date.UTC(2026, 10, 17, 0, 30, 0);
  assert.equal(rewriteClocks(String(later / 1000), clockWindow).text, String((later + SHIFT_MS) / 1000));
});
test('rewriteClocks leaves an epoch number more than a day from the window, out of range or not alone, as it is', () => {
  const far = Date.UTC(2026, 10, 12, 4, 21, 5) / 1000;
  const near = Date.UTC(2026, 10, 16, 4, 21, 5) / 1000;
  for (const text of [String(far), String(far * 1000), '1399999999', '2100000001', '9999999999', `x${near}`, `${near}x`, `r-${near}a`, `0.${near}`, `${near}0`, `${near}${near}`, '12345678901234', '123456789']) {
    const r = rewriteClocks(text, clockWindow);
    assert.equal(r.text, text, text);
    assert.equal(r.outOfRange, false, text);
  }
  // The same number at the edges of the range of a day: 1 ms after the day, not shifted; just inside it, shifted.
  const end = clockWindow.endMs;
  assert.equal(rewriteClocks(String(end + 86_400_001), clockWindow).text, String(end + 86_400_001));
  assert.equal(rewriteClocks(String(end + 86_400_000), clockWindow).text, String(end + 86_400_000 + SHIFT_MS));
});
test('rewriteClocks reads an ISO time with an offset as one instant and writes it in Z form', () => {
  // 12:26:44+08:00 and 22:56:44-05:30 (the day before) are both 04:26:44Z, a minute inside the window.
  assert.equal(rewriteClocks('2026-11-16T12:26:44+08:00', clockWindow).text, '2026-11-16T12:06:44Z');
  assert.equal(rewriteClocks('2026-11-16T12:26:44.123+08:00 done', clockWindow).text, '2026-11-16T12:06:44.123Z done');
  assert.equal(rewriteClocks('2026-11-15T22:56:44-05:30', clockWindow).outOfRange, false);
  assert.equal(rewriteClocks('2026-11-15T22:56:44-05:30', clockWindow).text, '2026-11-16T12:06:44Z');
  assert.equal(rewriteClocks('2026-11-16T04:26:44+00:00', clockWindow).text, '2026-11-16T12:06:44Z');
  // An offset of a time far from the window stops the build as any far clock does; the text is kept.
  const far = rewriteClocks('2026-11-16T22:00:00+08:00', clockWindow);
  assert.equal(far.outOfRange, true);
  assert.equal(far.text, '2026-11-16T22:00:00+08:00');
});
test('rewriteClocks never starts a clock inside an offset or a longer number, and leaves a far clock in prose as it is', () => {
  for (const text of ['at +08:00 only', 'zone -05:30 only', 'v1.2.3 and 3:1', '1.04:21 and 5:04:21', 'version 1.2.3, ratio 3:1']) {
    const r = rewriteClocks(text, clockWindow);
    assert.equal(r.text, text, text);
    assert.equal(r.outOfRange, false, text);
  }
  // A clock of prose that is far from the window is not moved; the build stops on it (`clock_out_of_range`).
  const prose = rewriteClocks('about 12:30 in prose', clockWindow);
  assert.equal(prose.text, 'about 12:30 in prose');
  assert.equal(prose.outOfRange, true);
});
test('rewriteClocks keeps a bare date of the incident day and of the day before as written', () => {
  assert.equal(rewriteClocks('on 2026-11-16, since 2026-11-15, not 2026-11-14', clockWindow).text, 'on 2026-11-16, since 2026-11-15, not 2026-11-14');
});
test('rewriteClocks reads a bare clock on the day of the window start, the day before or the day after, whichever is nearest', () => {
  const start = Date.UTC(2026, 10, 16, 23, 50, 0);
  const win = { startMs: start, endMs: start + 600_000 };
  // The window ends at midnight: 00:02 is read on the next day, 23:45 on the day of the start; the shift is -11 h 50 min.
  assert.equal(rewriteClocks('at 00:02 and 23:45', win).text, 'at 12:12 and 11:55');
});
test('a built replay keeps no epoch number or zone offset of the source window', () => {
  const rows = makeRows();
  // makeRows starts the window at 09:57:30 on 2026-11-15; the replay clock starts at 12:00:00.
  const t = Date.UTC(2026, 10, 15, 9, 58, 5);
  rows.hunt.fixHint = `job ${t / 1000} then ${t} then 2026-11-15T17:58:05+08:00 and 2026-11-15T09:58:05Z`;
  const file = build(rows);
  assert.equal(deps.validateReplayFile(file).ok, true);
  const hint = lastOf(file, 'hunt').fixHint;
  const shifted = t + (Date.UTC(2026, 10, 15, 12, 0, 0) - rows.window.startMs);
  assert.equal(hint, `job ${shifted / 1000} then ${shifted} then ${new Date(shifted).toISOString().slice(0, 19)}Z and ${new Date(shifted).toISOString().slice(0, 19)}Z`);
});
test('a built replay masks a code object with a host ending and keeps a code name', () => {
  const rows = makeRows();
  rows.hunt.fixHint = 'check (Promise.all), Array.from and app.corp, fs.internal and crypto.com';
  const hint = lastOf(build(rows), 'hunt').fixHint;
  assert.equal(hint, 'check (Promise.all), Array.from and [host], [host] and [host]');
});
test('the validator refuses an epoch number of another date and an ISO time with an offset, field path only', () => {
  const file = build();
  const hunt = file.frames.find((f) => f.hunt)?.hunt;
  assert.ok(hunt);
  const refuse = (text) => {
    hunt.fixHint = text;
    const r = deps.validateReplayFile(file);
    assert.equal(r.ok, false, text);
    assert.ok(r.errors.some((p) => p.endsWith('.hunt.fixHint')), text);
    assert.ok(!r.errors.join(' ').match(/\d{9}/), text);
  };
  const accept = (text) => {
    hunt.fixHint = text;
    assert.equal(deps.validateReplayFile(file).ok, true, text);
  };
  const sameDay = Date.UTC(2026, 10, 15, 12, 0, 1);
  const otherDay = Date.UTC(2026, 10, 16, 12, 0, 1);
  refuse(`at ${otherDay / 1000}`);
  refuse(`at ${otherDay}`);
  refuse('at 2026-11-15T12:00:01+08:00');
  refuse('at 2026-11-15T12:00:01-05:30');
  refuse('at 2026-11-15T12:00:01.5+01:00');
  accept(`at ${sameDay / 1000} and ${sameDay}`);
  accept('at 2026-11-15T12:00:01+00:00 and 2026-11-15T12:00:01Z');
  // Numbers outside the epoch ranges, longer numbers and ids are not epochs.
  accept('numbers 1399999999 and 2100000001 and 99999999999 and r-1a2b3c4d5e and 20261116');
});
test('rewriteClocks reads a clock just before midnight on the day before when that is nearer', () => {
  const start = Date.UTC(2026, 10, 16, 0, 10, 0);
  const r = rewriteClocks('since 23:50 and at 00:12', { startMs: start, endMs: start + 600_000 });
  assert.equal(r.text, 'since 11:40 and at 12:02');
  const iso = rewriteClocks('2026-11-15T23:50:00.000Z', { startMs: start, endMs: start + 600_000 });
  assert.equal(iso.text, '2026-11-16T11:40:00.000Z');
});
test('a built replay of the hunt strings has one clock: no clock of the source window, ISO dates equal recordedOn, base 12:00 UTC', () => {
  const rows = makeRows();
  // makeRows starts the window at 09:57:30 on 2026-11-15 (moved to 12:00:00, a shift of 2:02:30); these strings use that clock.
  rows.hunt.steps = [
    { index: 1, tool: 'search_errors', summary: 'errors orders since 09:57', at: at(45) },
    { index: 2, tool: 'recent_deploys', summary: 'deploys since 09:00', at: at(50) },
    { index: 3, tool: 'tail_logs', summary: '09:58:44 2026-11-15T09:58:44.885Z orders req POST /orders 200 1622ms rid=r-57a77f9c09504281', at: at(55) },
  ];
  rows.hunt.summary = 'The bad deploy landed (09:58:05Z), a ratio of 3:2 in prose.';
  rows.hunt.evidence = [{ order: 1, kind: 'deploy', ref: 'deploy:d-107', detail: 'd-107 orders scenario/fog 739d121 09:58:05', cited: true }];
  rows.hunt.fixHint = 'run the warehouse freshness checks in parallel (Promise.all)';
  const file = build(rows);
  assert.equal(deps.validateReplayFile(file).ok, true);
  const text = JSON.stringify(file);
  for (const clock of ['09:57', '09:00', '09:58', 'T09:']) assert.ok(!text.includes(clock), `${clock} of the source window is in the file`);
  for (const m of text.matchAll(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g)) assert.equal(m[0].slice(0, 10), file.recordedOn);
  const hunt = lastOf(file, 'hunt');
  assert.deepEqual(hunt.allSteps.map((s) => s.summary), [
    'errors orders since 11:59',
    'deploys since 11:02',
    '12:01:14 2026-11-15T12:01:14.885Z orders req POST /orders 200 1622ms rid=r-57a77f9c09504281',
  ]);
  assert.equal(hunt.diagnosis.summary, 'The bad deploy landed (12:00:35Z), a ratio of 3:2 in prose.');
  assert.equal(hunt.evidence[0].detail, 'd-107 orders scenario/fog 739d121 12:00:35');
  // A code name is not a host: it stays as written.
  assert.equal(hunt.fixHint, 'run the warehouse freshness checks in parallel (Promise.all)');
  assert.equal(hunt.queuedAt.slice(0, 13), '2026-11-15T12');
});
test('a clock far from the window stops the build with clock_out_of_range and the field path, never the value', () => {
  const rows = makeRows();
  rows.hunt.fixHint = 'the job ran at 18:30 yesterday';
  assert.throws(
    () => build(rows),
    (err) => err instanceof ReplayBuildError && err.code === 'clock_out_of_range' && err.paths.length > 0 && err.paths.every((p) => p.endsWith('.fixHint')) && !err.message.includes('18:30'),
  );
});
test('the validator refuses a full ISO time of another date in a string (foreign_date), field path only', () => {
  const file = build();
  const hunt = file.frames.find((f) => f.hunt)?.hunt;
  assert.ok(hunt);
  hunt.fixHint = 'seen at 2026-11-14T10:00:00Z';
  const r = deps.validateReplayFile(file);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((p) => p.endsWith('.hunt.fixHint')));
  assert.ok(!r.errors.join(' ').includes('2026-11-14'));
  hunt.fixHint = 'seen at 2026-11-15T12:00:01Z, also 04:21 and 3:2';
  assert.equal(deps.validateReplayFile(file).ok, true);
});
test('merges the polls of one second into one frame', () => {
  const rows = makeRows();
  rows.signals = rows.signals.flatMap((s) => [s, { ...s, at: new Date(s.at.getTime() + 300) }]);
  const merged = build(rows);
  assert.deepEqual(merged.frames.map((f) => f.t), build().frames.map((f) => f.t));
  assert.equal(new Set(merged.frames.map((f) => f.t)).size, merged.frames.length);
});
test('keeps at most 400 frames and 256 KiB, with the frames of the hunt and of the proposal', () => {
  const rows = makeRows();
  const signals = [];
  for (let s = -30; s < 870; s += 1) {
    for (const service of ['gate', 'payments']) signals.push({ service, kind: 'error_rate', value: 0.01 + (s % 7) / 1000, at: at(s) });
  }
  rows.signals = signals;
  rows.window = { startMs: at(-30).getTime(), endMs: at(870).getTime() };
  const file = build(rows);
  assert.ok(file.frames.length <= MAX_FRAMES, `${file.frames.length} frames`);
  assert.ok(file.frames.length >= 100);
  assert.ok(Buffer.byteLength(JSON.stringify(file)) <= 256 * 1024);
  assert.ok(file.frames.some((f) => f.hunt && f.hunt.status === 'succeeded'));
  assert.ok(file.frames.some((f) => f.proposal && f.proposal.status === 'deployed'));
  assert.ok(file.durationMs <= 900_000);
});
test('stops when the window is longer than 15 minutes', () => {
  const rows = makeRows();
  rows.window = { startMs: at(0).getTime(), endMs: at(901).getTime() };
  assert.throws(() => build(rows), (e) => e instanceof ReplayBuildError && e.code === 'window_too_long');
});
test('refuses a scenario that is not one of the three', () => {
  assert.throws(() => build(makeRows(), { ...OPTS, scenario: 'flood' }), (e) => e.code === 'bad_scenario');
});
test('the ids are fake, stable for one replay id and different for another', () => {
  const a = JSON.stringify(build());
  assert.equal(a, JSON.stringify(build()));
  for (const real of ['real-incident-id', 'real-hunt-id', 'real-proposal-id']) assert.ok(!a.includes(real));
  assert.notEqual(a, JSON.stringify(build(makeRows(), { ...OPTS, id: 'other-replay' })));
  const file = build();
  const hunt = lastOf(file, 'hunt');
  assert.match(hunt.id, /^r[0-9a-f]{24}$/);
  assert.equal(lastOf(file, 'proposal').huntId, hunt.id);
});
test('scrubs every kind of text a log can hold, in steps, evidence, summary, hint and stop detail', () => {
  const dirty = Object.values(PLANTED).join(' and ');
  const rows = makeRows({
    hunt: {
      summary: `Summary ${dirty}`,
      fixHint: `Hint ${dirty}`,
      stopDetail: `Stop ${dirty}`,
      steps: [{ index: 1, tool: 'tail_logs', summary: `Step ${dirty}`, at: at(45) }],
      evidence: [{ order: 1, kind: 'log', ref: `log:${PLANTED.longRun}`, detail: `Detail ${dirty}`, cited: true }],
    },
  });
  const text = JSON.stringify(build(rows));
  for (const [name, value] of Object.entries(PLANTED)) assert.ok(!text.includes(value), `${name} is still in the file`);
  assert.ok(text.includes('[email]'));
});
test('applies the rules of the pull request text: no markdown, HTML, link, mention or issue reference', () => {
  const rows = makeRows({ hunt: { summary: 'See [here](https://x.example/p) <b>bold</b> @someone #12 `code` ![img](https://x.example/i.png) done' } });
  const text = lastOf(build(rows), 'hunt').diagnosis.summary;
  assert.ok(text.length > 0);
  assert.ok(!/[<`]|\]\(|https?:/.test(text), text);
  assert.ok(!/@(?!\u200b)/.test(text));
  assert.ok(!/#\d/.test(text));
});
test('keeps no internal field; the login becomes "reviewer"; the PR link is the lab repository', () => {
  const rows = makeRows({ proposal: { aiFailDetail: `agent_failed: ${PLANTED.homePath}`, prUrl: 'https://github.com/other/repo/pull/7' } });
  const file = build(rows);
  const text = JSON.stringify(file);
  assert.ok(!text.includes('agent_failed'));
  assert.ok(!text.includes('some-person'));
  const last = lastOf(file, 'proposal');
  assert.equal(last.mergedBy, 'reviewer');
  assert.equal(last.aiFailDetail, null);
  assert.equal(last.prUrl, 'https://github.com/Akar-Samudra-Artifisial/Haunted-Lab/pull/7');
});
test('shows the status of the hunt and of the proposal as it was at each time', () => {
  const file = build();
  assert.deepEqual([...new Set(file.frames.flatMap((f) => (f.hunt ? [f.hunt.status] : [])))], ['queued', 'running', 'succeeded']);
  assert.deepEqual([...new Set(file.frames.flatMap((f) => (f.proposal ? [f.proposal.status] : [])))], ['drafting', 'open', 'merged', 'deployed']);
  assert.equal(file.frames.find((f) => f.proposal?.status === 'open').proposal.prNumber, 7);
  assert.equal(file.frames.find((f) => f.proposal?.status === 'drafting').proposal.prUrl, null);
});
test('builds the other endings: failed hunt, checks_failed, rejected, no hunt, no proposal', () => {
  const failed = build(makeRows({ hunt: { status: 'failed', endReason: 'timeout', culpritDeploy: null, culpritSha: null, culpritService: null, summary: null, fixHint: null }, noProposal: true }));
  assert.equal(lastOf(failed, 'hunt').status, 'failed');
  const cf = build(makeRows({ proposal: { status: 'checks_failed', failReason: 'checks_failed', prNumber: null, prUrl: null, openedAt: null, mergedAt: null, deployedAt: null, mergedBy: null } }));
  assert.equal(lastOf(cf, 'proposal').status, 'checks_failed');
  const rej = build(makeRows({ proposal: { status: 'rejected', mergedAt: null, deployedAt: null, mergedBy: null } }));
  assert.equal(lastOf(rej, 'proposal').status, 'rejected');
  const bare = build(makeRows({ noHunt: true, noProposal: true }));
  assert.equal(bare.frames[0].hunt, null);
  assert.equal(bare.frames[0].proposal, null);
});
test('stops with the field path and never the value when the result is not valid', () => {
  const rows = makeRows({ hunt: { model: `bad model ${PLANTED.longRun}!` } });
  assert.throws(
    () => build(rows),
    (e) => {
      assert.ok(e instanceof ReplayBuildError);
      assert.equal(e.code, 'invalid_replay');
      assert.ok(e.paths.some((p) => p.includes('.hunt.model')), e.message);
      assert.ok(!e.message.includes(PLANTED.longRun) && !e.message.includes('bad model'));
      return true;
    },
  );
});
test('writeReplay creates the folder, writes the file with a final newline and refuses to replace one', () => {
  const file = build();
  const out = join(dir, 'a', 'b');
  const path = writeReplay(file, out);
  assert.ok(path.endsWith('unit-replay.json'));
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), file);
  assert.ok(readFileSync(path, 'utf8').endsWith('\n'));
  assert.throws(() => writeReplay(file, out), (e) => e.code === 'file_exists');
});
test('readIncidentRows only reads: it calls find* and nothing else', async () => {
  const calls = [];
  const model = (name, rows) => new Proxy({}, { get: (_t, method) => async () => (calls.push(`${name}.${String(method)}`), rows) });
  const incident = { id: 'i', openedAt: at(30), closedAt: at(100), peakLevel: 2, service: { name: 'payments' } };
  const prisma = { incident: model('incident', incident), hunt: model('hunt', null), proposal: model('proposal', null), service: model('service', []), signal: model('signal', []) };
  const rows = await readIncidentRows(prisma, 'i');
  assert.equal(rows.incident.service, 'payments');
  assert.ok(calls.length > 0 && calls.every((c) => /\.find/.test(c)), calls.join(','));
  await assert.rejects(readIncidentRows({ ...prisma, incident: model('incident', null) }, 'x'), (e) => e.code === 'incident_not_found');
});
test('main: a usage error exits 2; a failure prints a code and never the database URL', async () => {
  const secretUrl = ['postgresql://user:', 'hunter2-secret', '@db.invalid:5432/x'].join('');
  const printed = [];
  const io = { out: (s) => printed.push(s), err: (s) => printed.push(s) };
  assert.equal(await main([], io), 2);
  const env = { DATABASE_URL: secretUrl };
  assert.equal(await main(['--bogus', 'x'], io, { env }), 2);
  assert.equal(await main(['--incident', 'i', '--id', 'unit-replay', '--scenario', 'error-spike', '--lead-s', '-1'], io, { env }), 2);
  // The URL is never an argument: the old option is a usage error, and no URL in the environment is one too.
  assert.equal(await main(['--database-url', secretUrl, '--incident', 'i', '--id', 'unit-replay', '--scenario', 'error-spike'], io, { env }), 2);
  assert.equal(await main(['--incident', 'i', '--id', 'unit-replay', '--scenario', 'error-spike'], io, { env: {} }), 2);
  assert.equal(await main(['--incident', 'i', '--id', 'unit-replay', '--scenario', 'error-spike'], io, { env: { DATABASE_URL: '' } }), 2);
  const failing = {
    env,
    loadDeps: async () => deps,
    createPrisma: () => ({ incident: { findUnique: async () => { throw new Error(`connect to ${secretUrl} failed`); } }, $disconnect: async () => {} }),
  };
  assert.equal(await main(['--incident', 'i', '--id', 'unit-replay', '--scenario', 'error-spike', '--out-dir', dir], io, failing), 1);
  const all = printed.join('');
  assert.ok(!all.includes('hunter2') && !all.includes('db.invalid'), all);
  assert.match(all, /replay build failed/);
});
test('main: reads through the seam and writes <id>.json under --out-dir with review null', async () => {
  const rows = makeRows();
  const prisma = {
    incident: { findUnique: async () => ({ id: 'real-incident-id', openedAt: rows.incident.openedAt, closedAt: rows.incident.closedAt, peakLevel: 2, service: { name: 'payments' } }) },
    hunt: { findFirst: async () => ({ ...rows.hunt, service: { name: 'payments' } }) },
    proposal: { findFirst: async () => rows.proposal },
    service: { findMany: async () => rows.services },
    signal: { findMany: async () => rows.signals.map((s) => ({ kind: s.kind, value: s.value, at: s.at, service: { name: s.service } })) },
    $disconnect: async () => {},
  };
  const printed = [];
  const outDir = join(dir, 'main-out');
  const argv = ['--incident', 'real-incident-id', '--id', 'main-replay', '--scenario', 'dark-room', '--title', 'Synthetic main', '--out-dir', outDir];
  const code = await main(argv, { out: (s) => printed.push(s), err: (s) => printed.push(s) }, { env: { DATABASE_URL: 'postgresql://x' }, loadDeps: async () => deps, createPrisma: (url) => (assert.equal(url, 'postgresql://x'), prisma) });
  assert.equal(code, 0, printed.join(''));
  assert.ok(existsSync(join(outDir, 'main-replay.json')));
  const file = JSON.parse(readFileSync(join(outDir, 'main-replay.json'), 'utf8'));
  assert.equal(file.review, null);
  assert.equal(file.scenario, 'dark-room');
  assert.equal(file.title, 'Synthetic main');
});
test('the committed synthetic file of the API tests is a valid, reviewed, synthetic file', () => {
  const path = fileURLToPath(new URL('../../apps/api/test/fixtures/replays/synthetic-error-spike.json', import.meta.url));
  const file = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(deps.validateReplayFile(file).ok, true);
  assert.match(file.title, /^Synthetic/);
  assert.notEqual(file.review, null);
  assert.ok(JSON.stringify(file).includes(SHA));
});
test('the database URL is read from the environment only: the option is gone from the usage and the source', () => {
  const source = readFileSync(fileURLToPath(new URL('./build-replay.mjs', import.meta.url)), 'utf8');
  assert.ok(!source.includes("'database-url'"));
  assert.ok(!/--database-url\s+</.test(source));
  const printed = [];
  return main([], { out: (s) => printed.push(s), err: (s) => printed.push(s) }, { env: {} }).then((code) => {
    assert.equal(code, 2);
    assert.match(printed.join(''), /DATABASE_URL/);
    assert.ok(!printed.join('').includes('--database-url'));
  });
});
test('scrubs again after the text rules: invisible characters cannot hide a token, a host or an address from the scrubber', () => {
  const zw = '\u200b';
  const hidden = [`${['gh', 'p_'].join('')}${zw}A1b2C3d4E5f6G7h8I9j0`, `ops${zw}@${zw}example.test`, `stag${zw}ing.example${zw}.com`, `from ${['10', '4', '7', '9'].join('.')}`.replace('.', `${zw}.`)];
  const rows = makeRows({ hunt: { summary: `Seen ${hidden.join(' and ')}`, fixHint: `Hint ${PLANTED.ipv6} ${PLANTED.bareHost} ${PLANTED.rootPath} ${zw}` } });
  const text = JSON.stringify(build(rows));
  for (const value of [PLANTED.token, PLANTED.email, 'staging.example.com', PLANTED.ip, PLANTED.ipv6, PLANTED.bareHost, PLANTED.rootPath]) assert.ok(!text.includes(value), `${value} is in the file`);
  assert.ok(!/\u200b/.test(text));
  assert.equal(deps.validateReplayFile(build(rows)).ok, true);
});
test('a run glued to a word after one colon is masked, and the new invisible characters are removed, so the file validates', () => {
  const invisible = ['\u061c', '\u2028', '\u2029', '\u2060', '\u2064', String.fromCodePoint(0xe0041), String.fromCodePoint(0xe007f)];
  const rows = makeRows({ hunt: { summary: `Seen addr:fe80::1 and ip:2001:db8::7 ${invisible.map((c) => `a${c}b`).join(' ')}`, fixHint: 'Hint' } });
  const file = build(rows);
  const text = JSON.stringify(file);
  assert.ok(!text.includes('fe80::1') && !text.includes('2001:db8::7'));
  assert.ok(text.includes('addr:[ip]') && text.includes('ip:[ip]'));
  for (const c of invisible) assert.ok(!text.includes(c), `U+${c.codePointAt(0).toString(16)} is in the file`);
  assert.equal(deps.validateReplayFile(file).ok, true);
});
test('the build must be current: a missing folder, a source newer than the build and a current build', () => {
  const root = join(dir, 'fresh');
  const dist = join(root, 'dist');
  const src = join(root, 'src');
  mkdirSync(join(dist, 'sub'), { recursive: true });
  mkdirSync(join(src, 'sub'), { recursive: true });
  const old = new Date(Date.now() - 60_000);
  writeFileSync(join(dist, 'sub', 'a.js'), 'x');
  writeFileSync(join(src, 'sub', 'a.ts'), 'x');
  utimesSync(join(src, 'sub', 'a.ts'), old, old);
  assert.doesNotThrow(() => assertBuildFresh('pkg', dist, src));
  // A source edited after the build.
  writeFileSync(join(src, 'b.ts'), 'x');
  utimesSync(join(dist, 'sub', 'a.js'), old, old);
  assert.throws(() => assertBuildFresh('pkg', dist, src), (e) => e instanceof ReplayBuildError && e.code === 'build_stale' && /pkg.*pnpm build/.test(e.message));
  // Tests and declarations are not sources of the build.
  rmSync(join(src, 'b.ts'));
  writeFileSync(join(src, 'b.test.ts'), 'x');
  writeFileSync(join(src, 'c.d.ts'), 'x');
  assert.doesNotThrow(() => assertBuildFresh('pkg', dist, src));
  assert.throws(() => assertBuildFresh('pkg', join(root, 'missing'), src), (e) => e.code === 'build_stale');
});
test('main stops with a clear message when the build is stale', async () => {
  const printed = [];
  const code = await main(['--incident', 'i', '--id', 'unit-replay', '--scenario', 'error-spike'], { out: (s) => printed.push(s), err: (s) => printed.push(s) }, {
    env: { DATABASE_URL: 'postgresql://x' },
    loadDeps: async () => assertBuildFresh('packages/shared', join(dir, 'nowhere'), join(dir, 'nowhere-src')),
  });
  assert.equal(code, 1);
  assert.match(printed.join(''), /build_stale: packages\/shared \(run "pnpm build" first\)/);
});
