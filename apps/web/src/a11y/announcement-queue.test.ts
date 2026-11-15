import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MAX_PENDING, MIN_GAP_MS, REPEAT_WINDOW_MS, createQueue, enqueue, release, type QueueState } from './announcement-queue.js';

describe('announcement queue', () => {
  it('releases the first sentence at once and the next one after the gap', () => {
    let q = enqueue(createQueue(), 'a', 0);
    q = enqueue(q, 'b', 0);
    const first = release(q, 0);
    expect(first.spoken).toBe('a');
    expect(first.nextInMs).toBe(MIN_GAP_MS);
    const early = release(first.state, 500);
    expect(early.spoken).toBeNull();
    expect(early.nextInMs).toBe(MIN_GAP_MS - 500);
    const second = release(early.state, MIN_GAP_MS);
    expect(second.spoken).toBe('b');
    expect(second.nextInMs).toBeNull();
  });
  it('speaks a burst of equal sentences once', () => {
    let q = createQueue();
    for (let i = 0; i < 10; i++) q = enqueue(q, 'same', i * 10);
    expect(q.pending).toEqual(['same']);
    const out = release(q, 100);
    expect(out.spoken).toBe('same');
    expect(enqueue(out.state, 'same', 5_000).pending).toEqual([]);
  });
  it('allows the same sentence again once the window has passed', () => {
    let q = release(enqueue(createQueue(), 'x', 0), 0).state;
    expect(enqueue(q, 'x', REPEAT_WINDOW_MS - 1).pending).toEqual([]);
    q = enqueue(q, 'x', REPEAT_WINDOW_MS);
    expect(q.pending).toEqual(['x']);
  });
  it('keeps at most five waiting and drops the oldest', () => {
    let q = createQueue();
    for (let i = 1; i <= 6; i++) q = enqueue(q, `s${i}`, 0);
    expect(q.pending).toEqual(['s2', 's3', 's4', 's5', 's6']);
    expect(q.pending).toHaveLength(MAX_PENDING);
    // The dropped sentence was never said, so it may come again.
    expect(enqueue(q, 's1', 1).pending.at(-1)).toBe('s1');
  });
  it('ignores empty text, reports nothing for an empty queue, and does not mutate its input', () => {
    const q = createQueue();
    expect(enqueue(q, '', 0).pending).toEqual([]);
    expect(release(q, 0)).toMatchObject({ spoken: null, nextInMs: null });
    const frozen: QueueState = Object.freeze({ pending: Object.freeze(['a']) as readonly string[], seen: Object.freeze([]) as QueueState['seen'], lastSpokenAt: null });
    expect(() => release(frozen, 0)).not.toThrow();
    expect(() => enqueue(frozen, 'b', 0)).not.toThrow();
    expect(frozen.pending).toEqual(['a']);
  });
});

describe('Property 3: the announcement queue is calm, ordered and bounded', () => {
  // Feature: accessible-mode, Property 3
  it('never repeats inside 10 s, spaces by 2 s, keeps order, caps pending, and does not mutate', () => {
    const events = fc.array(fc.tuple(fc.constantFrom('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'), fc.integer({ min: 0, max: 3000 })), { minLength: 1, maxLength: 60 });
    fc.assert(
      fc.property(events, (list) => {
        let q = createQueue();
        let now = 0;
        const spoken: Array<{ text: string; at: number }> = [];
        const enqueued: string[] = [];
        let wake: number | null = null;
        const pump = (): void => {
          const before = JSON.stringify(q);
          const out = release(q, now);
          expect(JSON.stringify(q)).toBe(before);
          q = out.state;
          if (out.spoken !== null) spoken.push({ text: out.spoken, at: now });
          wake = out.nextInMs === null ? null : now + out.nextInMs;
        };
        for (const [text, dt] of list) {
          const target = now + dt;
          while (wake !== null && wake <= target) {
            now = wake;
            pump();
          }
          now = target;
          const before = JSON.stringify(q);
          const next = enqueue(q, text, now);
          expect(JSON.stringify(q)).toBe(before);
          if (next.pending.length > q.pending.length || (next.pending.length === q.pending.length && next.pending.at(-1) === text && q.pending.at(-1) !== text)) enqueued.push(text);
          q = next;
          expect(q.pending.length).toBeLessThanOrEqual(MAX_PENDING);
          pump();
        }
        while (wake !== null) {
          now = wake;
          pump();
        }
        for (let i = 1; i < spoken.length; i++) expect(spoken[i]!.at - spoken[i - 1]!.at).toBeGreaterThanOrEqual(MIN_GAP_MS);
        for (const s of spoken) {
          const same = spoken.filter((o) => o.text === s.text && o !== s);
          for (const o of same) expect(Math.abs(o.at - s.at)).toBeGreaterThanOrEqual(REPEAT_WINDOW_MS);
        }
        // Order: what was said is a subsequence of what was accepted, in the same order.
        let k = 0;
        for (const s of spoken) {
          while (k < enqueued.length && enqueued[k] !== s.text) k++;
          expect(k).toBeLessThan(enqueued.length);
          k++;
        }
      }),
      { numRuns: 150 },
    );
  });
});
