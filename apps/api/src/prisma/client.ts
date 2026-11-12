import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';

export { PrismaClient };

/** Fail a connection attempt after this long, so health checks answer quickly. */
export const DB_CONNECT_TIMEOUT_MS = 2_000;

/** Creates a Prisma client over the pg driver adapter. The URL is never logged. */
export function createPrismaClient(connectionString: string): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString, connectionTimeoutMillis: DB_CONNECT_TIMEOUT_MS }),
  });
}
