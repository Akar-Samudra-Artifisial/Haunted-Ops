import { HUNT_LIMITS, type HuntTool } from '@haunted-ops/shared';
import { parseToolInput } from '@haunted-ops/exorcist-mcp/schemas';

const hhmm = (iso: string): string => {
  const m = /T(\d{2}:\d{2})/.exec(iso);
  return m ? (m[1] as string) : '';
};

const refused = (tool: HuntTool): string => `${tool} (input refused)`;

/**
 * A short line for a Step. It is built only from the tool name and the arguments after they passed
 * the same strict schema as the MCP server: enumerated values, a checked SHA, a checked time. A
 * refused input gives `<tool> (input refused)`. No other part of the model's text is ever copied.
 */
export function stepSummary(tool: HuntTool, rawInput: unknown): string {
  const text = build(tool, rawInput);
  return text.length > HUNT_LIMITS.stepSummary ? text.slice(0, HUNT_LIMITS.stepSummary) : text;
}

function build(tool: HuntTool, rawInput: unknown): string {
  switch (tool) {
    case 'query_metrics': {
      const p = parseToolInput('query_metrics', rawInput);
      return p.ok ? `metrics ${p.value.service} ${p.value.signal} ${p.value.window}` : refused(tool);
    }
    case 'search_errors': {
      const p = parseToolInput('search_errors', rawInput);
      return p.ok ? `errors ${p.value.service} since ${hhmm(p.value.since)}` : refused(tool);
    }
    case 'tail_logs': {
      const p = parseToolInput('tail_logs', rawInput);
      return p.ok ? `logs ${p.value.service} since ${hhmm(p.value.since)}` : refused(tool);
    }
    case 'recent_deploys': {
      const p = parseToolInput('recent_deploys', rawInput);
      return p.ok ? `deploys since ${hhmm(p.value.since)}` : refused(tool);
    }
    case 'diff_commit': {
      const p = parseToolInput('diff_commit', rawInput);
      return p.ok ? `diff ${p.value.sha.slice(0, 7)}` : refused(tool);
    }
    case 'submit_diagnosis': {
      const p = parseToolInput('submit_diagnosis', rawInput);
      return p.ok ? 'diagnosis submitted' : refused(tool);
    }
  }
}
