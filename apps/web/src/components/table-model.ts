import type { ServiceState } from '@haunted-ops/shared';
import { LEVEL_TEXT, formatErrorRatio, formatIncident, formatP95, formatReason, formatUp } from '../format.js';
import { isDark } from '../scene/model.js';

/** What one row of Table mode says, as text. The scene model is checked against it. */
export interface TableRowText {
  name: string;
  level: string;
  reason: string;
  errorRatio: string;
  p95: string;
  up: string;
  incident: string;
  dark: boolean;
}

/**
 * The Haunt level cell: "4 (dark)", or "2 (haunted), room dark" when only `isDark` is true (for example
 * when `up` is 0 and the level has not caught up). The scene uses the same `isDark`.
 */
export function levelCellText(service: Pick<ServiceState, 'hauntLevel' | 'metrics'>): string {
  const base = `${service.hauntLevel} (${LEVEL_TEXT[service.hauntLevel]})`;
  return isDark(service) && service.hauntLevel < 4 ? `${base}, room dark` : base;
}

export function tableRowText(s: ServiceState): TableRowText {
  return {
    name: s.name,
    level: levelCellText(s),
    reason: formatReason(s.reason, s.metrics),
    errorRatio: formatErrorRatio(s.metrics?.errorRate ?? null),
    p95: formatP95(s.metrics?.p95Ms ?? null),
    up: formatUp(s.metrics?.up ?? null),
    incident: formatIncident(s.openIncident),
    dark: isDark(s),
  };
}
