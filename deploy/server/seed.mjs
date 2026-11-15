// Seeds the four services from the compiled API (no tsx on the server). Safe to repeat: it upserts.
// Run as hops with DATABASE_URL in the environment: node deploy/server/seed.mjs
import { createPrismaClient } from '../../apps/api/dist/prisma/client.js';
import { seedServices } from '../../apps/api/dist/prisma/seed.js';

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
