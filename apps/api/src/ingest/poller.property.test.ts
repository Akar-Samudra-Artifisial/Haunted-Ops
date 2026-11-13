// Feature: ingest-haunt-score, Property 8: never two Polls in flight
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Poller } from './poller.js';
import { PollError, type PollResult, type PrometheusClient } from './prometheus-client.js';
import { LogCapture, pollResult } from '../../test/support/ingest.js';

describe('Property 8: never two Polls in flight', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('holds for any interval, poll durations, extra ticks and stop time', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 20 }).map((n) => n * 100),
        fc.array(fc.tuple(fc.integer({ min: 0, max: 5000 }), fc.boolean()), { minLength: 1, maxLength: 12 }),
        fc.array(fc.integer({ min: 0, max: 8000 }), { maxLength: 10 }),
        fc.integer({ min: 500, max: 20_000 }),
        async (intervalMs, durations, extraTickTimes, stopAt) => {
          let calls = 0;
          let inFlight = 0;
          let maxInFlight = 0;
          let startedAfterStop = 0;
          let stopped = false;
          const client: PrometheusClient = {
            poll(signal) {
              calls += 1;
              if (stopped) startedAfterStop += 1;
              inFlight += 1;
              maxInFlight = Math.max(maxInFlight, inFlight);
              const [duration, fails] = durations[(calls - 1) % durations.length] as [number, boolean];
              return new Promise<PollResult>((resolve, reject) => {
                let settled = false;
                const timer = setTimeout(() => {
                  settled = true;
                  inFlight -= 1;
                  if (fails) reject(new PollError('timeout'));
                  else resolve(pollResult());
                }, duration);
                signal.addEventListener('abort', () => {
                  if (settled) return;
                  settled = true;
                  clearTimeout(timer);
                  inFlight -= 1;
                  reject(new PollError('aborted'));
                });
              });
            },
          };
          const ingest = { applyPoll: () => Promise.resolve(), pollFailed: () => undefined };
          const poller = new Poller({ client, ingest, intervalMs, logger: new LogCapture().logger });
          poller.start();
          for (const t of extraTickTimes) setTimeout(() => poller.tick(), t);
          setTimeout(() => {
            stopped = true;
            void poller.stop();
          }, stopAt);
          await vi.advanceTimersByTimeAsync(stopAt + 30_000);
          expect(maxInFlight).toBeLessThanOrEqual(1);
          expect(startedAfterStop).toBe(0);
          expect(inFlight).toBe(0);
          expect(calls).toBeGreaterThanOrEqual(1);
          const callsAtStop = calls;
          await vi.advanceTimersByTimeAsync(60_000);
          expect(calls).toBe(callsAtStop);
          expect(vi.getTimerCount()).toBe(0);
        },
      ),
      { numRuns: 80 },
    );
  });

  it('never starts a second Poll while the first has not finished', async () => {
    let inFlight = 0;
    let max = 0;
    const client: PrometheusClient = {
      poll: () => {
        inFlight += 1;
        max = Math.max(max, inFlight);
        return new Promise<PollResult>((resolve) =>
          setTimeout(() => {
            inFlight -= 1;
            resolve(pollResult());
          }, 10_000),
        );
      },
    };
    const poller = new Poller({
      client,
      ingest: { applyPoll: () => Promise.resolve(), pollFailed: () => undefined },
      intervalMs: 1000,
      logger: new LogCapture().logger,
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(9_500);
    expect(max).toBe(1);
    // This client ignores the abort signal, so stop() waits for the Poll in flight to finish.
    const stopping = poller.stop();
    await vi.advanceTimersByTimeAsync(2000);
    await stopping;
    expect(max).toBe(1);
  });
});
