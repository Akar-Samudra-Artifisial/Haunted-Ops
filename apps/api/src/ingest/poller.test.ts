import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Poller } from './poller.js';
import { PollError, type PollResult, type PrometheusClient } from './prometheus-client.js';
import { RETENTION_BATCH, RETENTION_INTERVAL_MS, RETENTION_PAUSE_MS, RetentionJob, retentionCutoff, runRetention } from './retention.js';
import { LogCapture, pollResult } from '../../test/support/ingest.js';

interface Pending {
  resolve: (r: PollResult) => void;
  reject: (e: unknown) => void;
  signal: AbortSignal;
}

class ScriptedClient implements PrometheusClient {
  readonly pending: Pending[] = [];
  calls = 0;
  inFlight = 0;
  maxInFlight = 0;
  poll(signal: AbortSignal): Promise<PollResult> {
    this.calls += 1;
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    return new Promise<PollResult>((resolve, reject) => {
      const done = <T>(fn: (v: T) => void) => (v: T) => {
        this.inFlight -= 1;
        fn(v);
      };
      this.pending.push({ resolve: done(resolve), reject: done(reject), signal });
      signal.addEventListener('abort', () => {
        const i = this.pending.findIndex((p) => p.signal === signal);
        if (i >= 0) this.pending.splice(i, 1)[0]?.reject(new PollError('aborted'));
      });
    });
  }
}

function fakeIngest() {
  const applied: Date[] = [];
  const failed: string[] = [];
  return {
    applied,
    failed,
    applyPoll: vi.fn((at: Date) => {
      applied.push(at);
      return Promise.resolve();
    }),
    pollFailed: vi.fn((_at: Date, code: string) => {
      failed.push(code);
    }),
  };
}

describe('Poller', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-13T10:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('polls at start and then once per interval', async () => {
    const client = new ScriptedClient();
    const ingest = fakeIngest();
    const poller = new Poller({ client, ingest, intervalMs: 5000, logger: new LogCapture().logger });
    poller.start();
    expect(client.calls).toBe(1);
    client.pending.shift()?.resolve(pollResult());
    await vi.advanceTimersByTimeAsync(5000);
    expect(client.calls).toBe(2);
    client.pending.shift()?.resolve(pollResult());
    await vi.advanceTimersByTimeAsync(5000);
    expect(client.calls).toBe(3);
    expect(ingest.applied).toHaveLength(2);
    await poller.stop();
  });

  it('skips the tick while a Poll is running', async () => {
    const client = new ScriptedClient();
    const poller = new Poller({ client, ingest: fakeIngest(), intervalMs: 1000, logger: new LogCapture().logger });
    poller.start();
    await vi.advanceTimersByTimeAsync(4500);
    expect(client.calls).toBe(1);
    expect(poller.running).toBe(true);
    expect(poller.tick()).toBe(false);
    client.pending.shift()?.resolve(pollResult());
    await vi.advanceTimersByTimeAsync(1000);
    expect(client.calls).toBe(2);
    expect(client.maxInFlight).toBe(1);
    await poller.stop();
  });

  it('hands a failure to the ingest service with its code and keeps polling', async () => {
    const client = new ScriptedClient();
    const ingest = fakeIngest();
    const log = new LogCapture();
    const poller = new Poller({ client, ingest, intervalMs: 5000, logger: log.logger });
    poller.start();
    client.pending.shift()?.reject(new PollError('timeout'));
    await vi.advanceTimersByTimeAsync(5000);
    client.pending.shift()?.reject(new TypeError('http://127.0.0.1:9090 secret-body'));
    await vi.advanceTimersByTimeAsync(5000);
    client.pending.shift()?.resolve(pollResult());
    await vi.advanceTimersByTimeAsync(10);
    expect(ingest.failed).toEqual(['timeout', 'network']);
    expect(ingest.applied).toHaveLength(1);
    expect(log.lines.join('')).not.toMatch(/127\.0\.0\.1|secret-body/);
    await poller.stop();
  });

  it('survives an ingest service that throws', async () => {
    const client = new ScriptedClient();
    const ingest = fakeIngest();
    ingest.applyPoll.mockRejectedValueOnce(new Error('boom'));
    const log = new LogCapture();
    const poller = new Poller({ client, ingest, intervalMs: 5000, logger: log.logger });
    poller.start();
    client.pending.shift()?.resolve(pollResult());
    await vi.advanceTimersByTimeAsync(5000);
    expect(client.calls).toBe(2);
    expect(log.lines.join('')).toContain('ingest_error');
    await poller.stop();
  });

  it('stop() aborts the request in flight, starts no further Poll and reports no failure', async () => {
    const client = new ScriptedClient();
    const ingest = fakeIngest();
    const poller = new Poller({ client, ingest, intervalMs: 1000, logger: new LogCapture().logger });
    poller.start();
    await poller.stop();
    expect(client.inFlight).toBe(0);
    expect(ingest.failed).toEqual([]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(client.calls).toBe(1);
    expect(poller.tick()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('retention', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-13T10:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function fakePrisma(results: Array<number | Error>) {
    const calls: Array<{ cutoff: Date; batch: number }> = [];
    return {
      calls,
      $executeRaw: vi.fn((_strings: TemplateStringsArray, cutoff: Date, batch: number) => {
        calls.push({ cutoff, batch });
        const next = results.shift() ?? 0;
        return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
      }),
    };
  }

  it('computes the cut-off from the retention in hours', () => {
    expect(retentionCutoff(new Date('2026-11-13T10:00:00.000Z'), 24).toISOString()).toBe('2026-11-12T10:00:00.000Z');
  });

  it('deletes in batches until a batch is short', async () => {
    const prisma = fakePrisma([RETENTION_BATCH, RETENTION_BATCH, 17]);
    const total = await runRetention(prisma as never, new Date('2026-11-13T10:00:00.000Z'), 24, RETENTION_BATCH, 0);
    expect(total).toBe(2 * RETENTION_BATCH + 17);
    expect(prisma.calls).toHaveLength(3);
    expect(prisma.calls.every((c) => c.batch === 5000 && c.cutoff.toISOString() === '2026-11-12T10:00:00.000Z')).toBe(true);
  });

  it('orders by "at" (the signal_at index), not by id', async () => {
    const prisma = fakePrisma([0]);
    await runRetention(prisma as never, new Date(), 1);
    const sql = (prisma.$executeRaw.mock.calls[0]?.[0] as unknown as TemplateStringsArray).join('?');
    expect(sql).toContain('ORDER BY "at"');
    expect(sql).not.toContain('ORDER BY "id"');
  });

  it('pauses between full batches and not after the last one', async () => {
    const prisma = fakePrisma([RETENTION_BATCH, RETENTION_BATCH, 3]);
    let done = false;
    const run = runRetention(prisma as never, new Date(), 1).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(prisma.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(RETENTION_PAUSE_MS);
    expect(prisma.calls).toHaveLength(2);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(RETENTION_PAUSE_MS);
    await run;
    expect(prisma.calls).toHaveLength(3);
    expect(done).toBe(true);
  });

  it('does one cheap query when nothing is old', async () => {
    const prisma = fakePrisma([0]);
    expect(await runRetention(prisma as never, new Date(), 1)).toBe(0);
    expect(prisma.calls).toHaveLength(1);
  });

  it('runs at start and every 10 minutes, logs a failure and tries again', async () => {
    const prisma = fakePrisma([new Error('db down'), 3, 0]);
    const log = new LogCapture();
    const job = new RetentionJob({ prisma: prisma as never, retentionH: 24, logger: log.logger });
    job.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(prisma.calls).toHaveLength(1);
    expect(log.lines.join('')).toContain('retention_failed');
    expect(log.lines.join('')).not.toContain('db down');
    await vi.advanceTimersByTimeAsync(RETENTION_INTERVAL_MS);
    expect(prisma.calls).toHaveLength(2);
    expect(log.lines.join('')).toContain('retention_deleted');
    await vi.advanceTimersByTimeAsync(RETENTION_INTERVAL_MS);
    expect(prisma.calls).toHaveLength(3);
    await job.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(RETENTION_INTERVAL_MS * 2);
    expect(prisma.calls).toHaveLength(3);
  });
});
