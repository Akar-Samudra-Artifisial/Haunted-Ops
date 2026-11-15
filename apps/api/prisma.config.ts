import { existsSync } from 'node:fs';
import { defineConfig } from 'prisma/config';

// Prisma 7 does not load .env files itself. Load the local, git-ignored file if present.
if (existsSync('.env')) process.loadEnvFile('.env');

const url = process.env.DATABASE_URL;
// `migrate diff --from-migrations` (the `db:drift` script) replays the migrations into a shadow database. The test
// database serves: every test run resets it anyway. Never a hard-coded URL; absent when the variable is unset.
// The test setup migrates the test database itself (DATABASE_URL set to it); a shadow equal to the main database is
// refused by Prisma, so it is only set when it differs.
const testUrl = process.env.TEST_DATABASE_URL || undefined;
const shadowDatabaseUrl = testUrl !== undefined && testUrl !== url ? testUrl : undefined;

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  // Only migrate and seed need the URL; `prisma generate` runs without it.
  ...(url || shadowDatabaseUrl ? { datasource: { ...(url ? { url } : {}), ...(shadowDatabaseUrl ? { shadowDatabaseUrl } : {}) } } : {}),
});
