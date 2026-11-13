import type { PrismaClient } from '../prisma/client.js';
import type { JsonLogger } from '../security/logger.js';

export const RETENTION_INTERVAL_MS = 600_000;
export const RETENTION_BATCH = 5000;
/** Pause between two full batches. */
export const RETENTION_PAUSE_MS = 50;

/** Cut-off: Signals with `at` strictly before it are deleted. */
export function retentionCutoff(now: Date, retentionH: number): Date {
  return new Date(now.getTime() - retentionH * 3_600_000);
}

/**
 * Deletes Signals older than the retention in batches, until a batch deletes fewer rows than its
 * limit. Touches only the Signal table. Returns the number of rows deleted.
 */
export async function runRetention(
  prisma: Pick<PrismaClient, '$executeRaw'>,
  now: Date,
  retentionH: number,
  batch: number = RETENTION_BATCH,
  pauseMs: number = RETENTION_PAUSE_MS,
): Promise<number> {
  const cutoff = retentionCutoff(now, retentionH);
  let total = 0;
  for (;;) {
    // ORDER BY "at" walks the signal_at index from the oldest row, so each batch is a short index scan.
    const deleted = await prisma.$executeRaw`
      DELETE FROM "Signal"
      WHERE "id" IN (SELECT "id" FROM "Signal" WHERE "at" < ${cutoff} ORDER BY "at" LIMIT ${batch})`;
    total += deleted;
    if (deleted < batch) return total;
    // A short pause between full batches leaves the database to the poller.
    if (pauseMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, pauseMs));
  }
}

export interface RetentionJobDeps {
  prisma: Pick<PrismaClient, '$executeRaw'>;
  retentionH: number;
  logger: JsonLogger;
  now?: () => Date;
  intervalMs?: number;
  batch?: number;
}

/** Runs the retention at start and then every 10 minutes. A failure is logged and tried again later. */
export class RetentionJob {
  private timer: ReturnType<typeof setInterval> | null = null;
  private current: Promise<void> | null = null;
  private stopped = false;

  constructor(private readonly deps: RetentionJobDeps) {}

  start(): void {
    if (this.timer !== null || this.stopped) return;
    void this.run();
    this.timer = setInterval(() => void this.run(), this.deps.intervalMs ?? RETENTION_INTERVAL_MS);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    if (this.current !== null) await this.current;
  }

  /** One run. Never rejects. Skipped while another run is in progress. */
  run(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.current !== null) return this.current;
    const { prisma, retentionH, logger } = this.deps;
    const now = this.deps.now?.() ?? new Date();
    this.current = runRetention(prisma, now, retentionH, this.deps.batch ?? RETENTION_BATCH)
      .then((deleted) => {
        if (deleted > 0) logger.log('info', 'retention_deleted', { deleted });
      })
      .catch((err: unknown) => {
        logger.log('error', 'retention_failed', { error: err instanceof Error ? err.name : 'unknown' });
      })
      .finally(() => {
        this.current = null;
      });
    return this.current;
  }
}
