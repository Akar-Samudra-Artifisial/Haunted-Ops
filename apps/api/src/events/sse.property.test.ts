// Feature: foundation, Property 5: Client caps hold
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeExchange } from '../../test/support/fake-http.js';
import { EventBus } from './event-bus.js';
import { SseService } from './sse.service.js';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/** Each open stream holds two timers: the heartbeat and the maximum age. */
const TIMERS_PER_STREAM = 2;

describe('Property 5: client caps hold', () => {
  it('never exceeds SSE_MAX_CLIENTS or SSE_MAX_CLIENTS_PER_IP; every close frees its slot and timers', () => {
    const ips = ['198.51.100.1', '198.51.100.2', '198.51.100.3'];
    const opArb = fc.oneof(
      fc.record({ op: fc.constant('connect' as const), ip: fc.constantFrom(...ips), pick: fc.constant(0) }),
      fc.record({ op: fc.constantFrom('disconnect' as const, 'age' as const), ip: fc.constant(''), pick: fc.nat() }),
    );
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 8 }), fc.integer({ min: 1, max: 4 }), fc.array(opArb, { maxLength: 40 }), (max, perIp, ops) => {
        vi.clearAllTimers();
        const bus = new EventBus();
        const ageMs = 60_000;
        const sse = new SseService(bus, { maxClients: max, maxClientsPerIp: perIp, maxAgeMs: ageMs });
        let open: { x: ReturnType<typeof fakeExchange>; ip: string; openedAt: number }[] = [];
        let now = 0;
        for (const { op, ip, pick } of ops) {
          if (op === 'connect') {
            const x = fakeExchange({ ip });
            sse.open(x.req, x.res);
            const fromIp = open.filter((o) => o.ip === ip).length;
            if (open.length < max && fromIp < perIp) {
              expect(x.res.statusCode).toBe(200);
              open.push({ x, ip, openedAt: now });
            } else {
              expect(x.res.statusCode).toBe(503);
            }
          } else if (op === 'age') {
            // Let time pass; streams older than the max age end on their own.
            const step = (pick % 3) * 30_000;
            now += step;
            vi.advanceTimersByTime(step);
            open = open.filter((o) => now - o.openedAt < ageMs);
          } else if (open.length > 0) {
            const [o] = open.splice(pick % open.length, 1);
            o?.x.disconnect();
          }
          expect(sse.openCount).toBe(open.length);
          expect(sse.openCount).toBeLessThanOrEqual(max);
          for (const addr of ips) {
            const n = open.filter((o) => o.ip === addr).length;
            expect(sse.openCountFor(addr)).toBe(n);
            expect(n).toBeLessThanOrEqual(perIp);
          }
          expect(bus.subscriberCount).toBe(open.length);
          expect(vi.getTimerCount()).toBe(open.length * TIMERS_PER_STREAM);
        }
      }),
      { numRuns: 200 },
    );
  });
});
