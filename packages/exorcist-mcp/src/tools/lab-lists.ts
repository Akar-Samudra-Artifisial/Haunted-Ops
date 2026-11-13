import { SERVICE_NAMES, type ServiceName } from '@haunted-ops/shared';
import { isRecord } from '../http.js';
import { LIMITS, type ToolInputs } from '../schemas.js';
import { clean, envelope, errorEnvelope, shrinkList } from '../untrusted.js';
import { clock, DEPLOY_ID, FULL_SHA, short, type ToolRun } from './context.js';

const serviceOf = (v: unknown): ServiceName | null => ((SERVICE_NAMES as readonly unknown[]).includes(v) ? (v as ServiceName) : null);
const iso = (v: unknown): string => clean(v, 40);

/** Newest `max` items, oldest first. The lab answers oldest first, newest last. */
const newest = <T>(items: readonly T[], max: number): { items: T[]; cut: boolean } =>
  items.length <= max ? { items: [...items], cut: false } : { items: items.slice(items.length - max), cut: true };

export const searchErrors: ToolRun<ToolInputs['search_errors']> = async (input, ctx) => {
  const limit = input.limit ?? LIMITS.limitDefault;
  const r = await ctx.lab.errors(input.service, input.since, limit);
  if (!r.ok) return errorEnvelope('search_errors', r.code);
  const picked = newest(r.value.items.filter(isRecord), limit);
  const items = picked.items.map((it) => {
    const message = clean(it.message, LIMITS.message);
    const frame = clean(it.frame, LIMITS.frame);
    const { handle } = ctx.handles.issue(
      { kind: 'error' },
      { tool: 'search_errors', service: input.service, deployId: null, sha: null, detail: clean(`${clock(iso(it.time))} ${message}${frame ? ` ${/^at\s/.test(frame) ? frame : `at ${frame}`}` : ''}`, LIMITS.detail) },
    );
    return {
      handle,
      time: iso(it.time),
      message,
      frame,
      requestId: clean(it.requestId, LIMITS.requestId),
      source: it.source === 'supervisor' ? 'supervisor' : 'service',
    };
  });
  return envelope('search_errors', 'lab', { items }, picked.cut || r.value.truncated, shrinkList('items'), ctx.secrets);
};

export const tailLogs: ToolRun<ToolInputs['tail_logs']> = async (input, ctx) => {
  const limit = input.limit ?? LIMITS.limitDefault;
  const r = await ctx.lab.logs(input.service, input.since, limit);
  if (!r.ok) return errorEnvelope('tail_logs', r.code);
  const picked = newest(r.value.items.filter(isRecord), limit);
  const items = picked.items.map((it) => {
    const line = clean(it.line, LIMITS.line);
    const { handle } = ctx.handles.issue(
      { kind: 'log' },
      { tool: 'tail_logs', service: input.service, deployId: null, sha: null, detail: clean(`${clock(iso(it.time))} ${line}`, LIMITS.detail) },
    );
    return { handle, time: iso(it.time), stream: it.stream === 'stderr' ? 'stderr' : 'stdout', line };
  });
  return envelope('tail_logs', 'lab', { items }, picked.cut || r.value.truncated, shrinkList('items'), ctx.secrets);
};

export const recentDeploys: ToolRun<ToolInputs['recent_deploys']> = async (input, ctx) => {
  const r = await ctx.lab.deploys(input.since);
  if (!r.ok) return errorEnvelope('recent_deploys', r.code);
  // Only well-formed records: a deploy id, a known service and a full SHA.
  const valid = r.value.items.filter(
    (it): it is Record<string, unknown> =>
      isRecord(it) && typeof it.id === 'string' && DEPLOY_ID.test(it.id) && serviceOf(it.service) !== null && typeof it.sha === 'string' && FULL_SHA.test(it.sha),
  );
  const picked = newest(valid, LIMITS.deploysMax);
  const items = picked.items.map((it) => {
    const id = it.id as string;
    const sha = it.sha as string;
    const service = serviceOf(it.service);
    const ref = clean(it.ref, LIMITS.ref);
    const time = iso(it.time);
    const { handle } = ctx.handles.issue(
      { kind: 'deploy', deployId: id },
      { tool: 'recent_deploys', service, deployId: id, sha, detail: clean(`${id} ${service ?? '?'} ${ref} ${short(sha)} ${clock(time)}`, LIMITS.detail) },
    );
    const commit = ctx.handles.issue(
      { kind: 'commit', sha },
      { tool: 'recent_deploys', service, deployId: id, sha, detail: clean(`commit ${short(sha)} deployed as ${id}`, LIMITS.detail) },
    );
    return { handle, commitHandle: commit.handle, id, service, ref, sha, time, actor: clean(it.actor, 20) };
  });
  return envelope('recent_deploys', 'lab', { items }, picked.cut || r.value.truncated, shrinkList('items'), ctx.secrets);
};
