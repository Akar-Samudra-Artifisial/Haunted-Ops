import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { PromClient, rangeUrl } from '../src/prom-client.js';
import { PROMQL, SIGNALS, STEP_SECONDS, WINDOW_SECONDS, WINDOWS } from '../src/schemas.js';
import { NOW } from './fakes.js';

const BASE = 'http://127.0.0.1:9090';

// Feature: exorcist-agent, Property 6
describe('Property 6: metric queries are constant', () => {
  it('sends one of the three templates, a fixed step and times from the clock only', async () => {
    const seen = new Set<string>();
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('gate', 'orders', 'payments', 'ledger' as const),
        fc.constantFrom(...SIGNALS),
        fc.constantFrom(...WINDOWS),
        fc.integer({ min: 1_700_000_000_000, max: 2_000_000_000_000 }),
        async (service, signal, window, now) => {
          const urls: string[] = [];
          const client = new PromClient(BASE, (url) => {
            urls.push(url);
            return Promise.resolve(new Response(JSON.stringify({ status: 'success', data: { resultType: 'matrix', result: [] } })));
          });
          await client.range(service, signal, window, now);
          expect(urls).toHaveLength(1);
          const u = new URL(urls[0] as string);
          expect(u.origin + u.pathname).toBe(`${BASE}/api/v1/query_range`);
          expect([...u.searchParams.keys()].sort()).toEqual(['end', 'query', 'start', 'step']);
          expect(Object.values(PROMQL)).toContain(u.searchParams.get('query'));
          expect(u.searchParams.get('query')).toBe(PROMQL[signal]);
          expect(u.searchParams.get('step')).toBe(`${STEP_SECONDS[window]}s`);
          const end = Number(u.searchParams.get('end'));
          expect(end).toBe(Math.floor(now / 1000));
          expect(end - Number(u.searchParams.get('start'))).toBe(WINDOW_SECONDS[window]);
          // The service name never reaches the URL: it only selects the answer.
          expect(urls[0]).not.toContain(service);
          seen.add(u.searchParams.get('query') as string);
        },
      ),
      { numRuns: 150 },
    );
    expect(seen.size).toBeLessThanOrEqual(3);
  });

  it('keeps at most 40 points per window', () => {
    for (const w of WINDOWS) expect(WINDOW_SECONDS[w] / STEP_SECONDS[w]).toBeLessThanOrEqual(40);
    expect(rangeUrl(BASE, 'up', '5m', NOW)).toContain('step=15s');
  });

  it('uses the same PromQL as ingest-haunt-score, byte for byte', () => {
    const src = readFileSync(new URL('../../../apps/api/src/ingest/queries.ts', import.meta.url), 'utf8');
    const literal = (name: string): string => {
      const m = new RegExp(`export const ${name} =([\\s\\S]*?);\\n`).exec(src);
      if (!m) throw new Error(`missing ${name}`);
      return [...(m[1] as string).matchAll(/'([^']*)'/g)].map((x) => x[1]).join('');
    };
    expect(PROMQL.error_ratio).toBe(literal('ERROR_RATIO_QUERY'));
    expect(PROMQL.p95_ms).toBe(literal('P95_MS_QUERY'));
    expect(PROMQL.up).toBe(literal('UP_QUERY'));
  });

  it('selects the series of the service and drops non-finite points; a bad answer is metrics_unavailable', async () => {
    const answer = {
      status: 'success',
      data: { result: [{ metric: { service: 'orders' }, values: [[1, '9']] }, { metric: { service: 'payments' }, values: [[1, '0.1'], [2, 'NaN'], [3, '+Inf'], [4, '0.3']] }] },
    };
    const ok = await new PromClient(BASE, () => Promise.resolve(new Response(JSON.stringify(answer)))).range('payments', 'error_ratio', '5m', NOW);
    expect(ok).toEqual({ ok: true, points: [{ t: 1, v: 0.1 }, { t: 4, v: 0.3 }] });
    const bad = await new PromClient(BASE, () => Promise.resolve(new Response('not json'))).range('payments', 'up', '5m', NOW);
    expect(bad).toEqual({ ok: false, code: 'metrics_unavailable' });
    const down = await new PromClient(BASE, () => Promise.reject(new Error('ECONNREFUSED'))).range('payments', 'up', '5m', NOW);
    expect(down).toEqual({ ok: false, code: 'metrics_unavailable' });
  });
});
