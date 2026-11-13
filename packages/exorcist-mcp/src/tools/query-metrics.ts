import { LIMITS, STEP_SECONDS, type ToolInputs } from '../schemas.js';
import { envelope, errorEnvelope, shrinkList } from '../untrusted.js';
import type { ToolRun } from './context.js';

const round = (v: number): number => Number(v.toPrecision(4));

/** Keeps at most `max` points, evenly spaced, always including the last one. */
function thin<T>(points: readonly T[], max: number): T[] {
  if (points.length <= max) return [...points];
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(points[Math.round((i * (points.length - 1)) / (max - 1))] as T);
  return out;
}

export const queryMetrics: ToolRun<ToolInputs['query_metrics']> = async (input, ctx) => {
  const r = await ctx.prom.range(input.service, input.signal, input.window, ctx.now());
  if (!r.ok) return errorEnvelope('query_metrics', r.code);
  const points = thin(r.points, LIMITS.points).map((p) => ({ t: new Date(p.t * 1000).toISOString(), v: round(p.v) }));
  const values = r.points.map((p) => p.v);
  const stat = (f: (a: number[]) => number): number | null => (values.length === 0 ? null : round(f(values)));
  const first = stat((a) => a[0] as number);
  const last = stat((a) => a[a.length - 1] as number);
  const min = stat((a) => Math.min(...a));
  const max = stat((a) => Math.max(...a));
  const { handle } = ctx.handles.issue(
    { kind: 'metric', service: input.service, signal: input.signal, window: input.window },
    {
      tool: 'query_metrics',
      service: input.service,
      deployId: null,
      sha: null,
      detail:
        first === null
          ? `${input.service} ${input.signal} ${input.window}: no data`
          : `${input.service} ${input.signal} ${input.window}: ${first} -> ${last} (min ${min}, max ${max})`,
    },
  );
  const data = {
    handle,
    service: input.service,
    signal: input.signal,
    window: input.window,
    step: `${STEP_SECONDS[input.window]}s`,
    points,
    first,
    last,
    min,
    max,
  };
  return envelope('query_metrics', 'prometheus', data, r.points.length > LIMITS.points, shrinkList('points'), ctx.secrets);
};
