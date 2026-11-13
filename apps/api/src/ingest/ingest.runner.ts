import type { OnModuleDestroy } from '@nestjs/common';
import type { Config } from '../config/config.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { JsonLogger } from '../security/logger.js';
import type { IngestService } from './ingest.service.js';
import { Poller } from './poller.js';
import { HttpPrometheusClient } from './prometheus-client.js';
import { RetentionJob } from './retention.js';

/**
 * Owns the two timers of ingest: the Poller and the retention job. `main.ts` calls `start()`;
 * tests that mount the app do not, so they never poll. Both stop when the app shuts down.
 */
export class IngestRunner implements OnModuleDestroy {
  private readonly poller: Poller;
  private readonly retention: RetentionJob;

  constructor(
    config: Pick<Config, 'prometheusUrl' | 'pollIntervalMs' | 'pollTimeoutMs' | 'signalRetentionH'>,
    ingest: IngestService,
    prisma: PrismaService,
    logger: JsonLogger,
  ) {
    this.poller = new Poller({
      client: new HttpPrometheusClient({ baseUrl: config.prometheusUrl, timeoutMs: config.pollTimeoutMs }),
      ingest,
      intervalMs: config.pollIntervalMs,
      logger,
    });
    this.retention = new RetentionJob({ prisma: prisma.client, retentionH: config.signalRetentionH, logger });
  }

  start(): void {
    this.poller.start();
    this.retention.start();
  }

  async stop(): Promise<void> {
    await Promise.all([this.poller.stop(), this.retention.stop()]);
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }
}
