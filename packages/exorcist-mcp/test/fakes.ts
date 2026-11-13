import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ServiceName } from '@haunted-ops/shared';
import { HandleRegistry, type IssuedHandle } from '../src/handles.js';
import type { LabApi, LabDiff, LabList, LabResult } from '../src/lab-client.js';
import { Ledger, MemorySink } from '../src/ledger.js';
import type { PromApi, PromResult } from '../src/prom-client.js';
import type { ToolContext } from '../src/tools/context.js';

export const NOW = Date.parse('2026-11-13T10:45:00.000Z');
export const TOKEN = 'lab-read-token-for-tests-0123456789';
export const SHA = '65c0fca31d0df62c4bab40d2d854c81b1044c650';
export const BASE_SHA = '5cd6063f831ea45d06bfda415471e9bf4dc1322d';

/** Items in the formats of the lab design (`haunted-lab/.kiro/specs/haunted-lab/design.md:161-196`). */
export const DEPLOYS = [
  { id: 'd-101', service: 'payments', ref: 'main', sha: BASE_SHA, time: '2026-11-13T10:20:00.000Z', actor: 'supervisor' },
  { id: 'd-102', service: 'payments', ref: 'scenario/error-spike', sha: SHA, time: '2026-11-13T10:41:02.000Z', actor: 'chaos' },
];
export const ERRORS = [
  { time: '2026-11-13T10:41:10.000Z', service: 'payments', message: "TypeError: Cannot read properties of undefined (reading 'terms')", frame: 'at refundTarget (services/payments/src/refunds.ts:41:12)', requestId: 'r-1', source: 'service' },
];
export const LOGS = [{ time: '2026-11-13T10:41:11.000Z', service: 'payments', stream: 'stderr', line: 'charge failed: 500' }];
export const DIFF = {
  sha: SHA,
  subject: 'simplify refund lookup',
  author: 'Haunted Lab Bot',
  date: '2026-11-13T09:00:00.000Z',
  diff: '--- a/services/payments/src/refunds.ts\n+++ b/services/payments/src/refunds.ts\n-  if (!refund) return DEFAULT_TERMS;\n',
  truncated: false,
  bytes: 120,
};

/** In-memory LabApi. Each list can be replaced; calls are counted. */
export class FakeLab implements LabApi {
  calls = 0;
  errorItems: unknown[] = ERRORS;
  logItems: unknown[] = LOGS;
  deployItems: unknown[] = DEPLOYS;
  diffs = new Map<string, LabDiff>([[SHA, DIFF]]);
  fail: LabResult<never> | null = null;

  private list(items: unknown[]): Promise<LabResult<LabList>> {
    this.calls += 1;
    return Promise.resolve(this.fail ?? { ok: true, value: { items, truncated: false } });
  }
  errors(_s: ServiceName, _since: string, _limit: number) {
    return this.list(this.errorItems);
  }
  logs(_s: ServiceName, _since: string, _limit: number) {
    return this.list(this.logItems);
  }
  deploys(_since: string) {
    return this.list(this.deployItems);
  }
  diff(sha: string): Promise<LabResult<LabDiff>> {
    this.calls += 1;
    if (this.fail) return Promise.resolve(this.fail);
    for (const [full, d] of this.diffs) if (full.startsWith(sha)) return Promise.resolve({ ok: true, value: d });
    return Promise.resolve({ ok: false, code: 'not_found' });
  }
}

export class FakeProm implements PromApi {
  calls = 0;
  result: PromResult = {
    ok: true,
    points: Array.from({ length: 60 }, (_, i) => ({ t: NOW / 1000 - 900 + i * 15, v: i < 30 ? 0.002 : 0.31 })),
  };
  range(): Promise<PromResult> {
    this.calls += 1;
    return Promise.resolve(this.result);
  }
}

export function makeContext(over: Partial<ToolContext> = {}) {
  const sink = new MemorySink();
  const ledger = new Ledger(sink, () => NOW);
  const issued: IssuedHandle[] = [];
  const handles = new HandleRegistry((h) => {
    issued.push(h);
    ledger.handle(h);
  });
  const lab = new FakeLab();
  const prom = new FakeProm();
  const ctx: ToolContext = { lab, prom, handles, ledger, now: () => NOW, secrets: [TOKEN], ...over };
  return { ctx, lab, prom, sink, issued };
}

/** Unwraps an envelope text: checks the wrapper and parses the JSON inside. */
export function unwrap(text: string): Record<string, unknown> {
  const m = /^<untrusted_data>\n([\s\S]*)\n<\/untrusted_data>$/.exec(text);
  if (!m) throw new Error('not wrapped');
  return JSON.parse(m[1] as string) as Record<string, unknown>;
}

export interface FakeHttp {
  url: string;
  requests: Array<{ path: string; auth: string | undefined }>;
  close(): Promise<void>;
}

/** A real HTTP server on 127.0.0.1 answering like the lab and Prometheus. */
export async function startFakeBackends(handler?: (req: IncomingMessage, res: ServerResponse) => boolean): Promise<FakeHttp> {
  const requests: FakeHttp['requests'] = [];
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    requests.push({ path: `${url.pathname}${url.search}`, auth: req.headers.authorization });
    if (handler?.(req, res)) return;
    if (url.pathname.startsWith('/lab/') && req.headers.authorization !== `Bearer ${TOKEN}`) {
      return json(res, 401, { untrusted: true, error: { code: 'unauthorized', message: 'unauthorized' } });
    }
    if (url.pathname === '/lab/errors') return json(res, 200, { untrusted: true, items: ERRORS, truncated: false });
    if (url.pathname === '/lab/logs') return json(res, 200, { untrusted: true, items: LOGS, truncated: false });
    if (url.pathname === '/lab/deploys') return json(res, 200, { untrusted: true, items: DEPLOYS, truncated: false });
    const diff = /^\/lab\/commits\/([0-9a-f]{7,40})\/diff$/.exec(url.pathname);
    if (diff) {
      if (SHA.startsWith(diff[1] as string)) return json(res, 200, { untrusted: true, ...DIFF });
      return json(res, 404, { untrusted: true, error: { code: 'unknown_commit', message: 'unknown commit' } });
    }
    if (url.pathname === '/api/v1/query_range') {
      const start = Number(url.searchParams.get('start'));
      return json(res, 200, {
        status: 'success',
        data: {
          resultType: 'matrix',
          result: [
            { metric: { service: 'orders' }, values: [[start, '0.5']] },
            { metric: { service: 'payments' }, values: [[start, '0.002'], [start + 30, '0.31']] },
          ],
        },
      });
    }
    json(res, 404, { error: { code: 'not_found' } });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
