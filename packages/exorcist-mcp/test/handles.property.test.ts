import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { HandleRegistry, type HandleKey } from '../src/handles.js';
import { Ledger, MemorySink, parseLedger } from '../src/ledger.js';
import { CallLimits, callTool } from '../src/server.js';
import { makeContext, NOW, SHA } from './fakes.js';

const keyArb: fc.Arbitrary<HandleKey> = fc.oneof(
  fc.record({ kind: fc.constant('error' as const) }),
  fc.record({ kind: fc.constant('log' as const) }),
  fc.record({ kind: fc.constant('deploy' as const), deployId: fc.integer({ min: 1, max: 30 }).map((n) => `d-${n}`) }),
  fc.record({ kind: fc.constant('commit' as const), sha: fc.constantFrom(SHA, 'a'.repeat(40), 'b'.repeat(40)) }),
  fc.record({
    kind: fc.constant('metric' as const),
    service: fc.constantFrom('gate', 'payments' as const),
    signal: fc.constantFrom('error_ratio', 'up' as const),
    window: fc.constantFrom('5m', '1h' as const),
  }),
);

const diagnosis = {
  service: 'payments' as const,
  culprit_deploy: 'd-102',
  culprit_sha: SHA,
  summary: 'guard removed',
  evidence: [{ kind: 'deploy' as const, ref: 'deploy:d-102', detail: 'the deploy' }],
  fix_hint: 'restore it',
};

// Feature: exorcist-agent, Property 7
describe('Property 7: Evidence handles are unique and logged', () => {
  it('issues each handle once, with its kind, logged once and parsed back in issue order', () => {
    fc.assert(
      fc.property(fc.array(keyArb, { maxLength: 80 }), (keys) => {
        const sink = new MemorySink();
        const ledger = new Ledger(sink, () => NOW);
        const reg = new HandleRegistry((h) => ledger.handle(h));
        const returned: string[] = [];
        for (const key of keys) returned.push(reg.issue(key, { tool: 'search_errors', service: null, deployId: null, sha: null, detail: 'd' }).handle);
        const all = reg.all();
        expect(new Set(all.map((h) => h.handle)).size).toBe(all.length);
        for (const h of all) expect(h.handle.startsWith(`${h.kind}:`)).toBe(true);
        const lines = parseLedger(sink.lines.join(''));
        expect(lines.map((l) => (l.type === 'handle' ? l.handle : '?'))).toEqual(all.map((h) => h.handle));
        expect(lines.map((l) => l.seq)).toEqual(lines.map((_, i) => i + 1));
        // Every returned handle is one of the logged ones; repeats of a deploy, commit or metric reuse it.
        for (const r of returned) expect(reg.has(r)).toBe(true);
        const errors = keys.filter((k) => k.kind === 'error').length;
        expect(all.filter((h) => h.kind === 'error').map((h) => h.handle)).toEqual(Array.from({ length: errors }, (_, i) => `error:${i + 1}`));
      }),
      { numRuns: 200 },
    );
  });

  it('logs the handles of real tool results and one diagnosis; a second one is already_submitted and writes nothing', async () => {
    const { ctx, sink } = makeContext();
    const limits = new CallLimits();
    await callTool('recent_deploys', { since: new Date(NOW - 3_600_000).toISOString() }, ctx, limits);
    await callTool('diff_commit', { sha: SHA.slice(0, 7) }, ctx, limits);
    await callTool('search_errors', { service: 'payments', since: new Date(NOW - 600_000).toISOString() }, ctx, limits);
    const first = await callTool('submit_diagnosis', diagnosis, ctx, limits);
    expect(first.isError).toBe(false);
    const before = sink.lines.length;
    const second = await callTool('submit_diagnosis', diagnosis, ctx, limits);
    expect(second.isError).toBe(true);
    expect(second.text).toContain('already_submitted');
    expect(sink.lines.length).toBe(before);
    const lines = parseLedger(sink.lines.join('') + 'torn line {\n');
    const handles = lines.flatMap((l) => (l.type === 'handle' ? [l.handle] : []));
    expect(handles).toEqual(['deploy:d-101', `commit:5cd6063f831ea45d06bfda415471e9bf4dc1322d`, 'deploy:d-102', `commit:${SHA}`, 'error:1']);
    const deploy = lines.find((l) => l.type === 'handle' && l.handle === 'deploy:d-102');
    expect(deploy).toMatchObject({ kind: 'deploy', service: 'payments', deployId: 'd-102', sha: SHA, tool: 'recent_deploys' });
    expect(lines.at(-1)).toMatchObject({ type: 'diagnosis', input: diagnosis });
  });

  it('refuses an invalid diagnosis without writing it', async () => {
    const { ctx, sink } = makeContext();
    const limits = new CallLimits();
    const bad = await callTool('submit_diagnosis', { ...diagnosis, culprit_sha: 'HEAD' }, ctx, limits);
    expect(bad.isError).toBe(true);
    expect(sink.lines).toHaveLength(0);
    expect((await callTool('submit_diagnosis', { ...diagnosis, evidence: [] }, ctx, limits)).isError).toBe(true);
    expect((await callTool('submit_diagnosis', { ...diagnosis, summary: 'x'.repeat(601) }, ctx, limits)).isError).toBe(true);
    expect((await callTool('submit_diagnosis', diagnosis, ctx, limits)).isError).toBe(false);
  });
});
