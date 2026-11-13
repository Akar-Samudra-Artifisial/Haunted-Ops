import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EnvError, SCENARIOS, describeOthers, durationS, formatTable, judgeScenario, noOpenIncident, parseShas, readSettings, runGate } from './g2-hunt.mjs';

const TOKEN = 'tok-0123456789abcdef-secret';
const SHAS = {
  'error-spike': '65c0fca31d0df62c4bab40d2d854c81b1044c650',
  fog: '739d1217dc01c07adc69d38d53231d0dfab23b1f',
  'dark-room': '0b8dff146e2ddb3f9a7e5761ea63cfab9eb5e7aa',
};
const SETTINGS = { apiUrl: 'http://api.test', chaosUrl: 'http://chaos.test', token: TOKEN, shas: SHAS };
const CHAIN = ['gate', 'orders', 'payments', 'ledger'];
const START = '2026-11-13T10:00:00.000Z';

const ok = (scenario, service = scenario.service, over = {}) => ({
  service,
  startS: 3,
  lenS: 40,
  status: 'succeeded',
  reason: 'diagnosed',
  credits: 0.9,
  diagnosis: { culpritSha: SHAS[scenario.name], culpritService: scenario.service },
  ...over,
});
/** A Hunt that was withdrawn at once. */
const withdrawn = (service, reason, startS) => ({ service, startS, lenS: 0, status: 'cancelled', reason, credits: 0, diagnosis: null });

/**
 * A fake lab and API on a virtual clock. One fault opens an Incident in the root Service and in every
 * Service upstream of it (the lab is one call chain). `hunts(scenario)` lists the Hunts the API makes for
 * it: each is queued `startS` s after the scenario is applied and ends `lenS` s later. Incidents close
 * `closeAfterS` s after a reset.
 */
function fakeSystem({ hunts = (s) => [ok(s)], calm = true, closeAfterS = 35 } = {}) {
  let t = 0;
  let active = null;
  let resetAt = null;
  const calls = [];
  const idOf = (i) => `cmhunt${String(i).padStart(19, '0')}`;
  const isRoot = (name) => active && active.scenario.service === name;
  const upstream = (name) => active && CHAIN.indexOf(name) < CHAIN.indexOf(active.scenario.service);
  const faulty = () => active !== null && (resetAt === null || t - resetAt < closeAfterS * 1000);
  const queuedAt = (h) => active.at + h.startS * 1000;
  const endsAt = (h) => queuedAt(h) + h.lenS * 1000;
  const statusOf = (h) => (t >= endsAt(h) ? h.status : 'running');
  const summaryOf = (h, i) => ({ id: idOf(i), service: h.service, incidentId: `cminc${h.service}aaaaaaaaaaaaaaaaaa`.slice(0, 25), status: statusOf(h), queuedAt: new Date(queuedAt(h)).toISOString() });
  const state = (name) => {
    const base = { name, hauntLevel: 0, reason: null, openIncident: null, hunt: null };
    if (!calm && active === null) return { ...base, hauntLevel: 2 };
    if (faulty() && (isRoot(name) || upstream(name))) {
      const mine = active.hunts.map((h, i) => [h, i]).filter(([h]) => h.service === name && t >= queuedAt(h));
      const latest = mine.sort((a, b) => queuedAt(b[0]) - queuedAt(a[0]))[0];
      return {
        ...base,
        hauntLevel: resetAt === null ? 3 : 0,
        reason: resetAt === null ? { kind: active.scenario.reason, value: 1 } : null,
        openIncident: { id: `cminc${name}aaaaaaaaaaaaaaaaaa`.slice(0, 25), openedAt: 'x', peakLevel: 3 },
        hunt: latest ? summaryOf(latest[0], latest[1]) : null,
      };
    }
    return base;
  };
  const fetch = async (url, init = {}) => {
    calls.push({ url, init });
    const respond = (status, body) => ({ ok: status < 300, status, json: async () => body });
    if (url === 'http://api.test/api/services') return respond(200, CHAIN.map(state));
    const m = /^http:\/\/api\.test\/api\/hunts\/cmhunt(\d+)$/.exec(url);
    if (m && active) {
      const i = Number(m[1]);
      const h = active.hunts[i];
      if (!h) return respond(404, {});
      const started = new Date(Date.parse(START) + 1000 * i).toISOString();
      const ended = t >= endsAt(h);
      return respond(200, {
        id: idOf(i),
        service: h.service,
        status: statusOf(h),
        reason: ended ? h.reason : null,
        credits: ended ? h.credits : 0.3,
        startedAt: h.lenS === 0 ? null : started,
        finishedAt: ended ? new Date(Date.parse(started) + h.lenS * 1000).toISOString() : null,
        diagnosis: ended ? h.diagnosis : null,
      });
    }
    const apply = /^http:\/\/chaos\.test\/chaos\/scenarios\/([a-z-]+)\/apply$/.exec(url);
    if (apply) {
      const scenario = SCENARIOS.find((s) => s.name === apply[1]);
      active = { scenario, at: t, hunts: hunts(scenario) };
      resetAt = null;
      return respond(200, {});
    }
    if (url === 'http://chaos.test/chaos/reset') {
      resetAt = t;
      return respond(200, {});
    }
    return respond(404, {});
  };
  const io = {
    fetch,
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    log: () => {},
  };
  return { io, calls, clock: () => t };
}

test('readSettings needs the token and the planted SHAs, and names the variable only', () => {
  const text = JSON.stringify({ base: 'x', shas: SHAS });
  assert.throws(() => readSettings({}, () => text), (e) => e instanceof EnvError && e.variable === 'CHAOS_TOKEN');
  assert.throws(() => readSettings({ CHAOS_TOKEN: TOKEN }, () => '{ nope'), (e) => e instanceof EnvError && e.variable === 'SCENARIO_SHAS');
  assert.throws(() => readSettings({ CHAOS_TOKEN: TOKEN }, () => JSON.stringify({ shas: { 'error-spike': 'abc' } })), (e) => e instanceof EnvError && e.variable === 'SCENARIO_SHAS');
  const good = readSettings({ CHAOS_TOKEN: TOKEN, SCENARIO_SHAS: '/x/shas.json', HUNT_COOLDOWN_S: '5' }, (p) => {
    assert.equal(p, '/x/shas.json');
    return text;
  });
  assert.deepEqual(good.shas, SHAS);
  assert.equal(good.cooldownS, 5);
  assert.equal(readSettings({ CHAOS_TOKEN: TOKEN, HUNT_COOLDOWN_S: '-3' }, () => text).cooldownS, 0);
  assert.deepEqual(parseShas(text), SHAS);
});

test('judgeScenario: exactly one success with the planted commit and the root Service, and no failure', () => {
  const win = { id: 'a', service: 'payments', status: 'succeeded', diagnosis: { culpritSha: SHAS.fog, culpritService: 'orders' } };
  const gone = { id: 'b', service: 'orders', status: 'cancelled', reason: 'diagnosed_upstream' };
  // Whichever Service was hunted: payments diagnosed the fault that is in orders.
  assert.deepEqual(judgeScenario([win], SHAS.fog, 'orders'), { pass: true, text: 'PASS', match: 'yes', hunt: win });
  assert.equal(judgeScenario([gone, win], SHAS.fog, 'orders').pass, true);
  assert.equal(judgeScenario([win], SHAS['error-spike'], 'orders').text, 'FAIL (wrong commit)');
  assert.equal(judgeScenario([win], SHAS.fog, 'payments').text, 'FAIL (wrong service)');
  assert.equal(judgeScenario([], SHAS.fog, 'orders').text, 'FAIL (no hunt)');
  assert.equal(judgeScenario([gone], SHAS.fog, 'orders').text, 'FAIL (no hunt succeeded)');
  assert.equal(judgeScenario([win, { ...win, id: 'c' }], SHAS.fog, 'orders').text, 'FAIL (2 hunts succeeded)');
  const failed = { id: 'd', service: 'ledger', status: 'failed', reason: 'foreign_tool' };
  assert.equal(judgeScenario([win, failed], SHAS.fog, 'orders').text, 'FAIL (failed ledger:foreign_tool)');
  assert.equal(judgeScenario([win, failed], SHAS.fog, 'orders').pass, false);
  assert.equal(judgeScenario([{ id: 'e', service: 'orders', status: 'running' }], SHAS.fog, 'orders').pass, false);
});

test('describeOthers, durationS, noOpenIncident and the table are plain', () => {
  const win = { service: 'payments', status: 'succeeded' };
  const gone = { service: 'ledger', status: 'cancelled', reason: 'diagnosed_upstream' };
  assert.equal(describeOthers([win], win), '0');
  assert.equal(describeOthers([win, gone], win), '1 (ledger:diagnosed_upstream)');
  assert.equal(durationS('2026-11-13T10:00:00Z', '2026-11-13T10:00:59Z'), 59);
  assert.equal(durationS('x', 'y'), null);
  assert.equal(noOpenIncident(CHAIN.map((name) => ({ name, openIncident: null }))), true);
  assert.equal(noOpenIncident(CHAIN.map((name) => ({ name, openIncident: name === 'gate' ? { id: 'i' } : null }))), false);
  const table = formatTable([{ scenario: 'dark-room', service: 'payments', status: 'succeeded', match: 'yes', culpritService: 'ledger', others: '1 (ledger:diagnosed_upstream)', credits: '0.89', duration: '41.0', result: 'PASS' }]);
  assert.match(table, /^scenario\s+hunted\s+status\s+sha match\s+culprit in\s+other hunts\s+credits\s+duration s\s+result$/m);
  assert.match(table, /dark-room\s+payments\s+succeeded\s+yes\s+ledger\s+1 \(ledger:diagnosed_upstream\)\s+0\.89\s+41\.0\s+PASS/);
});

test('passes when the root Service is hunted alone', async () => {
  const sys = fakeSystem();
  const { rows, pass } = await runGate(SETTINGS, sys.io);
  assert.equal(pass, true);
  assert.deepEqual(rows.map((r) => r.result), ['PASS', 'PASS', 'PASS']);
  assert.deepEqual(rows.map((r) => r.service), ['payments', 'orders', 'ledger']);
  assert.deepEqual(rows.map((r) => r.culpritService), ['payments', 'orders', 'ledger']);
  assert.deepEqual(rows.map((r) => r.others), ['0', '0', '0']);
  assert.deepEqual(rows.map((r) => r.credits), ['0.90', '0.90', '0.90']);
  assert.deepEqual(rows.map((r) => r.duration), ['40.0', '40.0', '40.0']);
  assert.equal(sys.calls.filter((c) => c.url.endsWith('/chaos/reset')).length, 3 + 1);
});

test('passes when an upstream Hunt diagnoses the root and the root Hunt is withdrawn (the second live run)', async () => {
  // dark-room: payments is hunted, names the deploy of ledger; the ledger Hunt is withdrawn as diagnosed_upstream.
  const sys = fakeSystem({
    hunts: (s) => (s.name === 'dark-room' ? [ok(s, 'payments', { startS: 11 }), withdrawn('ledger', 'diagnosed_upstream', 16)] : [ok(s)]),
  });
  const { rows, pass } = await runGate(SETTINGS, sys.io);
  assert.equal(pass, true);
  assert.equal(rows[2].service, 'payments');
  assert.equal(rows[2].culpritService, 'ledger');
  assert.equal(rows[2].others, '1 (ledger:diagnosed_upstream)');
  assert.equal(rows[2].result, 'PASS');
  assert.equal(rows[2].credits, '0.90');
});

test('waits for a late Hunt after the first one ended, and fails when it failed', async () => {
  // The ledger Hunt starts 12 s after the payments Hunt ended and fails: the quiet period catches it.
  const late = fakeSystem({
    hunts: (s) => (s.name === 'dark-room' ? [ok(s, 'payments', { startS: 3, lenS: 20 }), { service: 'ledger', startS: 32, lenS: 5, status: 'failed', reason: 'foreign_tool', credits: 0, diagnosis: null }] : [ok(s)]),
  });
  const { rows, pass } = await runGate(SETTINGS, late.io);
  assert.equal(pass, false);
  assert.deepEqual(rows.map((r) => r.result), ['PASS', 'PASS', 'FAIL (failed ledger:foreign_tool)']);
  assert.equal(rows[2].others, '1 (ledger:foreign_tool)');
});

test('fails on two successes, a wrong commit, a wrong service, a failed hunt and no hunt, and still resets', async () => {
  const twice = fakeSystem({ hunts: (s) => (s.name === 'fog' ? [ok(s), ok(s, 'gate', { startS: 5 })] : [ok(s)]) });
  const a = await runGate(SETTINGS, twice.io);
  assert.deepEqual(a.rows.map((r) => r.result), ['PASS', 'FAIL (2 hunts succeeded)', 'PASS']);
  const sha = fakeSystem({ hunts: (s) => [ok(s, s.service, { diagnosis: { culpritSha: s.name === 'fog' ? SHAS['error-spike'] : SHAS[s.name], culpritService: s.service } })] });
  const b = await runGate(SETTINGS, sha.io);
  assert.deepEqual(b.rows.map((r) => r.result), ['PASS', 'FAIL (wrong commit)', 'PASS']);
  const svc = fakeSystem({ hunts: (s) => [ok(s, s.service, { diagnosis: { culpritSha: SHAS[s.name], culpritService: s.name === 'fog' ? 'gate' : s.service } })] });
  const c = await runGate(SETTINGS, svc.io);
  assert.deepEqual(c.rows.map((r) => r.result), ['PASS', 'FAIL (wrong service)', 'PASS']);
  const failed = fakeSystem({ hunts: (s) => [ok(s, s.service, { status: 'failed', reason: 'credit_cap', credits: 1.6, diagnosis: null })] });
  const d = await runGate(SETTINGS, failed.io);
  assert.equal(d.pass, false);
  assert.equal(d.rows[0].result, 'FAIL (failed payments:credit_cap)');
  assert.ok(d.calls === undefined && failed.calls.some((x) => x.url.endsWith('/chaos/reset')));
  const none = fakeSystem({ hunts: () => [] });
  const e = await runGate(SETTINGS, none.io);
  assert.equal(e.pass, false);
  assert.equal(e.rows[0].result, 'FAIL (no result in 180 s)');
  assert.ok(none.clock() >= 180_000);
});

test('does not call a scenario passed while a hunt is still running at the deadline', async () => {
  const slow = fakeSystem({ hunts: (s) => [ok(s), { service: 'gate', startS: 4, lenS: 900, status: 'cancelled', reason: 'busy', credits: 0, diagnosis: null }] });
  const { rows, pass } = await runGate(SETTINGS, slow.io);
  assert.equal(pass, false);
  assert.match(rows[0].result, /^FAIL \(hunts did not settle in 180 s\)$/);
});

test('waits for every Incident to close before the next scenario, and gives up after 120 s', async () => {
  const slow = fakeSystem({ closeAfterS: 90 });
  assert.equal((await runGate(SETTINGS, slow.io)).pass, true);
  const stuck = fakeSystem({ closeAfterS: 500 });
  const { rows, pass } = await runGate(SETTINGS, stuck.io);
  assert.equal(pass, false);
  assert.equal(rows.length, 1); // it stops: the next scenario would join the cascade
  assert.equal(rows[0].result, 'FAIL (incidents did not close)');
  assert.ok(stuck.calls.some((c) => c.url.endsWith('/chaos/reset')));
});

test('fails without applying anything when the baseline is never calm', async () => {
  const sys = fakeSystem({ calm: false });
  const { rows, pass } = await runGate(SETTINGS, sys.io);
  assert.equal(pass, false);
  assert.equal(rows[0].scenario, 'baseline');
  assert.equal(sys.calls.filter((c) => c.url.includes('/apply')).length, 0);
});

test('sends the token only to the chaos URL and never prints it', async () => {
  const sys = fakeSystem();
  const { rows } = await runGate(SETTINGS, sys.io);
  for (const c of sys.calls) {
    const auth = c.init?.headers?.authorization;
    if (auth !== undefined) assert.ok(c.url.startsWith('http://chaos.test/'), c.url);
  }
  assert.equal(formatTable(rows).includes(TOKEN), false);
});

test('stops when the signal aborts and still sends the final reset', async () => {
  const sys = fakeSystem();
  const abort = new AbortController();
  const io = { ...sys.io, sleep: async (ms) => { await sys.io.sleep(ms); abort.abort(); } };
  const { pass } = await runGate(SETTINGS, io, abort.signal);
  assert.equal(pass, false);
  assert.ok(sys.calls.some((c) => c.url.endsWith('/chaos/reset')));
});
