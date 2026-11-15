import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { formatTable, parseOrigin, runSmoke } from './demo-smoke.mjs';

const SCRIPT = fileURLToPath(new URL('./demo-smoke.mjs', import.meta.url));
const servers = [];

const GOOD_HEADERS = {
  'content-security-policy': "default-src 'self'; script-src 'self'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'strict-transport-security': 'max-age=31536000',
};

/**
 * A local stand-in for the demo origin. `fault` names one thing to break; 'none' is the healthy server.
 * Only 127.0.0.1 is used.
 */
async function fake(fault = 'none') {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const send = (status, type, body, extra = {}) => {
      const headers = { ...GOOD_HEADERS, ...extra };
      if (fault === `no-${'content-security-policy'}`) delete headers['content-security-policy'];
      if (fault === 'no-hsts') delete headers['strict-transport-security'];
      if (fault === 'no-nosniff') delete headers['x-content-type-options'];
      if (fault === 'weak-hsts') headers['strict-transport-security'] = 'nope';
      res.writeHead(status, { 'content-type': type, ...headers });
      res.end(body);
    };
    const html = '<!doctype html><html><body><div id="root"></div></body></html>';
    if (req.method === 'POST') {
      if (fault === 'post-open' && url.pathname === '/api/hunts') return send(401, 'application/json', '{}');
      if (fault === 'kill-open' && url.pathname === '/api/hunts/kill-switch') return send(200, 'application/json', '{}');
      return send(405, 'text/plain', 'method not allowed', { allow: 'GET, HEAD' });
    }
    switch (url.pathname) {
      case '/':
        if (fault === 'root-500') return send(500, 'text/html', html);
        if (fault === 'redirect') return send(308, 'text/html', '', { location: '/x' });
        if (fault === 'root-text') return send(200, 'text/plain', 'hello');
        return send(200, 'text/html; charset=utf-8', html);
      case '/hunts/x':
        return fault === 'no-fallback' ? send(404, 'text/plain', 'not found') : send(200, 'text/html', html);
      case '/healthz':
        if (fault === 'health-down') return send(503, 'application/json', '{"status":"degraded"}');
        if (fault === 'health-text') return send(200, 'text/plain', 'ok');
        return send(200, 'application/json', '{"status":"ok","db":"up"}');
      case '/api/services':
        if (fault === 'services-html') return send(200, 'text/html', html);
        if (fault === 'services-500') return send(500, 'application/json', '{}');
        return send(200, 'application/json; charset=utf-8', '[]');
      case '/api/events':
        if (fault === 'events-json') return send(200, 'application/json', '{}');
        if (fault === 'events-silent') return; // never answers
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', ...GOOD_HEADERS });
        res.flushHeaders();
        res.write('event: heartbeat\ndata: {}\n\n');
        return; // stays open until the client closes it
      case '/.vite/manifest.json':
        return fault === 'manifest' ? send(200, 'application/json', '{}') : fault === 'manifest-fallback' ? send(200, 'text/html', html) : send(404, 'text/plain', 'nope');
      default:
        return send(404, 'text/plain', 'nope');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}
after(() => {
  for (const s of servers) {
    s.closeAllConnections();
    s.close();
  }
});

// The fake server runs in this process, so the CLI is started without blocking the event loop.
const runCli = (args) =>
  new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 30_000 }, (err, stdout, stderr) => {
      resolve({ status: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout, stderr });
    });
  });

const failed = (results) => results.filter((r) => !r.ok).map((r) => r.name);

// Timing rule of this file: a check that must succeed gets a limit so generous that only a hang can reach it, and the speed
// of the machine cannot matter. Only the one fault that must time out (`events-silent`) uses a short limit, which a slow
// machine can only make longer, never wrong.
const GENEROUS_MS = 60_000;
const SHORT_MS = 300;
test('every check passes against a healthy server', async () => {
  const results = await runSmoke(await fake(), { sseTimeoutMs: GENEROUS_MS, timeoutMs: GENEROUS_MS });
  assert.deepEqual(failed(results), []);
  assert.equal(results.length, 13);
});

test('each failure is detected', async () => {
  /** [fault, a part of the name of the check that must fail] */
  const cases = [
    ['root-500', 'GET /'],
    ['redirect', 'GET /'],
    ['root-text', 'GET /'],
    ['no-fallback', '/hunts/x'],
    ['health-down', '/healthz'],
    ['health-text', '/healthz'],
    ['services-html', '/api/services'],
    ['services-500', '/api/services'],
    ['events-json', '/api/events'],
    ['events-silent', '/api/events'],
    ['post-open', 'POST /api/hunts refused'],
    ['kill-open', 'kill-switch refused'],
    ['manifest', '.vite/manifest.json'],
    ['manifest-fallback', '.vite/manifest.json'],
    ['no-content-security-policy', 'header content-security-policy'],
    ['no-hsts', 'header strict-transport-security'],
    ['weak-hsts', 'header strict-transport-security'],
    ['no-nosniff', 'header x-content-type-options'],
  ];
  for (const [fault, part] of cases) {
    const results = await runSmoke(await fake(fault), { sseTimeoutMs: fault === 'events-silent' ? SHORT_MS : GENEROUS_MS, timeoutMs: GENEROUS_MS });
    const names = failed(results);
    assert.ok(
      names.some((n) => n.includes(part)),
      `${fault}: expected a failure of "${part}", got ${JSON.stringify(names)}`,
    );
  }
});

test('an origin that does not answer fails every check without throwing', async () => {
  // A port that was open a moment ago and is closed now: the connection is refused at once, on every machine.
  const closed = createServer();
  await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${closed.address().port}`;
  await new Promise((resolve) => closed.close(resolve));
  const results = await runSmoke(origin, { sseTimeoutMs: GENEROUS_MS, timeoutMs: GENEROUS_MS });
  assert.equal(failed(results).length, results.length);
  assert.ok(results.every((r) => r.status === 'error'));
});

test('the table lists name, status and OK or FAIL', () => {
  const table = formatTable([
    { name: 'GET /', status: 200, ok: true },
    { name: 'GET /x', status: 'timeout', ok: false },
  ]);
  const lines = table.split('\n');
  assert.match(lines[0], /^name\s+status\s+result$/);
  assert.match(lines[1], /^GET \/\s+200\s+OK$/);
  assert.match(lines[2], /^GET \/x\s+timeout\s+FAIL$/);
});

test('origin parsing', () => {
  assert.equal(parseOrigin('https://demo.example.test'), 'https://demo.example.test');
  assert.equal(parseOrigin('https://demo.example.test/'), 'https://demo.example.test');
  assert.equal(parseOrigin('https://demo.example.test/path'), null);
  assert.equal(parseOrigin('ftp://demo.example.test'), null);
  assert.equal(parseOrigin('nope'), null);
});

test('the CLI exits 0 when all pass, 1 when one fails, 2 on a bad origin', async () => {
  const good = await runCli([await fake()]);
  assert.equal(good.status, 0, good.stdout + good.stderr);
  assert.match(good.stdout, /demo-smoke: all checks passed/);
  const bad = await runCli([await fake('manifest')]);
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /FAIL/);
  assert.equal((await runCli([])).status, 2);
  assert.equal((await runCli(['nope'])).status, 2);
});
