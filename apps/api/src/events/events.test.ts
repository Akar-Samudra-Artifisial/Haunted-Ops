import { describe, expect, it, vi } from 'vitest';
import { OTHER_BOOT, TEST_BOOT, afterConnected, framesOf, publishN, seqsOf, wireId } from '../../test/support/events.js';
import { EventBus, newBootId } from './event-bus.js';
import { parseLastEventId, subscribeWithResume } from './resume.js';
import { RingBuffer } from './ring-buffer.js';
import { formatBusEvent, formatControl, formatRetry } from './sse-format.js';

describe('RingBuffer', () => {
  it('drops the oldest when full', () => {
    const rb = new RingBuffer(3);
    for (let id = 1; id <= 5; id++) rb.push({ id, name: 'service.updated', payload: {} });
    expect(rb.toArray().map((e) => e.id)).toEqual([3, 4, 5]);
    expect(rb.oldestId()).toBe(3);
    expect(rb.latestId()).toBe(5);
  });

  it('answers since() for in-range, too old and ahead ids', () => {
    const rb = new RingBuffer(3);
    expect(rb.since(0)).toEqual([]);
    expect(rb.since(1)).toBe('ahead');
    for (let id = 1; id <= 5; id++) rb.push({ id, name: 'service.updated', payload: {} });
    expect((rb.since(2) as { id: number }[]).map((e) => e.id)).toEqual([3, 4, 5]);
    expect(rb.since(5)).toEqual([]);
    expect(rb.since(1)).toBe('too_old');
    expect(rb.since(6)).toBe('ahead');
  });

  it('rejects non-increasing ids and bad capacity', () => {
    const rb = new RingBuffer(2);
    rb.push({ id: 2, name: 'service.updated', payload: {} });
    expect(() => rb.push({ id: 2, name: 'service.updated', payload: {} })).toThrow(RangeError);
    expect(() => new RingBuffer(0)).toThrow(RangeError);
  });
});

describe('EventBus', () => {
  it('has a random 12-hex boot id per instance', () => {
    expect(newBootId()).toMatch(/^[0-9a-f]{12}$/);
    expect(new EventBus().bootId).not.toBe(new EventBus().bootId);
    expect(() => new EventBus({ bootId: 'nope' })).toThrow(RangeError);
  });

  it('validates payloads before publishing', () => {
    const bus = new EventBus();
    expect(() => bus.publish('incident.opened', { incidentId: '', service: 'gate', openedAt: 'x', level: 2, reason: null })).toThrow(TypeError);
    expect(bus.buffer.latestId()).toBe(0);
  });

  it('isolates a failing subscriber', () => {
    const bus = new EventBus();
    const good = vi.fn();
    bus.subscribe(() => {
      throw new Error('socket closed');
    });
    bus.subscribe(good);
    publishN(bus, 2);
    expect(good).toHaveBeenCalledTimes(2);
    expect(bus.subscriberCount).toBe(1);
  });

  it('close() drops subscribers and refuses new events', () => {
    const bus = new EventBus();
    bus.subscribe(() => undefined);
    bus.close();
    expect(bus.subscriberCount).toBe(0);
    expect(() => publishN(bus, 1)).toThrow('closed');
    expect(bus.subscribe(() => undefined)).toBeTypeOf('function');
    expect(bus.subscriberCount).toBe(0);
  });
});

describe('SSE format', () => {
  it('writes <bootId>-<seq> ids only for domain events', () => {
    expect(formatBusEvent(TEST_BOOT, { id: 3, name: 'service.updated', payload: { a: 1 } })).toBe(
      `id: ${TEST_BOOT}-3\nevent: service.updated\ndata: {"a":1}\n\n`,
    );
    expect(formatControl('heartbeat', { at: '2026-11-12T10:00:00.000Z' })).toBe(
      'event: heartbeat\ndata: {"at":"2026-11-12T10:00:00.000Z"}\n\n',
    );
    expect(formatRetry(1500.7)).toBe('retry: 1500\n\n');
  });
});

describe('parseLastEventId', () => {
  it('prefers the header over the query', () => {
    expect(parseLastEventId(wireId(TEST_BOOT, 5), wireId(TEST_BOOT, 9), TEST_BOOT)).toEqual({ kind: 'id', seq: 5 });
    expect(parseLastEventId(undefined, wireId(TEST_BOOT, 9), TEST_BOOT)).toEqual({ kind: 'id', seq: 9 });
    expect(parseLastEventId(undefined, undefined, TEST_BOOT)).toEqual({ kind: 'none' });
  });

  it('flags ids of another boot', () => {
    expect(parseLastEventId(wireId(OTHER_BOOT, 5), undefined, TEST_BOOT)).toEqual({ kind: 'other_boot' });
  });

  it('flags malformed ids, including bare numbers from before boot ids', () => {
    for (const v of ['', 'abc', '5', '-1', `${TEST_BOOT}-1.5`, `${TEST_BOOT}-9999999999999999`, ['1']]) {
      expect(parseLastEventId(v, undefined, TEST_BOOT)).toEqual({ kind: 'malformed' });
    }
    expect(parseLastEventId(undefined, ['1', '2'], TEST_BOOT)).toEqual({ kind: 'malformed' });
  });
});

describe('subscribeWithResume', () => {
  it('writes connected with the boot id first', () => {
    const bus = new EventBus({ bootId: TEST_BOOT });
    const out: string[] = [];
    subscribeWithResume(bus, { kind: 'none' }, (c) => out.push(c));
    expect(framesOf(out)[0]).toEqual({ event: 'connected', data: { bootId: TEST_BOOT } });
  });

  it('replays after the id, then streams live', () => {
    const bus = new EventBus({ bootId: TEST_BOOT });
    publishN(bus, 4);
    const out: string[] = [];
    const sub = subscribeWithResume(bus, { kind: 'id', seq: 2 }, (c) => out.push(c));
    publishN(bus, 1);
    expect(seqsOf(framesOf(out), TEST_BOOT)).toEqual([3, 4, 5]);
    sub.unsubscribe();
    publishN(bus, 1);
    expect(seqsOf(framesOf(out), TEST_BOOT)).toHaveLength(3);
  });

  it('streams only live events without a resume id', () => {
    const bus = new EventBus({ bootId: TEST_BOOT });
    publishN(bus, 3);
    const out: string[] = [];
    subscribeWithResume(bus, { kind: 'none' }, (c) => out.push(c));
    publishN(bus, 2);
    expect(seqsOf(framesOf(out), TEST_BOOT)).toEqual([4, 5]);
  });

  it('sends resync restarted for an id from another boot', () => {
    const bus = new EventBus({ bootId: TEST_BOOT });
    publishN(bus, 3);
    const out: string[] = [];
    subscribeWithResume(bus, parseLastEventId(wireId(OTHER_BOOT, 2), undefined, TEST_BOOT), (c) => out.push(c));
    expect(afterConnected(framesOf(out))).toEqual([{ event: 'resync', data: { reason: 'restarted' } }]);
  });
});
