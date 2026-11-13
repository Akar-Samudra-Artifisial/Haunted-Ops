// Feature: foundation, Property 12: Backoff stays within bounds
// Feature: foundation, Property 13: Connection status is consistent
// Feature: foundation, Property 17: A snapshot never overwrites a newer event
// Feature: foundation, Property 18: Services stay in room order
import fc from 'fast-check';
import { SERVICE_NAMES, type ServiceState } from '@haunted-ops/shared';
import { describe, expect, it } from 'vitest';
import { BACKOFF_CAP_MS, MAX_RETRY_AFTER_MS, backoffCeiling, nextDelay, reconnectDelay } from './backoff.js';
import { mergeByUpdatedAt, sortByRoom } from './sse-client.js';
import {
  LIVE_WINDOW_MS,
  OFFLINE_AFTER_FAILURES,
  initialConnectionState,
  reduceConnection,
  type ConnectionAction,
} from './status.js';

describe('Property 12: backoff stays within bounds', () => {
  it('delay is in [500, 30000], within the ceiling, and the ceiling never decreases', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10_000 }), fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true }), (attempt, rand) => {
        const delay = nextDelay(attempt, rand);
        const ceiling = Math.min(BACKOFF_CAP_MS, 1000 * 2 ** Math.min(attempt, 15));
        expect(delay).toBeGreaterThanOrEqual(500);
        expect(delay).toBeLessThanOrEqual(30_000);
        expect(delay).toBeLessThanOrEqual(ceiling);
        expect(delay).toBeGreaterThanOrEqual(ceiling / 2);
        expect(backoffCeiling(attempt + 1)).toBeGreaterThanOrEqual(backoffCeiling(attempt));
      }),
      { numRuns: 500 },
    );
  });
});

describe('Property 13: connection status is consistent', () => {
  const actionArb: fc.Arbitrary<ConnectionAction> = fc
    .tuple(fc.constantFrom('open', 'message', 'error', 'tick', 'online', 'offline'), fc.integer({ min: 0, max: 60_000 }))
    .map(([type, dt]) => ({ type, at: dt }) as ConnectionAction);

  it('always yields one of three statuses that match the model', () => {
    fc.assert(
      fc.property(fc.boolean(), fc.array(actionArb, { maxLength: 40 }), (startOnline, steps) => {
        let now = 1_000_000;
        let state = initialConnectionState(now, startOnline);
        // Reference model.
        let open = false;
        let online = startOnline;
        let failures = 0;
        let last: number | null = null;
        for (const step of steps) {
          now += step.at;
          state = reduceConnection(state, { type: step.type, at: now });
          switch (step.type) {
            case 'open':
              open = true;
              failures = 0;
              last = now;
              break;
            case 'message':
              last = now;
              break;
            case 'error':
              open = false;
              failures++;
              break;
            case 'online':
              online = true;
              break;
            case 'offline':
              online = false;
              open = false;
              break;
            case 'tick':
              break;
          }
          expect(['live', 'reconnecting', 'offline']).toContain(state.status);
          const offline = !online || failures >= OFFLINE_AFTER_FAILURES;
          expect(state.status === 'offline').toBe(offline);
          if (state.status === 'live') {
            expect(open).toBe(true);
            expect(last).not.toBeNull();
            expect(now - (last as number)).toBeLessThanOrEqual(LIVE_WINDOW_MS);
          }
          if (!offline && open && last !== null && now - last <= LIVE_WINDOW_MS) expect(state.status).toBe('live');
          if (step.type === 'open') expect(state.failures).toBe(0);
          expect(state.failures).toBe(failures);
        }
      }),
      { numRuns: 500 },
    );
  });
});

describe('Property 12 (cont.): Retry-After is honoured', () => {
  it('the reconnect delay is at least the backoff and at least the capped Retry-After, never more than both', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 50 }),
        fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true }),
        fc.option(fc.integer({ min: -1000, max: 10 * MAX_RETRY_AFTER_MS }), { nil: undefined }),
        (attempt, rand, retryAfter) => {
          const delay = reconnectDelay(attempt, rand, retryAfter);
          const backoff = nextDelay(attempt, rand);
          const asked = retryAfter === undefined ? 0 : Math.min(Math.max(0, retryAfter), MAX_RETRY_AFTER_MS);
          expect(delay).toBe(Math.max(backoff, asked));
          expect(delay).toBeLessThanOrEqual(Math.max(BACKOFF_CAP_MS, MAX_RETRY_AFTER_MS));
        },
      ),
      { numRuns: 500 },
    );
  });
});

const isoArb = fc
  .integer({ min: Date.parse('2026-01-01T00:00:00.000Z'), max: Date.parse('2026-12-31T00:00:00.000Z') })
  .map((ms) => new Date(ms).toISOString());
const ROOMS: Record<string, { x: number; y: number }> = {
  gate: { x: 0, y: 0 },
  orders: { x: 1, y: 0 },
  payments: { x: 0, y: 1 },
  ledger: { x: 1, y: 1 },
};
const stateArb = (name: (typeof SERVICE_NAMES)[number]): fc.Arbitrary<ServiceState> =>
  fc.record({
    name: fc.constant(name),
    room: fc.constant(ROOMS[name] as { x: number; y: number }),
    hauntLevel: fc.constantFrom(0, 1, 2, 3, 4),
    reason: fc.constant(null),
    metrics: fc.constant(null),
    openIncident: fc.constant(null),
    updatedAt: isoArb,
  });
const servicesArb = fc
  .subarray([...SERVICE_NAMES])
  .chain((names) => fc.tuple(...names.map((n) => stateArb(n))))
  .map((list) => list as ServiceState[]);

describe('Property 17: a snapshot never overwrites a newer event', () => {
  it('per service, the merged entry is the one with the later updatedAt', () => {
    fc.assert(
      fc.property(servicesArb, servicesArb, (current, snapshot) => {
        const merged = mergeByUpdatedAt(current, snapshot);
        const names = new Set([...current, ...snapshot].map((s) => s.name));
        expect(merged.map((s) => s.name).sort()).toEqual([...names].sort());
        for (const m of merged) {
          const c = current.find((s) => s.name === m.name);
          const s = snapshot.find((x) => x.name === m.name);
          if (c && s) {
            // On a tie the current entry wins: events are applied in order, so it is at least as new.
            if (Date.parse(c.updatedAt) >= Date.parse(s.updatedAt)) expect(m).toEqual(c);
            else expect(m).toEqual(s);
          } else {
            expect(m).toEqual(c ?? s);
          }
        }
      }),
      { numRuns: 300 },
    );
  });
});

describe('Property 18: services stay in room order', () => {
  it('sortByRoom orders by y, then x, for any input order', () => {
    fc.assert(
      fc.property(servicesArb.chain((list) => fc.shuffledSubarray(list, { minLength: list.length, maxLength: list.length })), (list) => {
        const sorted = sortByRoom(list);
        expect(sorted).toHaveLength(list.length);
        for (let i = 1; i < sorted.length; i++) {
          const a = sorted[i - 1] as ServiceState;
          const b = sorted[i] as ServiceState;
          expect(a.room.y < b.room.y || (a.room.y === b.room.y && a.room.x <= b.room.x)).toBe(true);
        }
        expect(sortByRoom(sorted)).toEqual(sorted);
      }),
      { numRuns: 300 },
    );
  });
});
