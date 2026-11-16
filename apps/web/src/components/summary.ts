import { isActiveProposalStatus, type HauntLevel, type ServiceState } from '@haunted-ops/shared';
import { LEVEL_TEXT } from '../format.js';
import { hauntMark } from '../a11y/status-marks.js';
export interface LevelCount {
  level: HauntLevel;
  count: number;
  /** The word of the level ("haunted"). */
  word: string;
  /** The mark of the level; hidden from screen readers where it is drawn. */
  symbol: string;
}
export interface Summary {
  /** Levels with at least one service, worst first. */
  counts: LevelCount[];
  /** "Hunt running · 5 steps", "Diagnosed", "Fix proposed", "Fix merged", or null when there is no hunt to speak of. */
  huntState: string | null;
  /** The hunt state is a running Hunt (the pill pulses). */
  running: boolean;
}
const WORST_FIRST: readonly HauntLevel[] = [4, 3, 2, 1, 0];
/** The Service whose Hunt the summary speaks of: a running Hunt, a queued one, a Proposal, then a diagnosis. */
export function huntedService(services: readonly ServiceState[]): ServiceState | null {
  return (
    services.find((s) => s.hunt?.status === 'running') ??
    services.find((s) => s.hunt?.status === 'queued') ??
    services.find((s) => s.proposal !== null && (isActiveProposalStatus(s.proposal.status) || s.proposal.status === 'deployed')) ??
    services.find((s) => s.hunt?.diagnosis !== null && s.hunt?.diagnosis !== undefined) ??
    null
  );
}
function huntStateOf(s: ServiceState): string | null {
  const hunt = s.hunt;
  if (hunt?.status === 'running') return `Hunt running · ${hunt.stepCount} ${hunt.stepCount === 1 ? 'step' : 'steps'}`;
  if (hunt?.status === 'queued') return 'Hunt queued';
  if (s.proposal?.status === 'open') return 'Fix proposed';
  if (s.proposal?.status === 'merged' || s.proposal?.status === 'deployed') return 'Fix merged';
  if (hunt?.diagnosis) return 'Diagnosed';
  return null;
}
/** Pure and total: the counts come from the same `services` the table reads, so they add up to its length. */
export function summarize(services: readonly ServiceState[]): Summary {
  const counts: LevelCount[] = [];
  for (const level of WORST_FIRST) {
    const count = services.filter((s) => s.hauntLevel === level).length;
    if (count > 0) counts.push({ level, count, word: LEVEL_TEXT[level], symbol: hauntMark(level).symbol });
  }
  const hunted = huntedService(services);
  const huntState = hunted === null ? null : huntStateOf(hunted);
  return { counts, huntState, running: hunted?.hunt?.status === 'running' };
}
