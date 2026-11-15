import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { EXPECTED_KIRO_CLI, REQUIRED_ENV, formatResults, runPreflight } from './fix-live-preflight.mjs';

// The pre-flight with a FAKE kiro-cli (a shell script), a local lab, Prometheus and GitHub, and a fake database check.
// Nothing here calls the real binary, the model or the network outside 127.0.0.1.
const LAB_TOKEN = 'lab-read-token-0123456789-abcdef';
const GH_TOKEN = 'github_pat_FAKEFAKEFAKEFAKEFAKEFAKE0123456789';
const root = mkdtempSync(join(tmpdir(), 'preflight-'));
let servers = [];
let urls = {};

const listen = (handler) =>
  new Promise((resolve) => {
    const s = createServer(handler);
    s.listen(0, '127.0.0.1', () => {
      servers.push(s);
      resolve(`http://127.0.0.1:${s.address().port}`);
    });
  });

/** A fake `kiro-cli`: the version it prints, and whether `whoami` succeeds. */
function fakeCli(name, { version = EXPECTED_KIRO_CLI, whoami = true } = {}) {
  const file = join(root, name);
  writeFileSync(file, `#!/bin/sh\ncase "$1" in\n  --version) echo "kiro-cli ${version}" ;;\n  whoami) ${whoami ? 'echo "someone"' : 'exit 1'} ;;\n  *) exit 2 ;;\nesac\n`);
  chmodSync(file, 0o755);
  return file;
}
function fakeHome(name, mode) {
  const home = join(root, name);
  const dir = join(home, 'Library', 'Application Support', 'kiro-cli');
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, mode);
  return home;
}

before(async () => {
  const lab = await listen((req, res) => {
    const ok = req.url?.startsWith('/lab/deploys?since=') && req.headers.authorization === `Bearer ${LAB_TOKEN}`;
    res.writeHead(ok ? 200 : 401).end(ok ? '{"items":[]}' : '');
  });
  const prometheus = await listen((req, res) => res.writeHead(req.url === '/-/ready' ? 200 : 404).end());
  const github = await listen((req, res) => {
    const ok = req.url === '/repos/owner/lab' && req.headers.authorization === `Bearer ${GH_TOKEN}`;
    res.writeHead(ok ? 200 : 404).end('{}');
  });
  urls = { lab, prometheus, github };
});
after(() => {
  for (const s of servers) s.close();
  rmSync(root, { recursive: true, force: true });
});

const baseEnv = (over = {}) => ({
  PATH: process.env.PATH,
  HOME: fakeHome('home-ok', 0o700),
  KIRO_CLI_PATH: fakeCli('kiro-ok'),
  GITHUB_TOKEN: GH_TOKEN,
  LAB_GITHUB_REPO: 'owner/lab',
  CHAOS_URL: 'http://127.0.0.1:4100',
  CHAOS_TOKEN: 'chaos-token-0123456789-abcdefghij',
  WEB_ORIGIN: 'http://localhost:5173',
  LAB_URL: urls.lab,
  LAB_READ_TOKEN: LAB_TOKEN,
  HUNT_ADMIN_TOKEN: 'admin-token-0123456789-abcdefgh',
  PROMETHEUS_URL: urls.prometheus,
  TEST_DATABASE_URL: 'postgresql://user:SECRET-PASSWORD@127.0.0.1:1/db',
  ...over,
});
const run = (env) => runPreflight(env, { githubApi: urls.github, pgCheck: async () => true });
const byName = (results, name) => results.find((r) => r.name === name);

test('every check passes with a fake 3.3.0 binary, a good login folder, the lab, Prometheus, the database and GitHub', async () => {
  const results = await run(baseEnv());
  assert.deepEqual(results.map((r) => [r.name, r.ok]), [
    ['kiro-cli version', true],
    ['kiro-cli whoami', true],
    ['kiro-cli login folder', true],
    ['environment names', true],
    ['lab', true],
    ['prometheus', true],
    ['test database', true],
    ['github repository', true],
  ]);
  const lines = formatResults(results);
  assert.equal(lines.length, 8);
  assert.ok(lines.every((l) => l.startsWith('OK  ')));
});

test('a wrong kiro-cli version, a failing whoami, and a missing binary each fail their own check', async () => {
  assert.equal(byName(await run(baseEnv({ KIRO_CLI_PATH: fakeCli('kiro-old', { version: '3.2.9' }) })), 'kiro-cli version').ok, false);
  const nologin = await run(baseEnv({ KIRO_CLI_PATH: fakeCli('kiro-nologin', { whoami: false }) }));
  assert.equal(byName(nologin, 'kiro-cli whoami').ok, false);
  assert.equal(byName(nologin, 'kiro-cli version').ok, true);
  const gone = await run(baseEnv({ KIRO_CLI_PATH: join(root, 'does-not-exist') }));
  assert.equal(byName(gone, 'kiro-cli version').ok, false);
  assert.equal(byName(gone, 'kiro-cli whoami').ok, false);
});

test('the login folder must be a real folder with owner rwx: a mode 500 folder, a file, a link and a missing folder fail', async () => {
  assert.equal(byName(await run(baseEnv({ HOME: fakeHome('home-500', 0o500) })), 'kiro-cli login folder').ok, false);
  assert.match(byName(await run(baseEnv({ HOME: fakeHome('home-500b', 0o500) })), 'kiro-cli login folder').detail, /mode 500/);
  const fileHome = join(root, 'home-file');
  mkdirSync(join(fileHome, 'Library', 'Application Support'), { recursive: true });
  writeFileSync(join(fileHome, 'Library', 'Application Support', 'kiro-cli'), 'x');
  assert.equal(byName(await run(baseEnv({ HOME: fileHome })), 'kiro-cli login folder').ok, false);
  const linkHome = join(root, 'home-link');
  mkdirSync(join(linkHome, 'Library', 'Application Support'), { recursive: true });
  symlinkSync(join(root, 'home-ok'), join(linkHome, 'Library', 'Application Support', 'kiro-cli'));
  assert.equal(byName(await run(baseEnv({ HOME: linkHome })), 'kiro-cli login folder').ok, false);
  assert.equal(byName(await run(baseEnv({ HOME: join(root, 'no-such-home') })), 'kiro-cli login folder').ok, false);
  assert.equal(byName(await run(baseEnv({ HOME: undefined })), 'kiro-cli login folder').ok, false);
});

test('a missing environment name is listed by name, and the values are never printed', async () => {
  const env = baseEnv();
  delete env.CHAOS_TOKEN;
  delete env.WEB_ORIGIN;
  const results = await run(env);
  const names = byName(results, 'environment names');
  assert.equal(names.ok, false);
  assert.equal(names.detail, 'not set: CHAOS_TOKEN, WEB_ORIGIN');
  const text = formatResults(await run(baseEnv({ GITHUB_TOKEN: 'github_pat_WRONGWRONGWRONGWRONG0123456789' }))).join('\n');
  for (const secret of [GH_TOKEN, LAB_TOKEN, 'SECRET-PASSWORD', 'chaos-token-0123456789', 'admin-token-0123456789', root]) assert.ok(!text.includes(secret), secret);
  for (const name of REQUIRED_ENV) assert.ok(typeof name === 'string');
});

test('the lab, Prometheus and the database each fail on their own, with the HTTP status only', async () => {
  const lab = byName(await run(baseEnv({ LAB_READ_TOKEN: 'wrong-wrong-wrong-wrong-wrong-0' })), 'lab');
  assert.deepEqual([lab.ok, lab.detail], [false, 'HTTP 401']);
  const noLab = byName(await run(baseEnv({ LAB_URL: 'http://127.0.0.1:1' })), 'lab');
  assert.deepEqual([noLab.ok, noLab.detail], [false, 'no answer']);
  assert.equal(byName(await run(baseEnv({ PROMETHEUS_URL: `${urls.prometheus}/nope` })), 'prometheus').ok, false);
  assert.equal(byName(await runPreflight(baseEnv(), { githubApi: urls.github, pgCheck: async () => false }), 'test database').ok, false);
});

test('GitHub: a token that cannot read the repository fails with its status; the token goes only to the GitHub base', async () => {
  const wrong = byName(await run(baseEnv({ GITHUB_TOKEN: 'github_pat_WRONGWRONGWRONGWRONG0123456789' })), 'github repository');
  assert.deepEqual([wrong.ok, wrong.detail], [false, 'HTTP 404']);
  assert.equal(byName(await run(baseEnv({ LAB_GITHUB_REPO: '../etc/passwd' })), 'github repository').ok, false);
  // The lab, Prometheus and the database never see the token.
  const seen = [];
  const spy = async (url, init) => {
    seen.push([String(url), JSON.stringify(init?.headers ?? {})]);
    return new Response(null, { status: 200 });
  };
  await runPreflight(baseEnv(), { fetchFn: spy, githubApi: 'https://github.test', pgCheck: async () => true });
  for (const [url, headers] of seen) assert.equal(headers.includes(GH_TOKEN), url.startsWith('https://github.test/repos/'), url);
});

test('the checks never call the model: the fake binary only gets --version and whoami', async () => {
  const log = join(root, 'calls.log');
  const file = join(root, 'kiro-log');
  writeFileSync(file, `#!/bin/sh\necho "$1" >> '${log}'\ncase "$1" in --version) echo "kiro-cli ${EXPECTED_KIRO_CLI}" ;; whoami) echo me ;; *) exit 2 ;; esac\n`);
  chmodSync(file, 0o755);
  await run(baseEnv({ KIRO_CLI_PATH: file }));
  const { readFileSync } = await import('node:fs');
  assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), ['--version', 'whoami']);
});
