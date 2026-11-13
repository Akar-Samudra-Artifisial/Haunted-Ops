import { EVIDENCE_KINDS, SERVICE_NAMES, type HuntTool } from '@haunted-ops/shared';
import { z } from 'zod';

/**
 * Tool inputs and limits. Pure: no I/O, no clock. The API imports this module to parse the tool
 * arguments it sees in the stream with the very same rules.
 */

export const LIMITS = Object.freeze({
  /** Accepted read-tool calls per process. */
  readCalls: 12,
  limitMax: 50,
  limitDefault: 20,
  /** How far back and ahead `since` may be. */
  sinceBackMs: 6 * 60 * 60 * 1000,
  sinceAheadMs: 60 * 1000,
  deploysMax: 20,
  diffBytes: 16 * 1024,
  points: 40,
  message: 500,
  frame: 300,
  line: 2000,
  subject: 300,
  author: 200,
  ref: 200,
  requestId: 64,
  detail: 200,
  summary: 600,
  fixHint: 600,
  evidenceRef: 80,
  evidenceDetail: 300,
  evidenceMax: 10,
});

export const SIGNALS = ['error_ratio', 'p95_ms', 'up'] as const;
export type Signal = (typeof SIGNALS)[number];
export const WINDOWS = ['5m', '15m', '30m', '1h'] as const;
export type Window = (typeof WINDOWS)[number];

export const WINDOW_SECONDS: Readonly<Record<Window, number>> = Object.freeze({ '5m': 300, '15m': 900, '30m': 1800, '1h': 3600 });
/** Range step per window, so a range never has more than 40 points. */
export const STEP_SECONDS: Readonly<Record<Window, number>> = Object.freeze({ '5m': 15, '15m': 30, '30m': 60, '1h': 90 });

/**
 * The PromQL of `ingest-haunt-score` (`apps/api/src/ingest/queries.ts`), copied byte for byte; a
 * test keeps them equal. They are constants: no input text is ever put into a query.
 */
export const PROMQL: Readonly<Record<Signal, string>> = Object.freeze({
  error_ratio:
    '(sum by (service) (rate(http_requests_total{code=~"5.."}[30s]))' +
    ' or on(service) (0 * sum by (service) (rate(http_requests_total[30s]))))' +
    ' / sum by (service) (rate(http_requests_total[30s]))',
  p95_ms: '1000 * histogram_quantile(0.95, sum by (service, le) (rate(http_request_duration_seconds_bucket[30s])))',
  up: 'avg_over_time(up{job="lab"}[30s])',
});

export const SHA_PATTERN = /^[0-9a-f]{7,40}$/;
export const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

const service = z.enum(SERVICE_NAMES);
const sha = z.string().regex(SHA_PATTERN);
const since = z.string().regex(ISO_UTC_PATTERN).refine((v) => Number.isFinite(Date.parse(v)));
const limit = z.number().int().min(1).max(LIMITS.limitMax).optional();

export const INPUT_SCHEMAS = {
  query_metrics: z.strictObject({ service, signal: z.enum(SIGNALS), window: z.enum(WINDOWS) }),
  search_errors: z.strictObject({ service, since, limit }),
  tail_logs: z.strictObject({ service, since, limit }),
  recent_deploys: z.strictObject({ since }),
  diff_commit: z.strictObject({ sha }),
  submit_diagnosis: z.strictObject({
    service,
    culprit_deploy: z.string().regex(/^d-[0-9]{1,9}$/),
    culprit_sha: sha,
    summary: z.string().min(1).max(LIMITS.summary),
    evidence: z
      .array(
        z.strictObject({
          kind: z.enum(EVIDENCE_KINDS),
          ref: z.string().min(1).max(LIMITS.evidenceRef),
          detail: z.string().max(LIMITS.evidenceDetail),
        }),
      )
      .min(1)
      .max(LIMITS.evidenceMax),
    fix_hint: z.string().max(LIMITS.fixHint),
  }),
} as const satisfies Record<HuntTool, z.ZodType>;

export type ToolInputs = { [K in HuntTool]: z.infer<(typeof INPUT_SCHEMAS)[K]> };
export type SubmitDiagnosisInput = ToolInputs['submit_diagnosis'];

export type ParseResult<T> = { ok: true; value: T } | { ok: false; field: string };

/** Parses raw tool arguments. On failure, `field` is the path of the first bad field (or `$`). */
export function parseToolInput<K extends HuntTool>(tool: K, raw: unknown): ParseResult<ToolInputs[K]> {
  const r = INPUT_SCHEMAS[tool].safeParse(raw);
  if (r.success) return { ok: true, value: r.data as ToolInputs[K] };
  const issue = r.error.issues[0];
  const keys = issue?.code === 'unrecognized_keys' ? issue.keys : [];
  const path = [...(issue?.path ?? []), ...keys.slice(0, 1)];
  return { ok: false, field: path.length === 0 ? '$' : path.map(String).join('.') };
}

/** `since` must lie within 6 hours back and 1 minute ahead of `now`. */
export function sinceInRange(value: string, now: number): boolean {
  const t = Date.parse(value);
  return Number.isFinite(t) && t >= now - LIMITS.sinceBackMs && t <= now + LIMITS.sinceAheadMs;
}

/** JSON Schema of each tool input (`additionalProperties: false`), as sent in `tools/list`. */
export function inputJsonSchema(tool: HuntTool): Record<string, unknown> {
  const schema = z.toJSONSchema(INPUT_SCHEMAS[tool], { io: 'input' }) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}

export const READ_TOOLS = ['query_metrics', 'search_errors', 'tail_logs', 'recent_deploys', 'diff_commit'] as const satisfies readonly HuntTool[];
