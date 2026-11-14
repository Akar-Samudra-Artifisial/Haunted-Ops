import { useEffect, useRef, useState } from 'react';
import type { HauntLevel, HuntSummary, ProposalSummary, ServiceName, ServiceState } from '@haunted-ops/shared';
import { proposalView } from './proposal-text.js';
import { LEVEL_TEXT } from '../format.js';
import { TOOL_TEXT, huntView } from './hunt-text.js';

/** Sentences for the services whose level changed. A service seen for the first time is silent. */
export function levelChanges(
  previous: ReadonlyMap<ServiceName, HauntLevel>,
  services: readonly ServiceState[],
): string[] {
  const out: string[] = [];
  for (const s of services) {
    const before = previous.get(s.name);
    if (before !== undefined && before !== s.hauntLevel) out.push(`${s.name}: ${LEVEL_TEXT[s.hauntLevel]}`);
  }
  return out;
}

export interface HuntSentences {
  /** Said at once: a Hunt started, a diagnosis, a failure. */
  urgent: string[];
  /** The newest step sentence, which the step gate may delay or drop. */
  step: string | null;
}

/**
 * What changed in the Hunts between two states, as short sentences. A Service seen for the first
 * time is silent, and the same state twice gives nothing.
 */
export function huntSentences(previous: ReadonlyMap<ServiceName, HuntSummary | null>, services: readonly ServiceState[]): HuntSentences {
  const urgent: string[] = [];
  let step: string | null = null;
  for (const s of services) {
    if (!previous.has(s.name) || s.hunt === null) continue;
    const before = previous.get(s.name) ?? null;
    const same = before !== null && before.id === s.hunt.id;
    const view = huntView(s.hunt);
    const phaseBefore = same ? huntView(before).phase : 'none';
    if (view.phase === 'running' && (phaseBefore === 'none' || phaseBefore === 'queued')) urgent.push(`Hunt started on ${s.name}.`);
    else if (view.phase === 'sealed' && phaseBefore !== 'sealed' && view.culprit !== null) {
      urgent.push(`Diagnosis for ${s.name}: deploy ${view.culprit.deploy}, commit ${view.culprit.shortSha}${view.causedBy === null ? '' : `, caused by ${view.causedBy}`}.`);
    } else if ((view.phase === 'failed' || view.phase === 'cancelled') && phaseBefore !== view.phase) {
      urgent.push(`Hunt on ${s.name} ${view.phase}${view.reasonText === null ? '' : `: ${view.reasonText}`}.`);
    } else if (view.phase === 'running' && same && before.stepCount < s.hunt.stepCount && view.lastTool !== null) {
      step = `Hunt on ${s.name}, step ${s.hunt.stepCount}: ${TOOL_TEXT[view.lastTool]}.`;
    }
  }
  return { urgent, step };
}

/** One short sentence per Proposal status change. A Service seen for the first time is silent. */
export function proposalSentences(previous: ReadonlyMap<ServiceName, ProposalSummary | null>, services: readonly ServiceState[]): string[] {
  const out: string[] = [];
  for (const s of services) {
    if (!previous.has(s.name) || s.proposal === null) continue;
    const before = previous.get(s.name) ?? null;
    if (before !== null && before.id === s.proposal.id && before.status === s.proposal.status) continue;
    out.push(proposalView(s.proposal, s.name).sentence);
  }
  return out;
}

export const STEP_INTERVAL_MS = 5_000;

/**
 * Lets one step sentence through every 5 seconds. The newest sentence wins while one waits, and a
 * sentence equal to the last one said is dropped.
 */
export class StepGate {
  private lastAt = Number.NEGATIVE_INFINITY;
  private lastText = '';
  private pending: string | null = null;

  /** Offers a sentence; returns it when it may be said now. */
  offer(text: string, now: number): string | null {
    this.pending = text;
    return this.release(now);
  }

  /** Returns the waiting sentence when its time has come. */
  release(now: number): string | null {
    if (this.pending === null || now - this.lastAt < STEP_INTERVAL_MS) return null;
    const text = this.pending;
    this.pending = null;
    if (text === this.lastText) return null;
    this.lastAt = now;
    this.lastText = text;
    return text;
  }

  /** Milliseconds until a waiting sentence may be said, or null when none waits. */
  waitMs(now: number): number | null {
    return this.pending === null ? null : Math.max(0, STEP_INTERVAL_MS - (now - this.lastAt));
  }
}

/** Visually hidden polite live region: one short sentence per level change or hunt event, nothing on first load. */
export function LiveAnnouncer({ services }: { services: readonly ServiceState[] }) {
  const previous = useRef<Map<ServiceName, HauntLevel>>(new Map());
  const previousHunts = useRef<Map<ServiceName, HuntSummary | null>>(new Map());
  const previousProposals = useRef<Map<ServiceName, ProposalSummary | null>>(new Map());
  const gate = useRef(new StepGate());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [message, setMessage] = useState('');

  useEffect(() => {
    const now = Date.now();
    const levels = levelChanges(previous.current, services);
    const sentences: string[] = [];
    previous.current = new Map(services.map((s) => [s.name, s.hauntLevel]));
    const hunts = huntSentences(previousHunts.current, services);
    previousHunts.current = new Map(services.map((s) => [s.name, s.hunt]));
    sentences.push(...hunts.urgent);
    sentences.push(...proposalSentences(previousProposals.current, services));
    previousProposals.current = new Map(services.map((s) => [s.name, s.proposal]));
    if (hunts.step !== null) {
      const said = gate.current.offer(hunts.step, now);
      if (said !== null) sentences.push(said);
      else {
        // The newest step waits; it is said when the interval has passed unless a newer one replaces it.
        if (timer.current !== null) clearTimeout(timer.current);
        timer.current = setTimeout(() => {
          timer.current = null;
          const late = gate.current.release(Date.now());
          if (late !== null) setMessage(late);
        }, gate.current.waitMs(now) ?? STEP_INTERVAL_MS);
      }
    }
    const text = [levels.join('. '), sentences.join(' ')].filter((t) => t !== '').join('. ');
    if (text !== '') setMessage(text);
  }, [services]);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  return (
    <div className="visually-hidden" aria-live="polite" aria-atomic="true" data-testid="level-announcer">
      {message}
    </div>
  );
}
