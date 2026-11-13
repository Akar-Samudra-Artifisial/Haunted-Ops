// A fake lab observability API and Prometheus on one loopback HTTP server, for tests.
// Answers in the lab formats (`../haunted-lab/.kiro/specs/haunted-lab/design.md:109-120`).
import { createServer } from 'node:http';
import { deploysFor, diffFor, errorsFor, logsFor, metricSeries, SCENARIOS, SERVICES } from './lab-data.mjs';

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
  const { token, scenario = 'error-spike', hostile = false, unreachable = [], down = false, extraDeploys = [] } = opts;
  const requests = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake');
    const authorized = req.headers.authorization === `Bearer ${token}`;
    requests.push({ path: url.pathname, authorized });
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
        const items = [...deploysFor(scenario), ...extraDeploys].sort((a, b) => a.time.localeCompare(b.time));
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
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
