// Seed runner: `pnpm --filter @haunted-ops/api db:seed`. Reads DATABASE_URL from the environment.
import { createPrismaClient } from '../src/prisma/client.js';
import { seedServices } from '../src/prisma/seed.js';

const url = process.env.DATABASE_URL;
if (!url) {
  process.stderr.write('Invalid configuration: DATABASE_URL\n');
  process.exit(1);
}

const prisma = createPrismaClient(url);
try {
  await seedServices(prisma);
  process.stdout.write('Seeded 4 services.\n');
} finally {
  await prisma.$disconnect();
}
