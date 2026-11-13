import fc from 'fast-check';
import { HUNT_TOOLS } from '@haunted-ops/shared';
import { describe, expect, it } from 'vitest';
import { inputJsonSchema, LIMITS, parseToolInput, READ_TOOLS, sinceInRange } from '../src/schemas.js';
import { CallLimits, callTool } from '../src/server.js';
import { makeContext, NOW, SHA, unwrap } from './fakes.js';

const RUNS = { numRuns: 150 };
const sinceOk = new Date(NOW - 60_000).toISOString();

/** Any JSON value, plus near-misses of valid inputs. */
const anyValue = fc.jsonValue();
const nearMiss = fc.record(
  {
    service: fc.oneof(fc.constantFrom('payments', 'ledger', 'cellar', 'PAYMENTS', ''), fc.string()),
    since: fc.oneof(
      fc.constant(sinceOk),
      fc.constantFrom('yesterday', '2026-11-13T10:44:00Z', '2026-11-13 10:44:00Z', new Date(NOW - 7 * 3_600_000).toISOString(), new Date(NOW + 120_000).toISOString()),
    ),
    limit: fc.oneof(fc.integer({ min: -5, max: 60 }), fc.double(), fc.constant('5')),
    signal: fc.constantFrom('error_ratio', 'p95_ms', 'up', 'cpu'),
    window: fc.constantFrom('5m', '15m', '30m', '1h', '2h', '1d'),
    sha: fc.oneof(fc.constant(SHA), fc.constant(SHA.slice(0, 7)), fc.constantFrom('65c0fc', SHA.toUpperCase(), `${SHA}0`, '../../etc', 'HEAD')),
    extra: fc.constant(1),
  },
  { requiredKeys: [] },
);

function expectedValid(tool: string, input: unknown): boolean {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return false;
  const i = input as Record<string, unknown>;
  const allowed: Record<string, string[]> = {
    query_metrics: ['service', 'signal', 'window'],
    search_errors: ['service', 'since', 'limit'],
    tail_logs: ['service', 'since', 'limit'],
    recent_deploys: ['since'],
    diff_commit: ['sha'],
  };
  const keys = Object.keys(i);
  if (keys.some((k) => !allowed[tool]!.includes(k))) return false;
  const svc = ['gate', 'orders', 'payments', 'ledger'].includes(i.service as string);
  const since = typeof i.since === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(i.since) && sinceInRange(i.since, NOW);
  const limit = i.limit === undefined || (Number.isInteger(i.limit) && (i.limit as number) >= 1 && (i.limit as number) <= 50);
  switch (tool) {
    case 'query_metrics':
      return svc && ['error_ratio', 'p95_ms', 'up'].includes(i.signal as string) && ['5m', '15m', '30m', '1h'].includes(i.window as string);
    case 'search_errors':
    case 'tail_logs':
      return svc && since && limit;
    case 'recent_deploys':
      return since;
    case 'diff_commit':
      return typeof i.sha === 'string' && /^[0-9a-f]{7,40}$/.test(i.sha);
  }
  return false;
}

// Feature: exorcist-agent, Property 5
describe('Property 5: tool inputs outside the bounds are rejected', () => {
  it('accepts exactly the valid inputs, calls the backend once per accepted call, and never throws', async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...READ_TOOLS), fc.oneof(anyValue, nearMiss), async (tool, input) => {
        const { ctx, lab, prom } = makeContext();
        const res = await callTool(tool, input, ctx, new CallLimits());
        const calls = lab.calls + prom.calls;
        const body = unwrap(res.text) as { error?: { code: string; field?: string } };
        if (expectedValid(tool, input)) {
          expect(body.error?.code).not.toBe('bad_input');
          expect(calls).toBe(1);
        } else {
          expect(res.isError).toBe(true);
          expect(body.error?.code).toBe('bad_input');
          expect(typeof body.error?.field).toBe('string');
          expect(calls).toBe(0);
        }
      }),
      RUNS,
    );
  });

  it('answers call_limit after 12 accepted read calls, and still takes one diagnosis', async () => {
    const { ctx, lab } = makeContext();
    const limits = new CallLimits();
    for (let i = 0; i < LIMITS.readCalls; i++) {
      const r = await callTool('recent_deploys', { since: sinceOk }, ctx, limits);
      expect(r.isError).toBe(false);
    }
    for (const tool of READ_TOOLS) {
      const r = await callTool(tool, { since: sinceOk }, ctx, limits);
      expect((unwrap(r.text) as { error: { code: string } }).error.code).toBe('call_limit');
    }
    expect(lab.calls).toBe(LIMITS.readCalls);
    const ok = await callTool(
      'submit_diagnosis',
      { service: 'payments', culprit_deploy: 'd-102', culprit_sha: SHA, summary: 'guard removed', evidence: [{ kind: 'deploy', ref: 'deploy:d-102', detail: 'x' }], fix_hint: '' },
      ctx,
      limits,
    );
    expect(ok.isError).toBe(false);
  });

  it('refuses unknown tools and unknown fields, and names the field', () => {
    expect(parseToolInput('diff_commit', { sha: SHA, path: '/etc' })).toEqual({ ok: false, field: 'path' });
    expect(parseToolInput('search_errors', { service: 'payments', since: sinceOk, limit: 0 })).toEqual({ ok: false, field: 'limit' });
    expect(parseToolInput('query_metrics', null)).toEqual({ ok: false, field: '$' });
  });

  it('publishes strict JSON Schemas for all six tools', () => {
    for (const tool of HUNT_TOOLS) {
      const s = inputJsonSchema(tool);
      expect(s.type).toBe('object');
      expect(s.additionalProperties).toBe(false);
    }
    const evidence = (inputJsonSchema('submit_diagnosis').properties as Record<string, { items: { additionalProperties: boolean } }>).evidence;
    expect(evidence?.items.additionalProperties).toBe(false);
  });
});
