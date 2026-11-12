import { describe } from 'vitest';
import { createPrismaClient, type PrismaClient } from '../src/prisma/client.js';
import { dbGuard } from './db-guard.js';

const guard = dbGuard();

/** The Test database URL, or undefined when integration tests are skipped. */
export const testDatabaseUrl: string | undefined = guard.run ? guard.url : undefined;

/** `describe` that only runs with a Test database. The skip message is printed by global setup. */
export const describeDb = testDatabaseUrl === undefined ? describe.skip : describe;

export function testPrisma(): PrismaClient {
  if (testDatabaseUrl === undefined) throw new Error('No Test database');
  return createPrismaClient(testDatabaseUrl);
}

/** Empties every table, keeping the schema. */
export async function truncateAll(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "Proposal", "Evidence", "Hunt", "Incident", "Signal", "Service" RESTART IDENTITY CASCADE',
  );
}
