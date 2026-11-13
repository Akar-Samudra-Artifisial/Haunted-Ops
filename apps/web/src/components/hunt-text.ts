import { shortSha, type HuntEndReason, type HuntSummary, type HuntTool, type ServiceName } from '@haunted-ops/shared';

/** What a Service's latest Hunt looks like to a reader. The Scene label and the table cell both come from here. */
export type HuntPhase = 'none' | 'queued' | 'running' | 'sealed' | 'failed' | 'cancelled';

export interface HuntView {
  phase: HuntPhase;
  stepCount: number;
  lastTool: HuntTool | null;
  culprit: { deploy: string; shortSha: string; service: ServiceName } | null;
  /** The Service the culprit deploy belongs to when it is not the hunted one (a fault downstream), else null. */
  causedBy: ServiceName | null;
  /** Words for why a Hunt failed or was cancelled; null otherwise. */
  reasonText: string | null;
}

export const NO_HUNT: HuntView = Object.freeze({ phase: 'none', stepCount: 0, lastTool: null, culprit: null, causedBy: null, reasonText: null });

export const REASON_TEXT: Readonly<Record<HuntEndReason, string>> = Object.freeze({
  diagnosed: 'diagnosis found',
  invalid_diagnosis: 'diagnosis rejected',
  no_diagnosis: 'no diagnosis',
  foreign_tool: 'blocked tool call',
  credit_cap: 'credit cap reached',
  daily_cap: 'daily credit cap reached',
  tool_limit: 'tool call limit reached',
  timeout: 'timed out',
  mcp_startup: 'tools did not start',
  cli_error: 'agent error',
  stream_error: 'bad agent output',
  busy: 'another hunt is running',
  cooldown: 'cooling down',
  disabled: 'hunts are off',
  incident_closed: 'incident closed',
  shutdown: 'server stopped',
  api_restart: 'server restarted',
  downstream: 'a service downstream is hunted instead',
  diagnosed_upstream: 'diagnosed by another hunt',
  daily_limit: 'daily hunt limit reached',
});

/** Short names of the tools, as the table and the announcements say them. */
export const TOOL_TEXT: Readonly<Record<HuntTool, string>> = Object.freeze({
  query_metrics: 'metrics',
  search_errors: 'errors',
  tail_logs: 'logs',
  recent_deploys: 'deploys',
  diff_commit: 'diff',
  submit_diagnosis: 'diagnosis',
});

/** The words for why a Hunt failed or was cancelled; a withdrawn Hunt names the Service whose Hunt diagnosed it. */
function reasonText(hunt: HuntSummary): string | null {
  if (hunt.reason === null) return null;
  if (hunt.reason === 'diagnosed_upstream' && hunt.diagnosedBy !== null) return `diagnosed by the ${hunt.diagnosedBy} hunt`;
  return REASON_TEXT[hunt.reason];
}

/** The view of a Hunt summary. Pure: the same summary always gives the same view. */
export function huntView(hunt: HuntSummary | null): HuntView {
  if (hunt === null) return NO_HUNT;
  const lastTool = hunt.steps.at(-1)?.tool ?? null;
  const base = { stepCount: hunt.stepCount, lastTool };
  switch (hunt.status) {
    case 'queued':
      return { ...base, phase: 'queued', culprit: null, causedBy: null, reasonText: null };
    case 'running':
      return { ...base, phase: 'running', culprit: null, causedBy: null, reasonText: null };
    case 'succeeded':
      if (hunt.diagnosis !== null) {
        return {
          ...base,
          phase: 'sealed',
          culprit: { deploy: hunt.diagnosis.culpritDeploy, shortSha: shortSha(hunt.diagnosis.culpritSha), service: hunt.diagnosis.culpritService },
          causedBy: hunt.diagnosis.culpritService === hunt.service ? null : hunt.diagnosis.culpritService,
          reasonText: null,
        };
      }
      return { ...base, phase: 'failed', culprit: null, causedBy: null, reasonText: REASON_TEXT.no_diagnosis };
    case 'failed':
    case 'cancelled':
      return { ...base, phase: hunt.status, culprit: null, causedBy: null, reasonText: reasonText(hunt) };
  }
}

/** `running: step 3, errors`, `sealed: d-7, 65c0fca`, `failed: credit cap reached`. */
export function huntCellText(view: HuntView): string {
  switch (view.phase) {
    case 'none':
      return 'none';
    case 'queued':
      return 'queued';
    case 'running':
      return view.stepCount === 0 || view.lastTool === null ? 'running: starting' : `running: step ${view.stepCount}, ${TOOL_TEXT[view.lastTool]}`;
    case 'sealed':
      if (view.culprit === null) return 'sealed';
      return `sealed: ${view.culprit.deploy}, ${view.culprit.shortSha}${view.causedBy === null ? '' : `, caused by ${view.causedBy}`}`;
    case 'failed':
    case 'cancelled':
      return view.reasonText === null ? view.phase : `${view.phase}: ${view.reasonText}`;
  }
}

/** The text of one Step in the ordered list. */
export function huntStepText(step: { index: number; summary: string }): string {
  return `step ${step.index}: ${step.summary}`;
}
