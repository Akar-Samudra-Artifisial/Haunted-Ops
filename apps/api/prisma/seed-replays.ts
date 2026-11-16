// Local seed of the reviewed replays: `pnpm --filter @haunted-ops/api seed:replays [folder]`. Reads DATABASE_URL from the
// environment (apps/api/.env is loaded by the Prisma config only, so use `node --env-file` or export it). The folder
// defaults to `fixtures/replays` of the repository. An unreviewed file is skipped; an invalid one stops the seed.
import { fileURLToPath } from 'node:url';
import { createPrismaClient } from '../src/prisma/client.js';
import { ReplaySeedError, seedReplays } from '../src/replays/replay-seed.js';
if (process.env.DATABASE_URL === undefined && typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile('.env');
  } catch {
    // No local .env: the check below reports the missing variable.
  }
}
const url = process.env.DATABASE_URL;
if (!url) {
  process.stderr.write('Invalid configuration: DATABASE_URL\n');
  process.exit(1);
}
const dir = process.argv[2] ?? fileURLToPath(new URL('../../../fixtures/replays', import.meta.url));
const prisma = createPrismaClient(url);
try {
  const result = await seedReplays(prisma, dir);
  for (const name of result.skipped) process.stdout.write(`Skipped ${name}: not reviewed.\n`);
  process.stdout.write(`Replays: ${result.seeded.length} written, ${result.kept.length} unchanged, ${result.skipped.length} skipped, ${result.removed.length} removed.\n`);
} catch (err) {
  process.stderr.write(`Seed failed: ${err instanceof ReplaySeedError ? err.message : 'database or internal error'}\n`);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
