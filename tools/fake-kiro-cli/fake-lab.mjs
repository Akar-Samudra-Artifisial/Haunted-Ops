// A fake lab observability API and Prometheus on one loopback HTTP server, for tests.
// Answers in the lab formats (`../haunted-lab/.kiro/specs/haunted-lab/design.md:109-120`).
import { createServer } from 'node:http';
import { deploysFor, diffFor, errorsFor, logsFor, metricSeries, SCENARIOS, SERVICES } from './lab-data.mjs';
import { deployFixAllowed, parseDeployFixBody } from './deploy-fix-rule.mjs';

const readBody = (req, max) =>
  new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size <= max) chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(size > max ? undefined : JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve(undefined);
      }
    });
    req.on('error', () => resolve(undefined));
  });

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

/**
 * Starts the fake. Options:
 *  - `token`: the bearer the `/lab/*` routes expect (required);
 *  - `scenario`: the scenario that is applied (default `error-spike`); only its deploy exists;
 *  - `hostile`: errors, logs and the commit carry instructions and a fake closing tag;
 *  - `unreachable`: SHAs whose diff answers 404 `unknown_commit`;
 *  - `down`: every route answers 503;
 *  - `extraDeploys`: more deploy records.
 * `requests` records `{ path, authorized }` of every call, never a token.
 */
export async function startFakeLab(opts) {
  const { token, scenario = 'error-spike', hostile = false, unreachable = [], down = false, extraDeploys = [], chaosToken = null } = opts;
  const requests = [];
  // `POST /chaos/deploy-fix`: the refs the lab "fetches from origin", and the allow-listed heads (main, scenario heads).
  const refs = new Map();
  const allowedHeads = [];
  const deployed = [];
  const deployFix = { mode: 'ok', calls: [] };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake');
    const authorized = req.headers.authorization === `Bearer ${token}`;
    requests.push({ path: url.pathname, authorized });
    if (url.pathname === '/chaos/deploy-fix' && req.method === 'POST') {
      void (async () => {
        const chaosOk = chaosToken !== null && req.headers.authorization === `Bearer ${chaosToken}`;
        const body = await readBody(req, 4096);
        deployFix.calls.push({ authorized: chaosOk, body });
        if (!chaosOk) return json(res, 401, { error: { code: 'unauthorized' } });
        if (deployFix.mode === 'unavailable') return json(res, 503, { error: { code: 'unavailable' } });
        const parsed = parseDeployFixBody(body);
        if (parsed === null) return json(res, 400, { error: { code: 'bad_request' } });
        const entry = refs.get(parsed.ref);
        if (entry === undefined) return json(res, 404, { error: { code: 'unknown_ref' } });
        if (entry.head !== parsed.sha) return json(res, 409, { error: { code: 'not_head' } });
        if (!deployFixAllowed({ head: entry.head, sha: parsed.sha, chain: entry.chain, allowedHeads, service: parsed.service })) {
          const outside = entry.chain.some((c) => !allowedHeads.includes(c.sha) && !c.files.every((f) => f.startsWith(`services/${parsed.service}/`)));
          return json(res, outside ? 422 : 409, { error: { code: outside ? 'outside_service' : 'chain_refused' } });
        }
        const record = { id: `d-${900 + deployed.length}`, service: parsed.service, ref: parsed.ref, sha: parsed.sha, time: new Date().toISOString(), actor: 'exorcist' };
        if (deployFix.mode !== 'never_record') deployed.push(record);
        return json(res, 200, { deployId: record.id, service: record.service, sha: record.sha });
      })();
      return;
    }
    if (down) return json(res, 503, { untrusted: true, error: { code: 'unavailable', message: 'down' } });
    if (url.pathname.startsWith('/lab/')) {
      if (!authorized) return json(res, 401, { untrusted: true, error: { code: 'unauthorized', message: 'unauthorized' } });
      const service = url.searchParams.get('service');
      if (url.pathname === '/lab/errors' || url.pathname === '/lab/logs') {
        if (!SERVICES.includes(service ?? '')) return json(res, 400, { untrusted: true, error: { code: 'bad_request', message: 'service' } });
        const items = url.pathname === '/lab/errors' ? errorsFor(service, hostile) : logsFor(service, hostile);
        const limit = Math.min(Number(url.searchParams.get('limit') ?? 100) || 100, 500);
        return json(res, 200, { untrusted: true, items: items.slice(-limit), truncated: items.length > limit });
      }
      if (url.pathname === '/lab/deploys') {
        const items = [...deploysFor(scenario), ...extraDeploys, ...deployed].sort((a, b) => a.time.localeCompare(b.time));
        return json(res, 200, { untrusted: true, items, truncated: false });
      }
      const m = /^\/lab\/commits\/([0-9a-f]{7,40})\/diff$/.exec(url.pathname);
      if (m) {
        const sha = m[1];
        const body = unreachable.some((u) => u.startsWith(sha) || sha.startsWith(u)) ? null : diffFor(sha, hostile);
        if (body === null) return json(res, 404, { untrusted: true, error: { code: 'unknown_commit', message: 'unknown commit' } });
        return json(res, 200, { untrusted: true, ...body });
      }
      return json(res, 404, { untrusted: true, error: { code: 'not_found', message: 'not found' } });
    }
    if (url.pathname === '/api/v1/query_range') {
      const start = Number(url.searchParams.get('start'));
      const end = Number(url.searchParams.get('end'));
      const step = Number.parseInt(url.searchParams.get('step') ?? '15', 10);
      const result = SERVICES.map((service) => ({ metric: { service }, values: metricSeries(service, scenario, start, end, step) }));
      return json(res, 200, { status: 'success', data: { resultType: 'matrix', result } });
    }
    return json(res, 404, { error: { code: 'not_found' } });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    scenario: SCENARIOS[scenario],
    refs,
    allowedHeads,
    deployed,
    deployFix,
    // Cuts kept-alive and leftover connections, so a test that failed midway does not hold `close` for minutes.
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
