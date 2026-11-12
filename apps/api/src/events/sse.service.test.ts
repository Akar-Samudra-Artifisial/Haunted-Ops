import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeExchange } from '../../test/support/fake-http.js';
import { OTHER_BOOT, TEST_BOOT, afterConnected, framesOf, publishN, seqsOf, wireId } from '../../test/support/events.js';
import { EventBus } from './event-bus.js';
import { HEARTBEAT_MS, MAX_BUFFERED_BYTES, MAX_STREAM_AGE_MS, SseService, clientIp } from './sse.service.js';

const limits = { maxClients: 10, maxClientsPerIp: 5 };

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('SseService', () => {
  it('writes SSE headers, connected with the boot id, then events', () => {
    const bus = new EventBus({ bootId: TEST_BOOT });
    const sse = new SseService(bus, limits);
    const x = fakeExchange();
    sse.open(x.req, x.res);
    expect(x.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(x.headers['cache-control']).toBe('no-cache');
    expect(x.headers['x-accel-buffering']).toBe('no');
    publishN(bus, 2);
    const frames = framesOf(x.chunks);
    expect(frames[0]).toEqual({ event: 'connected', data: { bootId: TEST_BOOT } });
    expect(seqsOf(frames, TEST_BOOT)).toEqual([1, 2]);
  });

  it('sends a heartbeat every 15 s without an id', () => {
    const sse = new SseService(new EventBus(), limits, () => new Date('2026-11-12T10:00:00.000Z'));
    const x = fakeExchange();
    sse.open(x.req, x.res);
    vi.advanceTimersByTime(HEARTBEAT_MS * 2);
    expect(afterConnected(framesOf(x.chunks))).toEqual([
      { event: 'heartbeat', data: { at: '2026-11-12T10:00:00.000Z' } },
      { event: 'heartbeat', data: { at: '2026-11-12T10:00:00.000Z' } },
    ]);
  });

  it('resumes from the header, or the query when no header is present', () => {
    const bus = new EventBus({ bootId: TEST_BOOT });
    publishN(bus, 5);
    const sse = new SseService(bus, limits);
    const a = fakeExchange({ headers: { 'last-event-id': wireId(TEST_BOOT, 3) }, query: { lastEventId: wireId(TEST_BOOT, 1) } });
    sse.open(a.req, a.res);
    expect(seqsOf(framesOf(a.chunks), TEST_BOOT)).toEqual([4, 5]);
    const b = fakeExchange({ query: { lastEventId: wireId(TEST_BOOT, 1) } });
    sse.open(b.req, b.res);
    expect(seqsOf(framesOf(b.chunks), TEST_BOOT)).toEqual([2, 3, 4, 5]);
  });

  it('resyncs a Last-Event-ID from another boot even if its seq exists here', () => {
    const bus = new EventBus({ bootId: TEST_BOOT });
    publishN(bus, 5);
    const sse = new SseService(bus, limits);
    const x = fakeExchange({ headers: { 'last-event-id': wireId(OTHER_BOOT, 3) } });
    sse.open(x.req, x.res);
    expect(afterConnected(framesOf(x.chunks))).toEqual([{ event: 'resync', data: { reason: 'restarted' } }]);
  });

  it('answers 503 with Retry-After at the global cap', () => {
    const sse = new SseService(new EventBus(), { maxClients: 1, maxClientsPerIp: 5 });
    const first = fakeExchange({ ip: '198.51.100.1' });
    sse.open(first.req, first.res);
    const x = fakeExchange({ ip: '198.51.100.2' });
    sse.open(x.req, x.res);
    expect(x.res.statusCode).toBe(503);
    expect(x.headers['retry-after']).toBe('5');
    expect(x.state.writableEnded).toBe(true);
  });

  it('caps streams per IP: the 6th from one IP gets 503, other IPs are unaffected, close releases the slot', () => {
    const sse = new SseService(new EventBus(), { maxClients: 100, maxClientsPerIp: 5 });
    const mine = Array.from({ length: 5 }, () => fakeExchange({ ip: '198.51.100.7' }));
    for (const x of mine) sse.open(x.req, x.res);
    expect(sse.openCountFor('198.51.100.7')).toBe(5);

    const sixth = fakeExchange({ ip: '198.51.100.7' });
    sse.open(sixth.req, sixth.res);
    expect(sixth.res.statusCode).toBe(503);
    expect(sixth.headers['retry-after']).toBe('5');

    const other = fakeExchange({ ip: '198.51.100.8' });
    sse.open(other.req, other.res);
    expect(other.res.statusCode).toBe(200);

    mine[0]?.disconnect();
    expect(sse.openCountFor('198.51.100.7')).toBe(4);
    const again = fakeExchange({ ip: '198.51.100.7' });
    sse.open(again.req, again.res);
    expect(again.res.statusCode).toBe(200);
  });

  it('destroys a stream whose unsent output exceeds 64 KiB and releases its slot', () => {
    const bus = new EventBus();
    const sse = new SseService(bus, limits);
    const slow = fakeExchange({ ip: '198.51.100.9', stalled: true });
    const fast = fakeExchange({ ip: '198.51.100.10' });
    sse.open(slow.req, slow.res);
    sse.open(fast.req, fast.res);
    let published = 0;
    while (!slow.state.destroyed && published < 10_000) {
      publishN(bus, 1);
      published++;
    }
    expect(slow.state.destroyed).toBe(true);
    expect(slow.state.writableLength).toBeGreaterThan(MAX_BUFFERED_BYTES);
    expect(sse.openCount).toBe(1);
    expect(sse.openCountFor('198.51.100.9')).toBe(0);
    expect(bus.subscriberCount).toBe(1);
    // The healthy stream got every event.
    expect(seqsOf(framesOf(fast.chunks), bus.bootId)).toHaveLength(published);
  });

  it('ends a stream cleanly after the maximum age (30 min by default)', () => {
    const sse = new SseService(new EventBus(), limits);
    const x = fakeExchange();
    sse.open(x.req, x.res);
    vi.advanceTimersByTime(MAX_STREAM_AGE_MS - 1);
    expect(x.state.writableEnded).toBe(false);
    vi.advanceTimersByTime(1);
    expect(x.state.writableEnded).toBe(true);
    expect(x.state.destroyed).toBe(false);
    expect(sse.openCount).toBe(0);
    expect(sse.openCountFor('203.0.113.1')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cleans up on disconnect and ends all streams on shutdown', () => {
    const bus = new EventBus();
    const sse = new SseService(bus, limits);
    const a = fakeExchange();
    const b = fakeExchange();
    sse.open(a.req, a.res);
    sse.open(b.req, b.res);
    a.disconnect();
    expect(sse.openCount).toBe(1);
    expect(bus.subscriberCount).toBe(1);
    sse.beforeApplicationShutdown();
    expect(sse.openCount).toBe(0);
    expect(sse.openCountFor('203.0.113.1')).toBe(0);
    expect(b.state.writableEnded).toBe(true);
    expect(bus.isClosed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    const c = fakeExchange();
    sse.open(c.req, c.res);
    expect(c.res.statusCode).toBe(503);
  });

  it('clientIp prefers req.ip', () => {
    expect(clientIp(fakeExchange({ ip: '192.0.2.4' }).req)).toBe('192.0.2.4');
  });
});
