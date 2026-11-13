import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EnvError, SCENARIOS, formatTable, readEnv, runCheck } from './g1-score.mjs';

const TOKEN = 'tok-0123456789abcdef-secret';
const SETTINGS = { apiUrl: 'http://api.test', chaosUrl: 'http://chaos.test', token: TOKEN };

/** A fake lab and API on a virtual clock. `reasonFor` lets a test change what the API reports. */
function fakeLab({ detectAfterS = 12, recoverAfterS = 70, reasonFor = (s) => s.reason, calm = true, applyStatus = 200 } = {}) {
  let t = 0;
  let active = null; // { scenario, at }
  let resetAt = null;
  const calls = [];
  const state = (name) => {
    const base = { name, hauntLevel: 0, reason: null, openIncident: null };
    if (!calm && active === null) return { ...base, hauntLevel: 2, reason: { kind: 'p95', value: 1500 } };
    if (active && active.scenario.service === name && t - active.at >= detectAfterS * 1000 && resetAt === null) {
      return {
        ...base,
        hauntLevel: active.scenario.minLevel,
        reason: { kind: reasonFor(active.scenario), value: 1 },
        openIncident: { id: 'i', openedAt: 'x', peakLevel: active.scenario.minLevel },
      };
    }
    if (active && active.scenario.service === name && resetAt !== null && t - resetAt < recoverAfterS * 1000) {
      return { ...base, hauntLevel: 2, reason: { kind: reasonFor(active.scenario), value: 1 } };
    }
    return base;
  };
  const fetch = async (url, init = {}) => {
    calls.push({ url, init });
    const respond = (status, body) => ({ ok: status < 300, status, json: async () => body });
    if (url === 'http://api.test/api/services') return respond(200, ['gate', 'orders', 'payments', 'ledger'].map(state));
    const apply = /^http:\/\/chaos\.test\/chaos\/scenarios\/([a-z-]+)\/apply$/.exec(url);
    if (apply) {
      if (applyStatus !== 200) return respond(applyStatus, {});
      active = { scenario: SCENARIOS.find((s) => s.name === apply[1]), at: t };
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

const resets = (calls) => calls.filter((c) => c.url.endsWith('/chaos/reset')).length;

test('readEnv names CHAOS_TOKEN when it is missing and never echoes a value', () => {
  for (const env of [{}, { CHAOS_TOKEN: '' }, { CHAOS_TOKEN: '   ' }]) {
    assert.throws(() => readEnv(env), (err) => err instanceof EnvError && err.variable === 'CHAOS_TOKEN');
  }
  const cfg = readEnv({ CHAOS_TOKEN: TOKEN, API_URL: 'http://a.test/', CHAOS_URL: 'http://c.test//' });
  assert.deepEqual(cfg, { apiUrl: 'http://a.test', chaosUrl: 'http://c.test', token: TOKEN });
  assert.equal(readEnv({ CHAOS_TOKEN: 'x' }).apiUrl, 'http://127.0.0.1:3000');
  assert.equal(readEnv({ CHAOS_TOKEN: 'x' }).chaosUrl, 'http://127.0.0.1:4100');
});

test('passes when every scenario is detected with the right reason and then recovers', async () => {
  const lab = fakeLab();
  const { rows, pass } = await runCheck(SETTINGS, lab.io);
  assert.equal(pass, true);
  assert.deepEqual(rows.map((r) => r.result), ['PASS', 'PASS', 'PASS']);
  assert.deepEqual(rows.map((r) => r.reason), ['error_rate', 'p95', 'down']);
  assert.ok(Number(rows[0].detectS) >= 12 && Number(rows[0].detectS) <= 14);
  assert.ok(Number(rows[0].recoverS) >= 70);
  assert.equal(resets(lab.calls), 3 + 1); // one per scenario and one final
});

test('fails when the baseline is never calm, without applying anything', async () => {
  const lab = fakeLab({ calm: false });
  const { rows, pass } = await runCheck(SETTINGS, lab.io);
  assert.equal(pass, false);
  assert.equal(rows[0].scenario, 'baseline');
  assert.equal(lab.calls.filter((c) => c.url.includes('/apply')).length, 0);
  assert.ok(lab.clock() >= 120_000);
  assert.equal(resets(lab.calls), 1);
});

test('fails when the reason kind is wrong, and still resets', async () => {
  const lab = fakeLab({ reasonFor: () => 'down' });
  const { rows, pass } = await runCheck(SETTINGS, lab.io);
  assert.equal(pass, false);
  assert.match(rows[0].result, /^FAIL/);
  assert.equal(rows[0].detectS, '>60');
  assert.ok(resets(lab.calls) >= 2);
});

test('fails when detection misses the 60 s deadline', async () => {
  const lab = fakeLab({ detectAfterS: 90 });
  const { rows, pass } = await runCheck(SETTINGS, lab.io);
  assert.equal(pass, false);
  assert.equal(rows[0].detectS, '>60');
  assert.equal(rows[0].result, 'FAIL (not detected)');
});

test('fails when the service does not recover within 120 s, and stops there', async () => {
  const lab = fakeLab({ recoverAfterS: 500 });
  const { rows, pass } = await runCheck(SETTINGS, lab.io);
  assert.equal(pass, false);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].recoverS, '>120');
  assert.equal(rows[0].result, 'FAIL (no recovery)');
  assert.ok(resets(lab.calls) >= 2);
});

test('reports an apply that the lab refuses and resets afterwards', async () => {
  const lab = fakeLab({ applyStatus: 401 });
  const { rows, pass } = await runCheck(SETTINGS, lab.io);
  assert.equal(pass, false);
  assert.match(rows[0].result, /answered 401/);
  assert.equal(resets(lab.calls), 1);
});

test('stops when the signal aborts and still sends the final reset', async () => {
  const lab = fakeLab({ detectAfterS: 1000 });
  const ctl = new AbortController();
  const slept = lab.io.sleep;
  lab.io.sleep = async (ms) => {
    await slept(ms);
    if (lab.clock() > 5000) ctl.abort();
  };
  const { pass } = await runCheck(SETTINGS, lab.io, ctl.signal);
  assert.equal(pass, false);
  assert.ok(lab.clock() < 60_000);
  assert.ok(resets(lab.calls) >= 1);
});

test('sends the token only to the chaos URL and never prints it', async () => {
  const lab = fakeLab();
  const logs = [];
  lab.io.log = (m) => logs.push(m);
  const { rows } = await runCheck(SETTINGS, lab.io);
  for (const c of lab.calls) {
    const auth = c.init.headers?.authorization;
    if (c.url.startsWith('http://chaos.test')) assert.equal(auth, `Bearer ${TOKEN}`);
    else assert.equal(JSON.stringify(c.init), '{"headers":{"accept":"application/json"}}');
    assert.ok(c.url.startsWith('http://chaos.test') || c.url.startsWith('http://api.test'));
  }
  const output = formatTable(rows) + logs.join('\n');
  assert.ok(!output.includes(TOKEN));
});

test('formatTable prints a header, a rule and one line per row', () => {
  const out = formatTable([{ scenario: 'fog', service: 'orders', level: 2, reason: 'p95', detectS: '12.0', recoverS: '70.0', result: 'PASS' }]);
  const lines = out.split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^scenario\s+service\s+level\s+reason\s+detect s\s+recover s\s+result$/);
  assert.match(lines[2], /^fog\s+orders\s+2\s+p95\s+12\.0\s+70\.0\s+PASS$/);
});
