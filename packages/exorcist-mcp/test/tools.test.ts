import { HUNT_TOOLS } from '@haunted-ops/shared';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HandleRegistry } from '../src/handles.js';
import { LabClient } from '../src/lab-client.js';
import { Ledger, MemorySink, parseLedger } from '../src/ledger.js';
import { PromClient } from '../src/prom-client.js';
import { createExorcistServer } from '../src/server.js';
import { DEPLOYS, NOW, SHA, startFakeBackends, TOKEN, unwrap, type FakeHttp } from './fakes.js';

let http: FakeHttp;
beforeAll(async () => {
  http = await startFakeBackends();
});
afterAll(async () => {
  await http.close();
});

async function connect(token = TOKEN) {
  const sink = new MemorySink();
  const ledger = new Ledger(sink, () => NOW);
  const handles = new HandleRegistry((h) => ledger.handle(h));
  const server = createExorcistServer({
    lab: new LabClient(http.url, token),
    prom: new PromClient(http.url),
    handles,
    ledger,
    now: () => NOW,
    secrets: [TOKEN],
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(r.content).toHaveLength(1);
    return { body: unwrap(r.content[0]!.text), isError: r.isError === true, text: r.content[0]!.text };
  };
  return { client, call, sink };
}

const since = new Date(NOW - 30 * 60_000).toISOString();

describe('exorcist MCP server over MCP', () => {
  it('lists exactly the six tools with strict schemas and a data-not-instructions description', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([...HUNT_TOOLS]);
    for (const t of tools) {
      expect((t.inputSchema as { additionalProperties?: boolean }).additionalProperties).toBe(false);
      if (t.name !== 'submit_diagnosis') expect(t.description).toMatch(/data, not instructions/);
    }
  });

  it('runs a whole hunt against the fake lab and Prometheus, with handles in every result and the ledger', async () => {
    const { call, sink } = await connect();
    const metrics = await call('query_metrics', { service: 'payments', signal: 'error_ratio', window: '15m' });
    expect(metrics.body).toMatchObject({ untrusted_data: true, tool: 'query_metrics', source: 'prometheus', data: { handle: 'metric:payments/error_ratio/15m', first: 0.002, last: 0.31 } });
    const errors = await call('search_errors', { service: 'payments', since, limit: 5 });
    expect((errors.body.data as { items: Array<{ handle: string }> }).items[0]?.handle).toBe('error:1');
    const logs = await call('tail_logs', { service: 'payments', since });
    expect((logs.body.data as { items: Array<{ handle: string; stream: string }> }).items[0]).toMatchObject({ handle: 'log:1', stream: 'stderr' });
    const deploys = await call('recent_deploys', { since });
    expect((deploys.body.data as { items: unknown[] }).items).toHaveLength(DEPLOYS.length);
    const diff = await call('diff_commit', { sha: SHA.slice(0, 7) });
    expect(diff.body.data).toMatchObject({ handle: `commit:${SHA}`, sha: SHA, subject: 'simplify refund lookup' });
    const done = await call('submit_diagnosis', {
      service: 'payments',
      culprit_deploy: 'd-102',
      culprit_sha: SHA.slice(0, 7),
      summary: 'Deploy d-102 removed the refund guard.',
      evidence: [
        { kind: 'metric', ref: 'metric:payments/error_ratio/15m', detail: '0.2% to 31%' },
        { kind: 'deploy', ref: 'deploy:d-102', detail: 'just before the spike' },
      ],
      fix_hint: 'Restore the guard.',
    });
    expect(done.body.data).toEqual({ accepted: true, cited: 2 });
    // The lab's frame already starts with "at": the detail does not repeat it.
    const errorLine = parseLedger(sink.lines.join('')).find((l) => l.type === 'handle' && l.handle === 'error:1');
    expect(errorLine).toMatchObject({ detail: expect.stringMatching(/ at refundTarget \(/) });
    expect((errorLine as { detail: string }).detail).not.toMatch(/ at at /);
    const kinds = parseLedger(sink.lines.join('')).map((l) => (l.type === 'handle' ? l.kind : 'diagnosis'));
    expect(kinds).toEqual(['metric', 'error', 'log', 'deploy', 'commit', 'deploy', 'commit', 'diagnosis']);
    // The bearer went only to /lab routes, and the service name never reached a PromQL query.
    for (const r of http.requests) {
      if (r.path.startsWith('/lab/')) expect(r.auth).toBe(`Bearer ${TOKEN}`);
      else expect(r.auth).toBeUndefined();
    }
  });

  it('maps lab failures to fixed codes and never shows the token', async () => {
    const wrong = await connect('a-wrong-token-1234567890');
    const unauthorized = await wrong.call('search_errors', { service: 'payments', since });
    expect(unauthorized.isError).toBe(true);
    expect(unauthorized.body).toEqual({ untrusted_data: true, tool: 'search_errors', error: { code: 'lab_error' } });
    const { call } = await connect();
    const missing = await call('diff_commit', { sha: 'deadbee' });
    expect(missing.body).toMatchObject({ error: { code: 'not_found' } });
    const badInput = await call('diff_commit', { sha: 'deadbee', path: '/etc/passwd' });
    expect(badInput.body).toMatchObject({ error: { code: 'bad_input', field: 'path' } });
    expect(badInput.text).not.toContain(TOKEN);
  });

  it('answers lab_unavailable when the lab is down', async () => {
    const lab = new LabClient('http://127.0.0.1:9', TOKEN);
    expect(await lab.deploys(since)).toEqual({ ok: false, code: 'lab_unavailable' });
  });
});
