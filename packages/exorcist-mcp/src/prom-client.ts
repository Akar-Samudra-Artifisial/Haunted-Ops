import type { ServiceName } from '@haunted-ops/shared';
import { getJson, isRecord, type FetchLike } from './http.js';
import { PROMQL, STEP_SECONDS, WINDOW_SECONDS, type Signal, type Window } from './schemas.js';
import type { ErrorCode } from './untrusted.js';

export interface Point {
  t: number;
  v: number;
}

export type PromResult = { ok: true; points: Point[] } | { ok: false; code: ErrorCode };

export interface PromApi {
  range(service: ServiceName, signal: Signal, window: Window, nowMs: number): Promise<PromResult>;
}

/** The only request `query_metrics` makes: a constant template, a step from a table, times from the clock. */
export function rangeUrl(baseUrl: string, signal: Signal, window: Window, nowMs: number): string {
  const end = Math.floor(nowMs / 1000);
  const url = new URL('/api/v1/query_range', baseUrl);
  url.searchParams.set('query', PROMQL[signal]);
  url.searchParams.set('start', String(end - WINDOW_SECONDS[window]));
  url.searchParams.set('end', String(end));
  url.searchParams.set('step', `${STEP_SECONDS[window]}s`);
  return url.toString();
}

/** Prometheus range queries for one Service: the answer is selected by its `service` label. */
export class PromClient implements PromApi {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async range(service: ServiceName, signal: Signal, window: Window, nowMs: number): Promise<PromResult> {
    const r = await getJson(this.fetchImpl, rangeUrl(this.baseUrl, signal, window, nowMs), {});
    if (r.kind !== 'ok') return { ok: false, code: 'metrics_unavailable' };
    const body = r.body;
    if (!isRecord(body) || body.status !== 'success' || !isRecord(body.data) || !Array.isArray(body.data.result)) {
      return { ok: false, code: 'metrics_unavailable' };
    }
    const series = body.data.result.find((s) => isRecord(s) && isRecord(s.metric) && s.metric.service === service);
    const points: Point[] = [];
    if (isRecord(series) && Array.isArray(series.values)) {
      for (const pair of series.values) {
        if (!Array.isArray(pair) || pair.length !== 2) continue;
        const t = Number(pair[0]);
        const v = Number(pair[1]);
        if (Number.isFinite(t) && Number.isFinite(v)) points.push({ t, v });
      }
    }
    return { ok: true, points };
  }
}
