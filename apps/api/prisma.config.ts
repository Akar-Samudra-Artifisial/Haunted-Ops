import { existsSync } from 'node:fs';
import { defineConfig } from 'prisma/config';

// Prisma 7 does not load .env files itself. Load the local, git-ignored file if present.
if (existsSync('.env')) process.loadEnvFile('.env');

const url = process.env.DATABASE_URL;

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  // Only migrate and seed need the URL; `prisma generate` runs without it.
  ...(url ? { datasource: { url } } : {}),
});
