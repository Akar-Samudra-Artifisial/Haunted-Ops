// Feature: foundation, Property 1: Event ids strictly increase
// Feature: foundation, Property 2: Ring buffer is bounded and keeps the newest
// Feature: foundation, Property 3: Resume neither skips nor repeats
// Feature: foundation, Property 4: Out-of-range and foreign ids resync
import fc from 'fast-check';
import { parseEventId, type ResyncReason } from '@haunted-ops/shared';
import { describe, expect, it } from 'vitest';
import { afterConnected, framesOf, publishN, seqsOf, wireId } from '../../test/support/events.js';
import { EventBus } from './event-bus.js';
import { parseLastEventId, subscribeWithResume } from './resume.js';
import { RING_CAPACITY, RingBuffer } from './ring-buffer.js';
import { formatControl } from './sse-format.js';

const RUNS = { numRuns: 100 };
const range = (from: number, to: number): number[] => Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i);
const bootArb = fc.stringMatching(/^[0-9a-f]{12}$/);

describe('Property 1: event ids strictly increase', () => {
  it('assigns unique, strictly increasing ids of one boot; control frames carry no id', () => {
    fc.assert(
      fc.property(bootArb, fc.array(fc.integer({ min: 1, max: 20 }), { minLength: 1, maxLength: 20 }), (boot, batches) => {
        const bus = new EventBus({ bootId: boot });
        const out: string[] = [];
        subscribeWithResume(bus, { kind: 'none' }, (c) => out.push(c));
        const ids = batches.flatMap((n) => publishN(bus, n));
        for (let i = 1; i < ids.length; i++) expect(ids[i]).toBeGreaterThan(ids[i - 1] as number);
        expect(new Set(ids).size).toBe(ids.length);
        const frames = framesOf(out);
        // Every domain frame id is `<boot>-<seq>` with the bus's boot id.
        expect(frames.filter((f) => f.id !== undefined).every((f) => parseEventId(f.id)?.bootId === boot)).toBe(true);
        expect(seqsOf(frames, boot)).toEqual(ids);
        const control = framesOf([
          formatControl('connected', { bootId: boot }),
          formatControl('heartbeat', { at: '2026-11-12T10:00:00.000Z' }),
          formatControl('resync', { reason: 'ahead' }),
        ]);
        expect(control.every((f) => f.id === undefined)).toBe(true);
      }),
      RUNS,
    );
  });
});

describe('Property 2: ring buffer is bounded and keeps the newest', () => {
  it('holds at most capacity events: the last ones pushed, in order', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 50 }), fc.integer({ min: 0, max: 200 }), (capacity, pushes) => {
        const rb = new RingBuffer(capacity);
        for (let id = 1; id <= pushes; id++) rb.push({ id, name: 'service.updated', payload: {} });
        expect(rb.length).toBe(Math.min(capacity, pushes));
        expect(rb.toArray().map((e) => e.id)).toEqual(range(Math.max(1, pushes - capacity + 1), pushes));
      }),
      RUNS,
    );
  });

  it('uses a capacity of 500 by default', () => {
    const bus = new EventBus();
    publishN(bus, RING_CAPACITY + 37);
    expect(bus.buffer.length).toBe(500);
    expect(bus.buffer.oldestId()).toBe(38);
  });
});

describe('Property 3: resume neither skips nor repeats', () => {
  it('replay plus live events contain every id after Last-Event-ID exactly once, in order', () => {
    fc.assert(
      fc.property(
        bootArb,
        fc.integer({ min: 0, max: 700 }).chain((before) => {
          const oldest = Math.max(1, before - RING_CAPACITY + 1);
          return fc.tuple(fc.constant(before), fc.integer({ min: before === 0 ? 0 : oldest - 1, max: before }), fc.integer({ min: 0, max: 30 }));
        }),
        (boot, [before, lastSeq, after]) => {
          const bus = new EventBus({ bootId: boot });
          publishN(bus, before);
          const out: string[] = [];
          // The id goes through the same wire parser the controller uses.
          subscribeWithResume(bus, parseLastEventId(wireId(boot, lastSeq), undefined, boot), (c) => out.push(c));
          publishN(bus, after);
          const frames = framesOf(out);
          expect(frames[0]).toEqual({ event: 'connected', data: { bootId: boot } });
          expect(frames.every((f) => f.event !== 'resync')).toBe(true);
          expect(seqsOf(frames, boot)).toEqual(range(lastSeq + 1, before + after));
        },
      ),
      RUNS,
    );
  });

  it('events published by a subscriber during replay are not skipped or repeated', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 50 }), fc.integer({ min: 1, max: 5 }), (before, extra) => {
        const bus = new EventBus();
        publishN(bus, before);
        let fired = false;
        const out: string[] = [];
        const sub = subscribeWithResume(bus, { kind: 'id', seq: 0 }, (c) => {
          out.push(c);
          if (!fired) {
            fired = true;
            publishN(bus, extra);
          }
        });
        sub.unsubscribe();
        expect(seqsOf(framesOf(out), bus.bootId)).toEqual(range(1, before + extra));
      }),
      RUNS,
    );
  });
});

describe('Property 4: out-of-range and foreign ids resync', () => {
  /** Opens a stream with the given header, publishes `after` live events, checks resync + live only. */
  function expectResync(bus: EventBus, header: string, reason: ResyncReason, after: number): void {
    const before = bus.buffer.latestId();
    const out: string[] = [];
    subscribeWithResume(bus, parseLastEventId(header, undefined, bus.bootId), (c) => out.push(c));
    publishN(bus, after);
    const frames = afterConnected(framesOf(out));
    expect(frames[0]).toEqual({ event: 'resync', data: { reason } });
    expect(seqsOf(frames.slice(1), bus.bootId)).toEqual(range(before + 1, before + after));
  }

  it('too_old: an id older than the oldest retained event minus one', () => {
    fc.assert(
      fc.property(
        // Always overflow the buffer so events were dropped.
        fc.integer({ min: RING_CAPACITY + 2, max: RING_CAPACITY + 300 }).chain((before) => {
          const oldest = before - RING_CAPACITY + 1;
          return fc.tuple(fc.constant(before), fc.integer({ min: 0, max: oldest - 2 }), fc.integer({ min: 0, max: 10 }));
        }),
        ([before, lastSeq, after]) => {
          const bus = new EventBus();
          publishN(bus, before);
          expect(lastSeq).toBeLessThan((bus.buffer.oldestId() as number) - 1);
          expectResync(bus, wireId(bus.bootId, lastSeq), 'too_old', after);
        },
      ),
      { numRuns: 50 },
    );
  });

  it('ahead: an id of this boot past the latest id', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 600 }), fc.integer({ min: 1, max: 10_000 }), fc.integer({ min: 0, max: 10 }), (before, offset, after) => {
        const bus = new EventBus();
        publishN(bus, before);
        expectResync(bus, wireId(bus.bootId, before + offset), 'ahead', after);
      }),
      { numRuns: 50 },
    );
  });

  it('restarted: any well-formed id of another boot', () => {
    fc.assert(
      fc.property(bootArb, fc.integer({ min: 0, max: 600 }), fc.integer({ min: 0, max: 600 }), fc.integer({ min: 0, max: 10 }), (other, before, seq, after) => {
        const bus = new EventBus();
        fc.pre(other !== bus.bootId);
        publishN(bus, before);
        // Even a seq that exists in this boot's buffer must not resume.
        expectResync(bus, wireId(other, seq), 'restarted', after);
      }),
      RUNS,
    );
  });

  it('malformed: anything that is not <bootId>-<seq>', () => {
    const malformed = fc.oneof(
      fc.constantFrom('abc', '-1', '1.5', '42', 'ABCDEF012345-1', 'a1b2c3d4e5f6-', 'a1b2c3d4e5f6-x'),
      fc.string().filter((s) => parseEventId(s) === null),
    );
    fc.assert(
      fc.property(malformed, fc.integer({ min: 0, max: 600 }), fc.integer({ min: 0, max: 10 }), (junk, before, after) => {
        const bus = new EventBus();
        publishN(bus, before);
        expectResync(bus, junk, 'malformed', after);
      }),
      RUNS,
    );
  });
});
