import type { OnApplicationShutdown } from '@nestjs/common';
import { createPrismaClient, type PrismaClient } from './client.js';

/**
 * Holds the single Prisma client of the process. Provided through a factory
 * that passes the validated DATABASE_URL. Connects lazily on first query.
 *
 * It disconnects in `onApplicationShutdown`, which Nest runs after every `onModuleDestroy`.
 * The ingest runner stops its poller (and waits for a Poll in flight) in `onModuleDestroy`, so
 * nothing writes after the disconnect. Nest runs the hooks of one phase in parallel, which is why
 * the two cannot share a phase.
 */
export class PrismaService implements OnApplicationShutdown {
  readonly client: PrismaClient;
  constructor(databaseUrl: string) {
    this.client = createPrismaClient(databaseUrl);
  }
  async onApplicationShutdown(): Promise<void> {
    await this.client.$disconnect();
  }
}
