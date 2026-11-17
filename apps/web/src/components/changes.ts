import type { HauntLevel, HuntSummary, ProposalSummary, ServiceName, ServiceState } from '@haunted-ops/shared';
import { isDark } from '../scene/model.js';
import { huntView, type HuntView } from './hunt-text.js';

/**
 * The one place that finds what changed between two lists of Services. The announcer (sentences) and the sound cues read these
 * same changes, so they cannot disagree. A Service seen for the first time has no change, and the same state twice gives none.
 */

export interface LevelChange {
  name: ServiceName;
  from: HauntLevel;
  to: HauntLevel;
}

/** Services whose level changed. */
export function levelDiffs(previous: ReadonlyMap<ServiceName, HauntLevel>, services: readonly ServiceState[]): LevelChange[] {
  const out: LevelChange[] = [];
  for (const s of services) {
    const before = previous.get(s.name);
    if (before !== undefined && before !== s.hauntLevel) out.push({ name: s.name, from: before, to: s.hauntLevel });
  }
  return out;
}

export interface DarkChange {
  name: ServiceName;
  /** The room is dark now (false: it is back). */
  dark: boolean;
  /** Its level now. */
  level: HauntLevel;
}

/** Services that went dark or came back (by `isDark`: level 4 or `up` below 0.5). */
export function darkDiffs(previous: ReadonlyMap<ServiceName, ServiceState>, services: readonly ServiceState[]): DarkChange[] {
  const out: DarkChange[] = [];
  for (const s of services) {
    const before = previous.get(s.name);
    if (before === undefined) continue;
    const was = isDark(before);
    const now = isDark(s);
    if (was !== now) out.push({ name: s.name, dark: now, level: s.hauntLevel });
  }
  return out;
}

export type HuntChange =
  | { kind: 'started'; name: ServiceName; hunt: HuntSummary; view: HuntView }
  | { kind: 'diagnosed'; name: ServiceName; hunt: HuntSummary; view: HuntView }
  | { kind: 'ended'; name: ServiceName; hunt: HuntSummary; view: HuntView }
  | { kind: 'step'; name: ServiceName; hunt: HuntSummary; view: HuntView };

/** What changed in the Hunts: one started, a diagnosis, one failed or cancelled, or a new step. In the order of the services. */
export function huntDiffs(previous: ReadonlyMap<ServiceName, HuntSummary | null>, services: readonly ServiceState[]): HuntChange[] {
  const out: HuntChange[] = [];
  for (const s of services) {
    if (!previous.has(s.name) || s.hunt === null) continue;
    const before = previous.get(s.name) ?? null;
    const same = before !== null && before.id === s.hunt.id;
    const view = huntView(s.hunt);
    const phaseBefore = same ? huntView(before).phase : 'none';
    const base = { name: s.name, hunt: s.hunt, view };
    if (view.phase === 'running' && (phaseBefore === 'none' || phaseBefore === 'queued')) out.push({ kind: 'started', ...base });
    else if (view.phase === 'sealed' && phaseBefore !== 'sealed' && view.culprit !== null) out.push({ kind: 'diagnosed', ...base });
    else if ((view.phase === 'failed' || view.phase === 'cancelled') && phaseBefore !== view.phase) out.push({ kind: 'ended', ...base });
    else if (view.phase === 'running' && same && before.stepCount < s.hunt.stepCount && view.lastTool !== null) out.push({ kind: 'step', ...base });
  }
  return out;
}

export interface ProposalChange {
  name: ServiceName;
  proposal: ProposalSummary;
  /** The status of the same proposal before, or null when it is a new proposal. */
  statusBefore: ProposalSummary['status'] | null;
}

/** Proposals that are new or changed status. */
export function proposalDiffs(previous: ReadonlyMap<ServiceName, ProposalSummary | null>, services: readonly ServiceState[]): ProposalChange[] {
  const out: ProposalChange[] = [];
  for (const s of services) {
    if (!previous.has(s.name) || s.proposal === null) continue;
    const before = previous.get(s.name) ?? null;
    if (before !== null && before.id === s.proposal.id && before.status === s.proposal.status) continue;
    out.push({ name: s.name, proposal: s.proposal, statusBefore: before !== null && before.id === s.proposal.id ? before.status : null });
  }
  return out;
}

/** All the changes between two lists of Services, from the same four detectors. */
export interface Changes {
  levels: LevelChange[];
  dark: DarkChange[];
  hunts: HuntChange[];
  proposals: ProposalChange[];
}

export function diffServices(previous: readonly ServiceState[], next: readonly ServiceState[]): Changes {
  return {
    levels: levelDiffs(new Map(previous.map((s) => [s.name, s.hauntLevel])), next),
    dark: darkDiffs(new Map(previous.map((s) => [s.name, s])), next),
    hunts: huntDiffs(new Map(previous.map((s) => [s.name, s.hunt])), next),
    proposals: proposalDiffs(new Map(previous.map((s) => [s.name, s.proposal])), next),
  };
}
