import { SERVICE_NAMES, type Sample, type ServiceName } from '@haunted-ops/shared';
import { isVectorSuccess, parseVector } from './parse.js';
import { MAX_BODY_BYTES, QUERIES, QUERY_PATH } from './queries.js';

export type PollErrorCode = 'timeout' | 'network' | 'status' | 'body' | 'too_large' | 'aborted';

/** A failed Poll. Only the code is ever logged: never the URL, a status text or a body. */
export class PollError extends Error {
  constructor(readonly code: PollErrorCode) {
    super(code);
    this.name = 'PollError';
  }
}

export type PollResult = Record<ServiceName, Sample>;

export interface PrometheusClient {
  /** Runs the three constant queries in parallel. Rejects with a PollError if any one fails. */
  poll(signal: AbortSignal): Promise<PollResult>;
}

export interface HttpPrometheusClientOptions {
  /** Origin of the Prometheus server, for example `http://127.0.0.1:9090`. */
  baseUrl: string;
  timeoutMs: number;
  fetch?: typeof fetch;
}

type QueryName = keyof typeof QUERIES;

/** Reads at most `limit` bytes of the body; throws PollError('too_large') past it. */
async function readBodyText(response: Response, limit: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => undefined);
    throw new PollError('too_large');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new PollError('body');
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new PollError('too_large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export class HttpPrometheusClient implements PrometheusClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(options: HttpPrometheusClientOptions) {
    this.baseUrl = options.baseUrl;
    this.timeoutMs = options.timeoutMs;
    this.fetchFn = options.fetch ?? fetch;
  }

  async poll(signal: AbortSignal): Promise<PollResult> {
    // One shared controller, so when one query fails the other two are cancelled.
    const inner = new AbortController();
    const names = Object.keys(QUERIES) as QueryName[];
    try {
      const maps = await Promise.all(names.map((name) => this.query(QUERIES[name], signal, inner.signal)));
      const byName = Object.fromEntries(names.map((n, i) => [n, maps[i]])) as Record<QueryName, Map<ServiceName, number>>;
      const result = {} as PollResult;
      for (const service of SERVICE_NAMES) {
        result[service] = {
          errorRate: byName.errorRate.get(service) ?? null,
          p95Ms: byName.p95Ms.get(service) ?? null,
          up: byName.up.get(service) ?? null,
        };
      }
      return result;
    } catch (err) {
      inner.abort();
      throw err instanceof PollError ? err : new PollError('network');
    }
  }

  private async query(promql: string, shutdown: AbortSignal, cancel: AbortSignal): Promise<Map<ServiceName, number>> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const url = `${new URL(QUERY_PATH, this.baseUrl).href}?query=${encodeURIComponent(promql)}`;
    try {
      const response = await this.fetchFn(url, {
        method: 'GET',
        redirect: 'error',
        headers: { accept: 'application/json' },
        signal: AbortSignal.any([timeout, shutdown, cancel]),
      });
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => undefined);
        throw new PollError('status');
      }
      const text = await readBodyText(response, MAX_BODY_BYTES);
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        throw new PollError('body');
      }
      if (!isVectorSuccess(body)) throw new PollError('body');
      return parseVector(body);
    } catch (err) {
      if (err instanceof PollError) throw err;
      if (shutdown.aborted) throw new PollError('aborted');
      if (timeout.aborted) throw new PollError('timeout');
      throw new PollError('network');
    }
  }
}
