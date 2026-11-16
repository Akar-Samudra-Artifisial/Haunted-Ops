// Seeds the four services and the reviewed replays from the compiled API (no tsx on the server). Safe to repeat: it upserts.
// Run as hops with DATABASE_URL in the environment: node deploy/server/seed.mjs
// The replays are the reviewed `fixtures/replays/*.json` files of the release; an invalid file stops the seed.
import { fileURLToPath } from 'node:url';
import { createPrismaClient } from '../../apps/api/dist/prisma/client.js';
import { seedServices } from '../../apps/api/dist/prisma/seed.js';
import { seedReplays } from '../../apps/api/dist/replays/replay-seed.js';
const url = process.env.DATABASE_URL;
if (!url) {
  process.stderr.write('Invalid configuration: DATABASE_URL\n');
  process.exit(1);
}
const prisma = createPrismaClient(url);
try {
  await seedServices(prisma);
  process.stdout.write('Seeded 4 services.\n');
  const result = await seedReplays(prisma, fileURLToPath(new URL('../../fixtures/replays', import.meta.url)));
  for (const name of result.skipped) process.stdout.write(`Skipped ${name}: not reviewed.\n`);
  process.stdout.write(`Replays: ${result.seeded.length} written, ${result.kept.length} unchanged, ${result.skipped.length} skipped, ${result.removed.length} removed.\n`);
} catch (err) {
  // The file name and the failing paths only (see ReplaySeedError), never a value or a database message.
  process.stderr.write(`Seed failed: ${err instanceof Error && err.name === 'ReplaySeedError' ? err.message : 'database or internal error'}\n`);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
