import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkEnvText, parseEnvText } from './demo-env-check.mjs';
import { readEnvValue } from './read-env-value.mjs';
const SCRIPT = fileURLToPath(new URL('./read-env-value.mjs', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'read-env-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const KEY = 'abcdefghij0123456789ABCD';
const run = (text, name = 'KIRO_API_KEY') => {
  const file = join(dir, 'kiro.env');
  writeFileSync(file, text);
  return spawnSync(process.execPath, [SCRIPT, file, name], { encoding: 'utf8' });
};
test('reads the value the way the env guard does: spaces around the equals sign and the value, then the quotes', () => {
  for (const line of [`KIRO_API_KEY=${KEY}`, `KIRO_API_KEY = "${KEY}"`, `  KIRO_API_KEY =   '${KEY}'  `, `KIRO_API_KEY="${KEY}"`, `KIRO_API_KEY =${KEY}`]) {
    const text = `# the key\n${line}\n`;
    assert.equal(parseEnvText(text).vars.KIRO_API_KEY, KEY, line);
    assert.equal(readEnvValue(text, 'KIRO_API_KEY'), KEY, line);
    const r = run(text);
    assert.equal(r.status, 0, line);
    assert.equal(r.stdout, KEY, line);
    assert.equal(r.stderr, '');
    // What the guard accepts, the pre-flight reads: the same value.
    assert.deepEqual(checkEnvText(text, 'kiro'), []);
  }
});
test('the last line wins, as in the guard, and a missing or empty key prints nothing and exits 1', () => {
  assert.equal(run(`KIRO_API_KEY=old${KEY}\nKIRO_API_KEY = "${KEY}"\n`).stdout, KEY);
  for (const text of ['', '# nothing\n', 'OTHER=1\n', 'KIRO_API_KEY=\n', 'KIRO_API_KEY = ""\n']) {
    const r = run(text);
    assert.equal(r.status, 1, JSON.stringify(text));
    assert.equal(r.stdout, '');
  }
});
test('usage: a file and one NAME, and an unreadable file prints nothing', () => {
  assert.equal(spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' }).status, 2);
  assert.equal(spawnSync(process.execPath, [SCRIPT, join(dir, 'kiro.env'), 'lower'], { encoding: 'utf8' }).status, 2);
  const r = spawnSync(process.execPath, [SCRIPT, join(dir, 'missing.env'), 'KIRO_API_KEY'], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
});
test('the pre-flight reads the key with this script, not with sed, and the release ships it', () => {
  const pre = readFileSync(fileURLToPath(new URL('../deploy/server/preflight.sh', import.meta.url)), 'utf8');
  assert.match(pre, /key="\$\(\/usr\/local\/bin\/node "\$CURRENT\/scripts\/read-env-value\.mjs" "\$KIRO_ENV" KIRO_API_KEY\)"/);
  assert.ok(!/sed [^\n]*KIRO_API_KEY/.test(pre), 'no sed on the key');
  const build = readFileSync(fileURLToPath(new URL('../deploy/build-release.sh', import.meta.url)), 'utf8');
  assert.match(build, /scripts\/read-env-value\.mjs/);
});
test('the pre-flight compares LAB_READ_TOKEN of both files with this script, so a quoted value with spaces matches', () => {
  const pre = readFileSync(fileURLToPath(new URL('../deploy/server/preflight.sh', import.meta.url)), 'utf8');
  const fn = pre.match(/^same_read_token\(\) \(.*\n(?: {2}.*\n)+\)\n/m)?.[0];
  assert.ok(fn, 'same_read_token is in the pre-flight');
  assert.ok(!/LAB_READ_TOKEN=\(/.test(fn) && !/\.match\(/.test(fn), 'no regular expression on the file');
  assert.equal((fn.match(/read-env-value\.mjs" \/etc\/haunted\/(?:api|lab)\.env LAB_READ_TOKEN/g) ?? []).length, 2);
  // Run the function on temporary files: the real paths and node are replaced, nothing else.
  const etc = join(dir, 'etc-haunted');
  mkdirSync(etc, { recursive: true });
  const body = fn.replaceAll('/usr/local/bin/node', process.execPath).replaceAll('/etc/haunted/', `${etc}/`);
  const same = (api, lab) => {
    writeFileSync(join(etc, 'api.env'), api);
    writeFileSync(join(etc, 'lab.env'), lab);
    return spawnSync('bash', ['-c', `CURRENT=${JSON.stringify(join(dirname(SCRIPT), '..'))}; ${body}\nsame_read_token`], { encoding: 'utf8' });
  };
  const TOKEN = 'tok-0123456789abcdefghijklmnop';
  for (const [api, lab] of [
    [`LAB_READ_TOKEN=${TOKEN}\n`, `LAB_READ_TOKEN=${TOKEN}\n`],
    [`LAB_READ_TOKEN = "${TOKEN}"\n`, `LAB_READ_TOKEN=${TOKEN}\n`],
    [`LAB_READ_TOKEN=${TOKEN}\n`, `  LAB_READ_TOKEN =  '${TOKEN}'  \n`],
    [`# first\nLAB_READ_TOKEN=old\nLAB_READ_TOKEN = "${TOKEN}"\n`, `LAB_READ_TOKEN="${TOKEN}"\n`],
  ]) {
    const r = same(api, lab);
    assert.equal(r.status, 0, JSON.stringify(api) + JSON.stringify(lab));
    assert.ok(!r.stdout.includes(TOKEN) && !r.stderr.includes(TOKEN), 'the token is never printed');
  }
  for (const [api, lab] of [
    [`LAB_READ_TOKEN=${TOKEN}\n`, `LAB_READ_TOKEN=${TOKEN}x\n`],
    [`LAB_READ_TOKEN=${TOKEN}\n`, 'OTHER=1\n'],
    ['OTHER=1\n', `LAB_READ_TOKEN=${TOKEN}\n`],
    ['LAB_READ_TOKEN=\n', 'LAB_READ_TOKEN=\n'],
    ['', ''],
  ]) assert.notEqual(same(api, lab).status, 0, JSON.stringify(api) + JSON.stringify(lab));
});
