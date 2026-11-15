import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_MERGE_WAIT_MS, EnvError, checksText, formatTable, huntsSince, judgePhase, readSettings, runGate, secs, streamFile, trackedProposal } from './gmvp-fix.mjs';

const TOKEN = 'tok-0123456789abcdef-secret';
const API = 'http://api.test';
const CHAOS = 'http://chaos.test';
const SETTINGS = { apiUrl: API, chaosUrl: CHAOS, token: TOKEN, scenario: { name: 'error-spike', service: 'payments', reason: 'error_rate', minLevel: 2 }, mergeWaitMs: 900_000, huntWorkdir: '/work/hunts' };
const HUNT = 'cmhunt0000000000000000001';
const PROPOSAL = 'cmprop0000000000000000001';
const PR_URL = 'https://github.com/owner/repo/pull/7';
const T0 = Date.parse('2026-11-14T10:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

test('readSettings: defaults, overrides and errors that name variables only', () => {
  const d = readSettings({ CHAOS_TOKEN: TOKEN });
  assert.equal(d.apiUrl, 'http://127.0.0.1:3100');
  assert.equal(d.chaosUrl, 'http://127.0.0.1:4100');
  assert.equal(d.scenario.name, 'error-spike');
  assert.equal(d.mergeWaitMs, DEFAULT_MERGE_WAIT_MS);
  assert.equal(DEFAULT_MERGE_WAIT_MS, 900_000);
  const o = readSettings({ CHAOS_TOKEN: TOKEN, API_URL: 'http://a:1/', CHAOS_URL: 'http://c:2//', SCENARIO: 'fog', MERGE_WAIT_MS: '5000', HUNT_WORKDIR: '/w' });
  assert.deepEqual([o.apiUrl, o.chaosUrl, o.scenario.name, o.mergeWaitMs, o.huntWorkdir], ['http://a:1', 'http://c:2', 'fog', 5000, '/w']);
  for (const [env, name] of [
    [{}, 'CHAOS_TOKEN'],
    [{ CHAOS_TOKEN: ' ' }, 'CHAOS_TOKEN'],
    [{ CHAOS_TOKEN: TOKEN, SCENARIO: 'nope' }, 'SCENARIO'],
    [{ CHAOS_TOKEN: TOKEN, MERGE_WAIT_MS: 'soon' }, 'MERGE_WAIT_MS'],
    [{ CHAOS_TOKEN: TOKEN, MERGE_WAIT_MS: '10' }, 'MERGE_WAIT_MS'],
    [{ CHAOS_TOKEN: TOKEN, MERGE_WAIT_MS: '99999999' }, 'MERGE_WAIT_MS'],
  ]) {
    assert.throws(() => readSettings(env), (err) => err instanceof EnvError && err.variable === name && !err.message.includes(TOKEN));
  }
});

const service = (name, over = {}) => ({ name, hauntLevel: 0, reason: null, openIncident: null, hunt: null, proposal: null, ...over });
const hunt = (over = {}) => ({ id: HUNT, status: 'succeeded', reason: 'diagnosed', queuedAt: iso(T0 + 1000), startedAt: iso(T0 + 2000), finishedAt: iso(T0 + 40_000), credits: 0.9, ...over });
const proposal = (over = {}) => ({ id: PROPOSAL, huntId: HUNT, attempt: 1, kind: 'ai_patch', status: 'open', prNumber: 7, prUrl: PR_URL, mergedBy: null, checks: [], failReason: null, aiFailReason: null, updatedAt: iso(T0 + 80_000), ...over });
const four = (payments) => ['gate', 'orders', 'payments', 'ledger'].map((n) => (n === 'payments' ? payments : service(n)));

test('judgePhase follows the Proposal status and ends on the failing ones', () => {
  assert.equal(judgePhase(four(service('payments')), T0).phase, 'waiting');
  assert.equal(judgePhase(four(service('payments', { hunt: hunt({ status: 'running' }) })), T0).phase, 'waiting');
  for (const status of ['drafting', 'open', 'merged', 'deployed']) {
    assert.equal(judgePhase(four(service('payments', { hunt: hunt(), proposal: proposal({ status }) })), T0).phase, status);
  }
  for (const status of ['checks_failed', 'rejected', 'failed']) {
    const got = judgePhase(four(service('payments', { hunt: hunt(), proposal: proposal({ status, failReason: status === 'failed' ? 'deploy_rejected' : null }) })), T0);
    assert.equal(got.phase, 'failed');
    assert.match(got.reason, new RegExp(`proposal ${status}`));
  }
  const failedHunt = judgePhase(four(service('payments', { hunt: hunt({ status: 'failed', reason: 'timeout' }) })), T0);
  assert.deepEqual([failedHunt.phase, failedHunt.reason], ['failed', 'hunt failed (payments:timeout)']);
});

test('hunts and proposals from before the scenario are ignored (with the clock skew allowance)', () => {
  const old = service('payments', { hunt: hunt({ queuedAt: iso(T0 - 60_000) }), proposal: proposal() });
  assert.equal(trackedProposal(four(old), T0), null);
  assert.equal(huntsSince(four(old), T0).length, 0);
  assert.equal(huntsSince(four(service('payments', { hunt: hunt({ queuedAt: iso(T0 - 1000) }) })), T0).length, 1);
  // A Proposal that belongs to another Hunt than the Service shows is not tracked.
  assert.equal(trackedProposal(four(service('payments', { hunt: hunt(), proposal: proposal({ huntId: 'cmother000000000000000001' }) })), T0), null);
});

test('table helpers', () => {
  assert.equal(checksText([]), '-');
  assert.equal(checksText([{ name: 'scope', ok: true }, { name: 'size', ok: false }, { name: 'tests', ok: false }]), '1/3 ok (failed: size, tests)');
  assert.equal(secs(12.345), '12.3');
  assert.equal(secs(null), '-');
  assert.equal(streamFile('/w', HUNT), `/w/${HUNT}.stream.jsonl`);
  const table = formatTable([{ scenario: 'error-spike', kind: 'ai_patch', checks: '6/6 ok', pr: '#7', mergedBy: 'jane', credits: '1.80', huntS: '38.0', draftS: '40.0', mergeWaitS: '90.0', deployS: '45.0', result: 'PASS' }]);
  const lines = table.split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^scenario\s+kind\s+checks\s+pull request\s+merged by\s+credits/);
  assert.match(lines[2], /error-spike\s+ai_patch\s+6\/6 ok\s+#7\s+jane\s+1\.80.*PASS$/);
});

/**
 * A fake lab and API on a virtual clock. After the scenario is applied (t = 0): the Hunt runs until +40 s, the
 * Proposal is drafting from +45 s and open from +80 s with a pull request; a person merges at `mergeAt` (never,
 * when null); the merge is `deployed` 30 s later and the Incidents close 20 s after that. A reset ends the fault.
 */
function fakeSystem({ mergeAt = 200, finalStatus = null, calm = true } = {}) {
  let t = 0;
  let applied = null;
  const calls = [];
  const sec = () => (applied === null ? -1 : (t - applied) / 1000);
  const merged = () => mergeAt !== null && sec() >= mergeAt;
  const status = () => {
    if (finalStatus !== null && sec() >= 80) return finalStatus;
    if (sec() < 45) return null;
    if (sec() < 80) return 'drafting';
    if (!merged()) return 'open';
    if (sec() < mergeAt + 30) return 'merged';
    return 'deployed';
  };
  const incidentsOpen = () => applied !== null && !(status() === 'deployed' && sec() >= mergeAt + 50);
  const services = () => {
    if (!calm && applied === null) return four(service('payments', { hauntLevel: 2 }));
    if (applied === null) return four(service('payments'));
    const incident = incidentsOpen() ? { id: 'inc', openedAt: 'x', peakLevel: 3 } : null;
    const h = sec() >= 3 ? hunt({ queuedAt: iso(T0 + applied + 3000), startedAt: iso(T0 + applied + 4000), finishedAt: iso(T0 + applied + 40_000), status: sec() < 40 ? 'running' : 'succeeded' }) : null;
    const st = status();
    const p = h && st ? proposal({ status: st, prUrl: st === 'drafting' ? null : PR_URL, prNumber: st === 'drafting' ? null : 7, updatedAt: iso(T0 + applied + sec() * 1000) }) : null;
    return ['gate', 'orders', 'payments', 'ledger'].map((n) => (n === 'payments' ? service(n, { hauntLevel: 3, openIncident: incident, hunt: h, proposal: p }) : service(n, { hauntLevel: incident ? 1 : 0, openIncident: incident ? { id: `inc-${n}`, openedAt: 'x', peakLevel: 1 } : null })));
  };
  const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
  const doFetch = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    calls.push({ url, method, auth: init.headers?.authorization ?? null });
    if (url.startsWith(CHAOS)) {
      if (url.endsWith('/apply')) applied = t;
      if (url.endsWith('/chaos/reset')) applied = applied === null ? null : applied;
      return json({});
    }
    if (url === `${API}/api/services`) return json(services());
    if (url === `${API}/api/proposals/${PROPOSAL}`) {
      return json({ ...proposal({ status: 'deployed', mergedBy: 'jane', checks: [{ name: 'scope', ok: true }, { name: 'tests', ok: true }] }), credits: 0.9, creditsEstimated: false, service: 'payments', createdAt: iso(T0 + applied + 45_000), openedAt: iso(T0 + applied + 80_000), mergedAt: iso(T0 + applied + mergeAt * 1000), deployedAt: iso(T0 + applied + (mergeAt + 30) * 1000) });
    }
    if (url === `${API}/api/hunts/${HUNT}`) return json({ credits: 0.9 });
    return json({}, 404);
  };
  return {
    calls,
    io: (signalAt = null, controller = null) => {
      const prints = [];
      const logs = [];
      return {
        prints,
        logs,
        fetch: doFetch,
        now: () => T0 + t,
        sleep: async (ms) => {
          t += ms;
          if (signalAt !== null && sec() >= signalAt) controller?.abort();
        },
        log: (m) => logs.push(m),
        print: (m) => prints.push(m),
      };
    },
    resets: () => calls.filter((c) => c.url === `${CHAOS}/chaos/reset`).length,
    begin: () => {
      t = 0;
    },
  };
}

function expectSafeCalls(calls) {
  for (const c of calls) {
    if (c.url.startsWith(CHAOS)) {
      assert.equal(c.method, 'POST');
      assert.equal(c.auth, `Bearer ${TOKEN}`);
      assert.match(c.url, /^http:\/\/chaos\.test\/chaos\/(?:scenarios\/[a-z-]+\/apply|reset)$/);
    } else {
      // The API gets GET only and never a token: nothing here can merge, close or edit anything.
      assert.equal(c.method, 'GET', c.url);
      assert.equal(c.auth, null, c.url);
      assert.ok(c.url.startsWith(`${API}/api/`), c.url);
    }
  }
}

test('a human merge: PASS, prints the URL on its own line, the hunt id and the stream path, resets once at the end', async () => {
  const sys = fakeSystem({ mergeAt: 200 });
  const io = sys.io();
  const { rows, pass } = await runGate(SETTINGS, io);
  assert.equal(pass, true);
  assert.equal(rows[0].result, 'PASS');
  assert.deepEqual([rows[0].kind, rows[0].pr, rows[0].mergedBy, rows[0].credits, rows[0].checks], ['ai_patch', '#7', 'jane', '1.80', '2/2 ok']);
  assert.ok(io.prints.includes(PR_URL), 'the URL is a line of its own');
  assert.ok(io.prints.includes(`hunt id: ${HUNT}`));
  assert.ok(io.prints.includes(`stream file: /work/hunts/${HUNT}.stream.jsonl`));
  assert.equal(sys.resets(), 1);
  assert.equal(sys.calls.at(-1).url, `${CHAOS}/chaos/reset`);
  expectSafeCalls(sys.calls);
  const everything = [...io.prints, ...io.logs, formatTable(rows)].join('\n');
  assert.ok(!everything.includes(TOKEN));
});

test('the chaos token is sent only to the chaos URL', async () => {
  const sys = fakeSystem({ mergeAt: 200 });
  await runGate(SETTINGS, sys.io());
  const withAuth = sys.calls.filter((c) => c.auth !== null);
  assert.ok(withAuth.length >= 2);
  assert.ok(withAuth.every((c) => c.url.startsWith(CHAOS)));
  assert.ok(sys.calls.filter((c) => c.url.startsWith(API)).every((c) => c.auth === null));
});

test('nobody merges: the gate fails after MERGE_WAIT_MS, never merges, and resets', async () => {
  const sys = fakeSystem({ mergeAt: null });
  const io = sys.io();
  const { rows, pass } = await runGate({ ...SETTINGS, mergeWaitMs: 60_000 }, io);
  assert.equal(pass, false);
  assert.equal(rows[0].result, 'FAIL (not merged within 1 min)');
  assert.equal(sys.resets(), 1);
  expectSafeCalls(sys.calls);
});

test('Ctrl-C while waiting for the merge: FAIL (interrupted) and the lab is reset', async () => {
  const sys = fakeSystem({ mergeAt: null });
  const controller = new AbortController();
  const { rows, pass } = await runGate(SETTINGS, sys.io(120, controller), controller.signal);
  assert.equal(pass, false);
  assert.equal(rows[0].result, 'FAIL (interrupted)');
  assert.equal(sys.resets(), 1);
});

test('a Proposal that ends checks_failed fails the gate and resets', async () => {
  const sys = fakeSystem({ finalStatus: 'checks_failed' });
  const { rows, pass } = await runGate(SETTINGS, sys.io());
  assert.equal(pass, false);
  assert.equal(rows[0].result, 'FAIL (proposal checks_failed)');
  assert.equal(sys.resets(), 1);
});

test('a lab that is not calm fails before the scenario is applied, and still resets', async () => {
  const sys = fakeSystem({ calm: false });
  const { rows, pass } = await runGate(SETTINGS, sys.io());
  assert.equal(pass, false);
  assert.equal(rows[0].result, 'FAIL (not calm)');
  assert.ok(!sys.calls.some((c) => c.url.endsWith('/apply')));
  assert.equal(sys.resets(), 1);
});

test('a chaos apply that is refused fails the gate and resets', async () => {
  const sys = fakeSystem();
  const io = sys.io();
  const inner = io.fetch;
  io.fetch = async (url, init) => (url.endsWith('/apply') ? { ok: false, status: 401, json: async () => ({}) } : inner(url, init));
  const { rows } = await runGate(SETTINGS, io);
  assert.equal(rows[0].result, 'FAIL (POST /chaos/scenarios/error-spike/apply answered 401)');
  assert.ok(!rows[0].result.includes(TOKEN));
});
