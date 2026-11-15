import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkEnv, checkEnvText, formatResult, parseEnvText } from './demo-env-check.mjs';

const SCRIPT = fileURLToPath(new URL('./demo-env-check.mjs', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'env-check-'));
after(() => rmSync(dir, { recursive: true, force: true }));

// Test values only. None is a real secret.
const TOKEN_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TOKEN_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
// A token-shaped value built at run time from parts, so that no secret scanner sees one in this file.
const FAKE_GITHUB_TOKEN = 'gh' + 'p_' + 'X'.repeat(36);
const VALID_API = Object.freeze({
  NODE_ENV: 'production',
  PORT: '3000',
  HOST: '127.0.0.1',
  WEB_ORIGIN: 'https://demo.example.test',
  TRUST_PROXY_HOPS: '1',
  DATABASE_URL: 'postgresql://hops:dbpass@127.0.0.1:5432/haunted',
  FIX_ENABLED: 'false',
  HUNTS_ENABLED: 'true',
  LAB_URL: 'http://127.0.0.1:4100',
  PROMETHEUS_URL: 'http://127.0.0.1:9090',
  LAB_READ_TOKEN: TOKEN_A,
  HUNT_ADMIN_TOKEN: TOKEN_B,
  KIRO_CLI_PATH: '/usr/local/bin/kiro-cli',
  HUNT_WORKDIR: '/var/lib/hops/hunts',
  HUNT_DAILY_MAX: '3',
  HUNT_CREDIT_CAP: '1.5',
  HUNT_DAILY_CREDIT_CAP: '4.5',
});
const VALID_LAB = Object.freeze({
  NODE_ENV: 'production',
  CHAOS_TOKEN: TOKEN_A,
  LAB_READ_TOKEN: TOKEN_B,
  SERVICE_BIND_HOST: '127.0.0.1',
  TRAFFIC_RPS: '5',
});
const toText = (map) => Object.entries(map).map(([k, v]) => `${k}=${v}`).join('\n');
const without = (map, key) => Object.fromEntries(Object.entries(map).filter(([k]) => k !== key));
const run = (text, profile) => {
  const file = join(dir, `case-${Math.random().toString(36).slice(2)}.env`);
  writeFileSync(file, text);
  return spawnSync(process.execPath, profile ? [SCRIPT, file, profile] : [SCRIPT, file], { encoding: 'utf8' });
};

test('a valid api map is accepted', () => {
  assert.deepEqual(checkEnv({ ...VALID_API }), []);
  assert.deepEqual(checkEnv({ ...without(VALID_API, 'HOST'), HUNTS_ENABLED: 'false' }), []);
});

test('each api refusal case names its variable', () => {
  /** [what changes, expected name] */
  const cases = [
    [{ FIX_ENABLED: 'true' }, 'FIX_ENABLED'],
    [{ FIX_ENABLED: 'False' }, 'FIX_ENABLED'],
    [{ GITHUB_TOKEN: 'x' }, 'GITHUB_TOKEN'],
    [{ GITHUB_TOKEN: '' }, 'GITHUB_TOKEN'],
    [{ HOST: '0.0.0.0' }, 'HOST'],
    [{ HOST: '10.0.0.5' }, 'HOST'],
    [{ WEB_ORIGIN: 'http://demo.example.test' }, 'WEB_ORIGIN'],
    [{ WEB_ORIGIN: 'https://demo.example.test/path' }, 'WEB_ORIGIN'],
    [{ HUNT_DAILY_MAX: '4' }, 'HUNT_DAILY_MAX'],
    [{ HUNT_DAILY_MAX: '0' }, 'HUNT_DAILY_MAX'],
    [{ HUNT_CREDIT_CAP: '1.6' }, 'HUNT_CREDIT_CAP'],
    [{ HUNT_CREDIT_CAP: 'abc' }, 'HUNT_CREDIT_CAP'],
    [{ HUNT_DAILY_CREDIT_CAP: '4.6' }, 'HUNT_DAILY_CREDIT_CAP'],
    [{ HUNT_DAILY_CREDIT_CAP: '30' }, 'HUNT_DAILY_CREDIT_CAP'],
    [{ LAB_READ_TOKEN: 'short' }, 'LAB_READ_TOKEN'],
    [{ HUNT_ADMIN_TOKEN: 'short' }, 'HUNT_ADMIN_TOKEN'],
    [{ LAB_READ_TOKEN: 'CHANGE_ME_LAB_READ_TOKEN_PLACEHOLDER' }, 'LAB_READ_TOKEN'],
    [{ HUNT_ADMIN_TOKEN: TOKEN_A }, 'HUNT_ADMIN_TOKEN'],
    [{ PROMETHEUS_URL: 'http://10.0.0.9:9090' }, 'PROMETHEUS_URL'],
    [{ PROMETHEUS_URL: 'http://169.254.169.254' }, 'PROMETHEUS_URL'],
    [{ LAB_URL: 'http://lab.example.test:4100' }, 'LAB_URL'],
    [{ NODE_ENV: 'development' }, 'NODE_ENV'],
    [{ KIRO_CLI_PATH: 'kiro-cli' }, 'KIRO_CLI_PATH'],
    [{ KIRO_CLI_PATH: './kiro-cli' }, 'KIRO_CLI_PATH'],
    [{ HUNT_WORKDIR: 'hunts' }, 'HUNT_WORKDIR'],
    [{ TRUST_PROXY_HOPS: '0' }, 'TRUST_PROXY_HOPS'],
    [{ PORT: '70000' }, 'PORT'],
    [{ DATABASE_URL: 'mysql://x@127.0.0.1/db' }, 'DATABASE_URL'],
    [{ HUNTS_ENABLED: 'yes' }, 'HUNTS_ENABLED'],
  ];
  for (const [change, name] of cases) {
    assert.deepEqual(checkEnv({ ...VALID_API, ...change }), [name], `change ${JSON.stringify(Object.keys(change))}`);
  }
});

test('missing required variables are refused', () => {
  for (const name of Object.keys(VALID_API)) {
    if (name === 'HOST' || name === 'LAB_URL' || name === 'PROMETHEUS_URL') {
      assert.deepEqual(checkEnv(without(VALID_API, name)), [], `${name} may be missing (the default is loopback)`);
    } else {
      assert.deepEqual(checkEnv(without(VALID_API, name)), [name], `${name} is required`);
    }
  }
});

test('the lab profile', () => {
  assert.deepEqual(checkEnv({ ...VALID_LAB }, 'lab'), []);
  assert.deepEqual(checkEnv({ ...VALID_LAB, NODE_ENV: 'test' }, 'lab'), ['NODE_ENV']);
  assert.deepEqual(checkEnv({ ...VALID_LAB, FIX_RUN_AS_USER: 'someone' }, 'lab'), ['FIX_RUN_AS_USER']);
  assert.deepEqual(checkEnv({ ...VALID_LAB, GITHUB_TOKEN: 'x' }, 'lab'), ['GITHUB_TOKEN']);
  assert.deepEqual(checkEnv({ ...VALID_LAB, SERVICE_BIND_HOST: '0.0.0.0' }, 'lab'), ['SERVICE_BIND_HOST']);
  assert.deepEqual(checkEnv({ ...VALID_LAB, CHAOS_TOKEN: 'short' }, 'lab'), ['CHAOS_TOKEN']);
  assert.deepEqual(checkEnv({ ...VALID_LAB, LAB_READ_TOKEN: TOKEN_A }, 'lab'), ['LAB_READ_TOKEN']);
  assert.deepEqual(checkEnv({ ...VALID_LAB, TRAFFIC_RPS: '51' }, 'lab'), ['TRAFFIC_RPS']);
  assert.deepEqual(checkEnv(without(VALID_LAB, 'CHAOS_TOKEN'), 'lab'), ['CHAOS_TOKEN']);
});

test('the kiro profile: one variable, KIRO_API_KEY, printable ASCII of 20 to 512 characters; names only in the output', () => {
  // Obvious fakes, never a real key.
  const key = 'kiro-test-SENTINEL-0123456789abcdefghij';
  assert.deepEqual(checkEnvText(`KIRO_API_KEY=${key}\n`, 'kiro'), []);
  assert.deepEqual(checkEnvText(`# the key\nKIRO_API_KEY="${key}"\n`, 'kiro'), []);
  assert.deepEqual(checkEnvText('KIRO_API_KEY=\n', 'kiro'), ['KIRO_API_KEY'], 'empty');
  assert.deepEqual(checkEnvText('', 'kiro'), ['KIRO_API_KEY'], 'no key line');
  assert.deepEqual(checkEnvText('KIRO_API_KEY=short\n', 'kiro'), ['KIRO_API_KEY'], 'too short');
  assert.deepEqual(checkEnvText(`KIRO_API_KEY=${'a'.repeat(513)}\n`, 'kiro'), ['KIRO_API_KEY'], 'too long');
  assert.deepEqual(checkEnvText(`KIRO_API_KEY=${'a'.repeat(512)}\n`, 'kiro'), []);
  assert.deepEqual(checkEnvText(`KIRO_API_KEY=${key} with spaces\n`, 'kiro'), ['KIRO_API_KEY'], 'whitespace');
  assert.deepEqual(checkEnvText(`KIRO_API_KEY=${key}é\n`, 'kiro'), ['KIRO_API_KEY'], 'not ASCII');
  assert.deepEqual(checkEnvText(`KIRO_API_KEY=${key}\nGITHUB_TOKEN=x\nOTHER=1\n`, 'kiro'), ['GITHUB_TOKEN', 'OTHER'], 'unknown names');
  assert.deepEqual(checkEnvText(`KIRO_API_KEY=${key}\nnot a line\n`, 'kiro'), ['line 2']);
  // The CLI: exit codes, and the value is in no output.
  const ok = run(`KIRO_API_KEY=${key}\n`, 'kiro');
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout.trim(), 'demo-env-check: ok (kiro)');
  const bad = run(`KIRO_API_KEY=bad key ${key}\nEXTRA=${key}\n`, 'kiro');
  assert.equal(bad.status, 1);
  assert.equal(bad.stderr.trim(), 'demo-env-check: refused: KIRO_API_KEY, EXTRA');
  for (const r of [ok, bad]) assert.ok(!r.stdout.includes(key) && !r.stderr.includes(key), 'no value in the output');
  // The file is optional: a missing one is accepted, for this profile only.
  const missing = spawnSync(process.execPath, [SCRIPT, join(dir, 'no-kiro.env'), 'kiro'], { encoding: 'utf8' });
  assert.equal(missing.status, 0);
  assert.equal(missing.stdout.trim(), 'demo-env-check: ok (kiro, no file)');
});
test('parsing follows systemd: comments, quotes, duplicates, bad lines', () => {
  const { vars, badLines } = parseEnvText(['# comment', '; other', '', 'A=1', 'B="two words"', "C='x'", 'A=2', '  D = spaced ', 'not a line', '=novalue', '1BAD=x'].join('\n'));
  assert.equal(vars.A, '2');
  assert.equal(vars.B, 'two words');
  assert.equal(vars.C, 'x');
  assert.equal(vars.D, 'spaced');
  assert.deepEqual(badLines, [9, 10, 11]);
  assert.deepEqual(checkEnvText(`${toText(VALID_API)}\nnot a line\n`), ['line 18']);
  assert.deepEqual(checkEnvText(`${toText(VALID_API).replace('FIX_ENABLED=false', 'FIX_ENABLED="false"')}\n`), []);
});

test('an inherited name is not a variable', () => {
  const inherited = Object.assign(Object.create({ GITHUB_TOKEN: 'x' }), VALID_API);
  assert.deepEqual(checkEnv(inherited), []);
});

test('the CLI exits 0, 1 and 2 and prints names only', () => {
  const ok = run(toText(VALID_API));
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout.trim(), 'demo-env-check: ok (api)');
  const bad = run(toText({ ...VALID_API, FIX_ENABLED: 'true', GITHUB_TOKEN: FAKE_GITHUB_TOKEN, LAB_READ_TOKEN: 'tiny-secret-value' }));
  assert.equal(bad.status, 1);
  assert.equal(bad.stderr.trim(), 'demo-env-check: refused: FIX_ENABLED, GITHUB_TOKEN, LAB_READ_TOKEN');
  for (const value of [FAKE_GITHUB_TOKEN, 'tiny-secret-value', TOKEN_A, TOKEN_B, 'dbpass']) {
    assert.ok(!bad.stdout.includes(value) && !bad.stderr.includes(value), 'no value in the output');
  }
  const lab = run(toText(VALID_LAB), 'lab');
  assert.equal(lab.status, 0);
  assert.equal(lab.stdout.trim(), 'demo-env-check: ok (lab)');
  assert.equal(spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' }).status, 2);
  assert.equal(spawnSync(process.execPath, [SCRIPT, join(dir, 'missing.env')], { encoding: 'utf8' }).status, 2);
  assert.equal(run(toText(VALID_API), 'nope').status, 2);
});

test('the example files are refused until the placeholders are replaced, and accepted after', async () => {
  const { readFileSync } = await import('node:fs');
  const api = readFileSync(new URL('../deploy/server/env/api.env.example', import.meta.url), 'utf8');
  const lab = readFileSync(new URL('../deploy/server/env/lab.env.example', import.meta.url), 'utf8');
  assert.ok(checkEnvText(api).length > 0);
  assert.ok(checkEnvText(lab, 'lab').length > 0);
  const filledApi = api
    .replaceAll('__HAUNTED_DOMAIN__', 'demo.example.test')
    .replaceAll('__DB_PASSWORD__', 'dbpass')
    .replaceAll('CHANGE_ME_LAB_READ_TOKEN', TOKEN_A)
    .replaceAll('CHANGE_ME_HUNT_ADMIN_TOKEN', TOKEN_B);
  assert.deepEqual(checkEnvText(filledApi), []);
  const filledLab = lab.replaceAll('CHANGE_ME_LAB_READ_TOKEN', TOKEN_A).replaceAll('CHANGE_ME_CHAOS_TOKEN', TOKEN_B);
  assert.deepEqual(checkEnvText(filledLab, 'lab'), []);
});

test('formatResult', () => {
  assert.equal(formatResult([], 'api'), 'demo-env-check: ok (api)');
  assert.equal(formatResult(['A', 'B'], 'api'), 'demo-env-check: refused: A, B');
});
