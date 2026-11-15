/** The same sentence is not said again inside this window. */
export const REPEAT_WINDOW_MS = 10_000;
/** At most one sentence is released per this time. */
export const MIN_GAP_MS = 2_000;
/** Waiting sentences; a sixth drops the oldest. */
export const MAX_PENDING = 5;
export interface QueueState {
  readonly pending: readonly string[];
  /** Sentences queued or said lately, with the time of the last of the two. */
  readonly seen: ReadonlyArray<{ readonly text: string; readonly at: number }>;
  readonly lastSpokenAt: number | null;
}
export function createQueue(): QueueState {
  return { pending: [], seen: [], lastSpokenAt: null };
}
const fresh = (seen: QueueState['seen'], now: number): QueueState['seen'] => seen.filter((e) => now - e.at < REPEAT_WINDOW_MS);
/** Adds a sentence unless it is empty, waiting, or was queued or said less than the window ago. Pure. */
export function enqueue(state: QueueState, text: string, now: number): QueueState {
  const seen = fresh(state.seen, now);
  if (text === '' || state.pending.includes(text) || seen.some((e) => e.text === text)) return { ...state, seen };
  let pending = [...state.pending, text];
  let kept = [...seen, { text, at: now }];
  while (pending.length > MAX_PENDING) {
    const dropped = pending[0] as string;
    pending = pending.slice(1);
    // A sentence that was never said may come again.
    kept = kept.filter((e) => e.text !== dropped);
  }
  return { pending, seen: kept, lastSpokenAt: state.lastSpokenAt };
}
export interface Release {
  state: QueueState;
  spoken: string | null;
  /** Milliseconds until the next waiting sentence may be released, or null when none waits. */
  nextInMs: number | null;
}
/** Releases the oldest waiting sentence when the gap since the last one has passed. Pure. */
export function release(state: QueueState, now: number): Release {
  const seen = fresh(state.seen, now);
  if (state.pending.length === 0) return { state: { ...state, seen }, spoken: null, nextInMs: null };
  const wait = state.lastSpokenAt === null ? 0 : Math.max(0, state.lastSpokenAt + MIN_GAP_MS - now);
  if (wait > 0) return { state: { ...state, seen }, spoken: null, nextInMs: wait };
  const [head, ...rest] = state.pending as [string, ...string[]];
  return {
    state: { pending: rest, seen: [...seen.filter((e) => e.text !== head), { text: head, at: now }], lastSpokenAt: now },
    spoken: head,
    nextInMs: rest.length > 0 ? MIN_GAP_MS : null,
  };
}
