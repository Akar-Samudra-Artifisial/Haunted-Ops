import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { checkEnv, checkEnvText, formatResult } from './demo-env-check.mjs';

const SCRIPT = fileURLToPath(new URL('./demo-env-check.mjs', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'env-prop-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const T1 = 'a'.repeat(48);
const T2 = 'b'.repeat(48);
// For each variable: the first value is valid, the others are plausible mistakes. `null` means the variable is absent.
const CHOICES = {
  NODE_ENV: ['production', 'development', '', 'Production', null],
  PORT: ['3000', '8080', '0', '65536', 'abc', null],
  HOST: ['127.0.0.1', 'localhost', '::1', '0.0.0.0', 'example.com', '', null],
  WEB_ORIGIN: ['https://a.example.test', 'http://a.example.test', 'https://a.example.test/', 'a.example.test', 'https://a.example.test:8443', null],
  TRUST_PROXY_HOPS: ['1', '0', '2', '', null],
  DATABASE_URL: ['postgresql://u:p@127.0.0.1:5432/d', 'postgres://u@h/d', 'mysql://u@h/d', 'nope', null],
  FIX_ENABLED: ['false', 'true', '', 'FALSE', '0', null],
  GITHUB_TOKEN: [null, null, null, '', 'x'],
  HUNTS_ENABLED: ['true', 'false', 'TRUE', '1', '', null],
  LAB_URL: ['http://127.0.0.1:4100', 'http://localhost:4100', 'http://[::1]:4100', 'http://10.0.0.1:4100', 'https://example.com', '127.0.0.1:4100', 'http://127.0.0.1:4100/x', null],
  PROMETHEUS_URL: ['http://127.0.0.1:9090', 'http://localhost:9090', 'http://[::1]:9090', 'http://10.0.0.1:9090', 'http://169.254.169.254', null],
  LAB_READ_TOKEN: [T1, T2, 'c'.repeat(24), 'c'.repeat(23), `CHANGE_ME_${'x'.repeat(20)}`, '', null],
  HUNT_ADMIN_TOKEN: [T2, T1, 'd'.repeat(24), 'd'.repeat(23), `CHANGE_ME_${'x'.repeat(20)}`, '', null],
  KIRO_CLI_PATH: ['/usr/local/bin/kiro-cli', 'kiro-cli', '', '/x', null],
  HUNT_WORKDIR: ['/var/lib/hops/hunts', 'hunts', '', null],
  HUNT_DAILY_MAX: ['3', '1', '4', '0', '-1', '3.0', '', null],
  HUNT_CREDIT_CAP: ['1.5', '1', '0', '1.6', '2', 'abc', '1.50', null],
  HUNT_DAILY_CREDIT_CAP: ['4.5', '4', '4.6', '5', '0', 'x', null],
};
// Weighted so that fully valid maps come up often enough to test acceptance.
const arbMap = fc.record(
  Object.fromEntries(
    Object.entries(CHOICES).map(([name, values]) => [
      name,
      fc.oneof({ weight: 6, arbitrary: fc.constant(values[0]) }, { weight: 1, arbitrary: fc.constantFrom(...values) }),
    ]),
  ),
).map((rec) => Object.fromEntries(Object.entries(rec).filter(([, v]) => v !== null)));

/** An oracle written from the rule table, with regular expressions only (it shares no helper with the module). Returns refused names. */
function oracle(m) {
  const bad = new Set();
  const get = (k) => (Object.hasOwn(m, k) ? m[k] : undefined);
  const loopbackOrigin = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:[0-9]+)?$/;
  if (get('NODE_ENV') !== 'production') bad.add('NODE_ENV');
  if (!/^postgres(ql)?:\/\/[^/]+\/.+$/.test(get('DATABASE_URL') ?? '')) bad.add('DATABASE_URL');
  if (!/^[0-9]+$/.test(get('PORT') ?? '') || Number(get('PORT')) < 1 || Number(get('PORT')) > 65535) bad.add('PORT');
  if (get('HOST') !== undefined && !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(get('HOST'))) bad.add('HOST');
  if (!/^https:\/\/[^/:]+(:[0-9]+)?$/.test(get('WEB_ORIGIN') ?? '')) bad.add('WEB_ORIGIN');
  if (get('TRUST_PROXY_HOPS') !== '1') bad.add('TRUST_PROXY_HOPS');
  if (get('FIX_ENABLED') !== 'false') bad.add('FIX_ENABLED');
  if (get('GITHUB_TOKEN') !== undefined) bad.add('GITHUB_TOKEN');
  if (!['true', 'false'].includes(get('HUNTS_ENABLED') ?? '')) bad.add('HUNTS_ENABLED');
  if (get('LAB_URL') !== undefined && !loopbackOrigin.test(get('LAB_URL'))) bad.add('LAB_URL');
  if (get('PROMETHEUS_URL') !== undefined && !loopbackOrigin.test(get('PROMETHEUS_URL'))) bad.add('PROMETHEUS_URL');
  const strong = (v) => v !== undefined && v.length >= 24 && !v.includes('CHANGE_ME');
  if (!strong(get('LAB_READ_TOKEN'))) bad.add('LAB_READ_TOKEN');
  if (!strong(get('HUNT_ADMIN_TOKEN')) || get('HUNT_ADMIN_TOKEN') === get('LAB_READ_TOKEN')) bad.add('HUNT_ADMIN_TOKEN');
  if (!/^\/[^\0]*$/.test(get('KIRO_CLI_PATH') ?? '')) bad.add('KIRO_CLI_PATH');
  if (!/^\/[^\0]*$/.test(get('HUNT_WORKDIR') ?? '')) bad.add('HUNT_WORKDIR');
  const dm = get('HUNT_DAILY_MAX') ?? '';
  if (!/^[0-9]+$/.test(dm) || Number(dm) < 1 || Number(dm) > 3) bad.add('HUNT_DAILY_MAX');
  const cap = (k, max) => {
    const v = get(k) ?? '';
    if (!/^[0-9]+(\.[0-9]+)?$/.test(v) || !(Number(v) > 0) || Number(v) > max) bad.add(k);
  };
  cap('HUNT_CREDIT_CAP', 1.5);
  cap('HUNT_DAILY_CREDIT_CAP', 4.5);
  return bad;
}

test('Property 1: the env guard accepts only maps that satisfy every rule', () => {
  // Feature: deploy-demo, Property 1
  let accepted = 0;
  fc.assert(
    fc.property(arbMap, (map) => {
      const got = checkEnv(map);
      const want = oracle(map);
      assert.deepEqual([...got].sort(), [...want].sort());
      assert.equal(got.length === 0, want.size === 0);
      if (got.length === 0) accepted += 1;
    }),
    { numRuns: 500 },
  );
  assert.ok(accepted > 0, 'the generator produced accepted maps');
});

// A value starts with a character that no name or fixed word of the output contains.
const arbValue = fc.string({ minLength: 6, maxLength: 40 }).map((s) => `§${s.replace(/[\r\n]/g, ' ')}`);
const KNOWN = Object.keys(CHOICES).concat(['FIX_RUN_AS_USER', 'CHAOS_TOKEN', 'SERVICE_BIND_HOST', 'TRAFFIC_RPS']);
const arbSecretMap = fc.dictionary(fc.constantFrom(...KNOWN), arbValue);

test('Property 2: the env guard never prints a value (result line)', () => {
  // Feature: deploy-demo, Property 2
  fc.assert(
    fc.property(arbSecretMap, fc.constantFrom('api', 'lab'), (map, profile) => {
      const text = Object.entries(map).map(([k, v]) => `${k}=${v}`).join('\n');
      const out = formatResult(checkEnvText(text, profile), profile);
      for (const value of Object.values(map)) {
        assert.ok(!out.includes(value), 'a value appears in the output');
        assert.ok(!out.includes(value.slice(1)), 'a value (without its first character) appears in the output');
      }
    }),
    { numRuns: 300 },
  );
});

test('Property 2: the env guard never prints a value (real CLI, stdout and stderr)', () => {
  // Feature: deploy-demo, Property 2
  fc.assert(
    fc.property(arbSecretMap, (map) => {
      const file = join(dir, 'case.env');
      writeFileSync(file, Object.entries(map).map(([k, v]) => `${k}=${v}`).join('\n'));
      const res = spawnSync(process.execPath, [SCRIPT, file], { encoding: 'utf8' });
      const out = `${res.stdout}${res.stderr}`;
      for (const value of Object.values(map)) assert.ok(!out.includes(value));
    }),
    { numRuns: 25 },
  );
});
