import { describe, expect, it } from 'vitest';
import { HttpPrometheusClient, PollError, type PollErrorCode } from './prometheus-client.js';
import { parseSampleValue, parseVector } from './parse.js';
import { ERROR_RATIO_QUERY, MAX_BODY_BYTES, P95_MS_QUERY, QUERIES, QUERY_PATH, UP_QUERY } from './queries.js';

type Entry = { service?: string; value?: string };

function vector(entries: Entry[]): unknown {
  return {
    status: 'success',
    data: {
      resultType: 'vector',
      result: entries.map((e) => ({
        metric: e.service === undefined ? {} : { service: e.service },
        value: [1_700_000_000, e.value ?? '0'],
      })),
    },
  };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface Call {
  url: string;
  init: RequestInit;
}

/** A fake fetch that answers by query text. `answers` maps a PromQL constant to a response factory. */
function fakeFetch(answer: (promql: string, call: Call) => Response | Promise<Response>): {
  fetch: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const call = { url, init: init ?? {} };
    calls.push(call);
    const promql = new URL(url).searchParams.get('query') ?? '';
    return answer(promql, call);
  }) as typeof fetch;
  return { fetch: fn, calls };
}

const healthy = (promql: string): Response => {
  if (promql === ERROR_RATIO_QUERY) return json(vector([{ service: 'payments', value: '0.22' }, { service: 'gate', value: '0' }]));
  if (promql === P95_MS_QUERY) return json(vector([{ service: 'orders', value: '2200.5' }, { service: 'gate', value: 'NaN' }]));
  return json(vector([{ service: 'gate', value: '1' }, { service: 'ledger', value: '0' }]));
};

const client = (f: typeof fetch, timeoutMs = 1000): HttpPrometheusClient =>
  new HttpPrometheusClient({ baseUrl: 'http://127.0.0.1:9090', timeoutMs, fetch: f });

async function codeOf(p: Promise<unknown>): Promise<PollErrorCode> {
  try {
    await p;
  } catch (err) {
    if (err instanceof PollError) return err.code;
    throw err;
  }
  throw new Error('expected a PollError');
}

describe('query constants', () => {
  it('are the documented PromQL strings', () => {
    expect(ERROR_RATIO_QUERY).toBe(
      '(sum by (service) (rate(http_requests_total{code=~"5.."}[30s])) or on(service) (0 * sum by (service) (rate(http_requests_total[30s])))) / sum by (service) (rate(http_requests_total[30s]))',
    );
    expect(P95_MS_QUERY).toBe(
      '1000 * histogram_quantile(0.95, sum by (service, le) (rate(http_request_duration_seconds_bucket[30s])))',
    );
    expect(UP_QUERY).toBe('avg_over_time(up{job="lab"}[30s])');
    expect(Object.isFrozen(QUERIES)).toBe(true);
    expect(MAX_BODY_BYTES).toBe(1_048_576);
  });

  it('contain no interpolation placeholder', () => {
    for (const q of Object.values(QUERIES)) expect(q).not.toMatch(/\$\{|\{\{|%s|undefined|null/);
  });
});

describe('PrometheusClient', () => {
  it('runs exactly the three constant queries with GET, no redirect following and no credentials', async () => {
    const { fetch: f, calls } = fakeFetch(healthy);
    const result = await client(f).poll(new AbortController().signal);
    expect(calls).toHaveLength(3);
    const queries = calls.map((c) => new URL(c.url).searchParams.get('query')).sort();
    expect(queries).toEqual([ERROR_RATIO_QUERY, P95_MS_QUERY, UP_QUERY].sort());
    for (const c of calls) {
      const url = new URL(c.url);
      expect(url.origin).toBe('http://127.0.0.1:9090');
      expect(url.pathname).toBe(QUERY_PATH);
      expect(c.init.method).toBe('GET');
      expect(c.init.redirect).toBe('error');
      expect(c.init.body).toBeUndefined();
      expect(c.init.credentials).toBeUndefined();
      expect(JSON.stringify(c.init.headers)).not.toMatch(/authorization|cookie/i);
    }
    expect(result).toEqual({
      gate: { errorRate: 0, p95Ms: null, up: 1 },
      orders: { errorRate: null, p95Ms: 2200.5, up: null },
      payments: { errorRate: 0.22, p95Ms: null, up: null },
      ledger: { errorRate: null, p95Ms: null, up: 0 },
    });
  });

  it('fails as a whole when one of the three queries fails', async () => {
    const { fetch: f } = fakeFetch((q) => (q === UP_QUERY ? json({}, 500) : healthy(q)));
    expect(await codeOf(client(f).poll(new AbortController().signal))).toBe('status');
  });

  it('maps a refused connection to network', async () => {
    const f = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    expect(await codeOf(client(f).poll(new AbortController().signal))).toBe('network');
  });

  it('maps a redirect (fetch rejects with redirect: error) to network', async () => {
    const { fetch: f } = fakeFetch(() => {
      throw new TypeError('redirect mode is set to error');
    });
    expect(await codeOf(client(f).poll(new AbortController().signal))).toBe('network');
  });

  it('times out a request that never answers', async () => {
    const f = ((_: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      })) as typeof fetch;
    expect(await codeOf(client(f, 30).poll(new AbortController().signal))).toBe('timeout');
  });

  it('reports aborted when the shutdown signal fires', async () => {
    const ctl = new AbortController();
    const f = ((_: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      })) as typeof fetch;
    const p = codeOf(client(f, 5000).poll(ctl.signal));
    ctl.abort();
    expect(await p).toBe('aborted');
  });

  it('rejects a body that is not a Prometheus success vector', async () => {
    for (const body of [
      { status: 'error', errorType: 'bad_data', error: 'secret text' },
      { status: 'success', data: { resultType: 'matrix', result: [] } },
      { status: 'success', data: { resultType: 'vector' } },
      [],
      'text',
      null,
    ]) {
      const { fetch: f } = fakeFetch(() => json(body));
      expect(await codeOf(client(f).poll(new AbortController().signal))).toBe('body');
    }
  });

  it('rejects bad JSON', async () => {
    const { fetch: f } = fakeFetch(() => new Response('{nope', { status: 200 }));
    expect(await codeOf(client(f).poll(new AbortController().signal))).toBe('body');
  });

  it('refuses a body over 1 MiB, by content-length and by streamed size', async () => {
    const big = 'x'.repeat(MAX_BODY_BYTES + 1);
    const { fetch: f } = fakeFetch(() => new Response(big, { status: 200 }));
    expect(await codeOf(client(f).poll(new AbortController().signal))).toBe('too_large');
    const { fetch: g } = fakeFetch(() => new Response('{}', { status: 200, headers: { 'content-length': String(MAX_BODY_BYTES + 5) } }));
    expect(await codeOf(client(g).poll(new AbortController().signal))).toBe('too_large');
  });

  it('never puts the URL or the body into the error', async () => {
    const { fetch: f } = fakeFetch(() => json({ status: 'error', error: 'SECRET-BODY-TEXT' }, 500));
    try {
      await client(f).poll(new AbortController().signal);
    } catch (err) {
      expect(String((err as Error).message) + String((err as Error).stack)).not.toMatch(/SECRET|127\.0\.0\.1/);
    }
  });
});

describe('parseVector', () => {
  it('reads known services and finite numbers only', () => {
    const body = vector([
      { service: 'gate', value: '0.5' },
      { service: 'cellar', value: '1' },
      { value: '1' },
      { service: 'orders', value: 'NaN' },
      { service: 'payments', value: '+Inf' },
      { service: 'ledger', value: '1e-3' },
    ]);
    expect(Object.fromEntries(parseVector(body))).toEqual({ gate: 0.5, ledger: 0.001 });
  });

  it('drops a service listed twice', () => {
    const body = vector([
      { service: 'gate', value: '1' },
      { service: 'gate', value: '2' },
      { service: 'orders', value: '3' },
    ]);
    expect(Object.fromEntries(parseVector(body))).toEqual({ orders: 3 });
  });

  it('returns an empty map for anything that is not a success vector', () => {
    for (const body of [undefined, null, 5, 'x', [], {}, { status: 'error' }, { status: 'success', data: null }]) {
      expect(parseVector(body).size).toBe(0);
    }
  });

  it('parses sample values strictly', () => {
    expect(parseSampleValue('0.22')).toBe(0.22);
    for (const bad of ['', ' 1', '0x10', 'NaN', 'Inf', '1e999', 5, null, undefined]) expect(parseSampleValue(bad)).toBeNull();
  });
});
