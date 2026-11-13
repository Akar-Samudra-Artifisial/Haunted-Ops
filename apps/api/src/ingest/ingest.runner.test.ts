import { describe, expect, it, vi } from 'vitest';
import { IngestRunner } from './ingest.runner.js';
import type { IngestService } from './ingest.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { LogCapture } from '../../test/support/ingest.js';

describe('IngestRunner', () => {
  it('polls and runs retention at start, reports a refused connection, and stops both on shutdown', async () => {
    const failures: string[] = [];
    const ingest = {
      applyPoll: vi.fn(() => Promise.resolve()),
      pollFailed: vi.fn((_at: Date, code: string) => {
        failures.push(code);
      }),
    };
    const executed = vi.fn(() => Promise.resolve(0));
    const prisma = { client: { $executeRaw: executed } };
    const log = new LogCapture();
    const runner = new IngestRunner(
      { prometheusUrl: 'http://127.0.0.1:1', pollIntervalMs: 60_000, pollTimeoutMs: 1000, signalRetentionH: 24 },
      ingest as unknown as IngestService,
      prisma as unknown as PrismaService,
      log.logger,
    );
    runner.start();
    await vi.waitFor(() => expect(failures).toEqual(['network']), { timeout: 5000 });
    expect(executed).toHaveBeenCalledTimes(1);
    await runner.onModuleDestroy();
    await runner.stop();
    expect(log.lines.join('')).not.toContain('127.0.0.1');
  });
});
