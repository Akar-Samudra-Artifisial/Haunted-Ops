import { useEffect, useRef, useState } from 'react';
import type { HauntLevel, HuntSummary, ProposalSummary, ServiceName, ServiceState } from '@haunted-ops/shared';
import { createQueue, enqueue, release, type QueueState } from '../a11y/announcement-queue.js';
import { proposalView } from './proposal-text.js';
import { LEVEL_TEXT } from '../format.js';
import { isDark } from '../scene/model.js';
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

/**
 * Sentences for a room that went dark without its level reaching 4 (its `up` fell), and for a room that is back.
 * A change of level to 4 is already said by `levelChanges` ("payments: dark").
 */
export function darkChanges(previous: ReadonlyMap<ServiceName, ServiceState>, services: readonly ServiceState[]): string[] {
  const out: string[] = [];
  for (const s of services) {
    const before = previous.get(s.name);
    if (before === undefined) continue;
    const was = isDark(before);
    const now = isDark(s);
    if (!was && now && s.hauntLevel !== 4) out.push(`${s.name} is dark.`);
    else if (was && !now) out.push(`${s.name} is back.`);
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

export interface Announcements {
  /** Said in order, each when the queue lets it through. */
  urgent: string[];
  /** The newest Hunt step, which the step gate may delay or drop. */
  step: string | null;
}

/**
 * Every sentence for the change from one list of Services to the next: a room goes dark or is back, a Hunt starts,
 * a step, the diagnosis, a fix proposal opens, merges, deploys or fails. A Service seen for the first time is silent.
 */
export function announcementsFor(previous: readonly ServiceState[], next: readonly ServiceState[]): Announcements {
  const levels = levelChanges(new Map(previous.map((s) => [s.name, s.hauntLevel])), next);
  const dark = darkChanges(new Map(previous.map((s) => [s.name, s])), next);
  const hunts = huntSentences(new Map(previous.map((s) => [s.name, s.hunt])), next);
  const proposals = proposalSentences(new Map(previous.map((s) => [s.name, s.proposal])), next);
  return { urgent: [...levels, ...dark, ...hunts.urgent, ...proposals], step: hunts.step };
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

/** A sentence from outside the Services (connection, stale data, scene fallback); a new object is a new sentence. */
export interface Notice {
  text: string;
}
/**
 * The one live region of the page: polite and visually hidden. Sentences go through the announcement queue (no repeat
 * inside 10 s, one per 2 s, at most 5 waiting), and nothing is said for the state that was there at first load.
 */
export function LiveAnnouncer({ services, notice = null }: { services: readonly ServiceState[]; notice?: Notice | null }) {
  const previous = useRef<readonly ServiceState[]>([]);
  const gate = useRef(new StepGate());
  const queue = useRef<QueueState>(createQueue());
  const speakTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stepTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pump = useRef<() => void>(() => undefined);
  const [said, setSaid] = useState({ text: '', n: 0 });

  useEffect(() => {
    // Releases what the queue allows now and sets one timer for the next waiting sentence.
    pump.current = () => {
      if (speakTimer.current !== null) clearTimeout(speakTimer.current);
      speakTimer.current = null;
      const out = release(queue.current, Date.now());
      queue.current = out.state;
      if (out.spoken !== null) setSaid((s) => ({ text: out.spoken as string, n: s.n + 1 }));
      if (out.nextInMs !== null) speakTimer.current = setTimeout(() => pump.current(), out.nextInMs);
    };
    return () => {
      if (speakTimer.current !== null) clearTimeout(speakTimer.current);
      if (stepTimer.current !== null) clearTimeout(stepTimer.current);
      speakTimer.current = null;
      stepTimer.current = null;
    };
  }, []);

  useEffect(() => {
    const now = Date.now();
    const { urgent, step } = announcementsFor(previous.current, services);
    previous.current = services;
    const sentences = [...urgent];
    if (step !== null) {
      const said = gate.current.offer(step, now);
      if (said !== null) sentences.push(said);
      else {
        // The newest step waits; it is said when the interval has passed unless a newer one replaces it.
        if (stepTimer.current !== null) clearTimeout(stepTimer.current);
        stepTimer.current = setTimeout(() => {
          stepTimer.current = null;
          const late = gate.current.release(Date.now());
          if (late !== null) {
            queue.current = enqueue(queue.current, late, Date.now());
            pump.current();
          }
        }, gate.current.waitMs(now) ?? STEP_INTERVAL_MS);
      }
    }
    for (const text of sentences) queue.current = enqueue(queue.current, text, now);
    pump.current();
  }, [services]);

  useEffect(() => {
    if (notice === null) return;
    queue.current = enqueue(queue.current, notice.text, Date.now());
    pump.current();
  }, [notice]);
  return (
    <div className="visually-hidden" aria-live="polite" aria-atomic="true" data-testid="level-announcer">
      {/* A new key per sentence makes each one a DOM change, also when the text repeats. */}
      <span key={said.n}>{said.text}</span>
    </div>
  );
}
