import type { OnModuleDestroy } from '@nestjs/common';
import { createPrismaClient, type PrismaClient } from './client.js';

/**
 * Holds the single Prisma client of the process. Provided through a factory
 * that passes the validated DATABASE_URL. Connects lazily on first query.
 */
export class PrismaService implements OnModuleDestroy {
  readonly client: PrismaClient;

  constructor(databaseUrl: string) {
    this.client = createPrismaClient(databaseUrl);
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }
}
