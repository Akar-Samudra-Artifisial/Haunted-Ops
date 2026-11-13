import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { SKIP_MESSAGE, dbGuard } from './db-guard.js';

const apiRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * Runs once before all test files. With a Test database it empties the
 * `public` schema and applies the committed migrations from scratch, so every
 * run starts from an empty, fully migrated database.
 */
export default async function setup(): Promise<void> {
  // The Hunt tests start the fake kiro-cli, which starts the built Exorcist MCP server (and that
  // imports the built shared package). Build both once for the whole run.
  const tsc = fileURLToPath(new URL('../../../node_modules/.bin/tsc', import.meta.url));
  for (const pkg of ['shared', 'exorcist-mcp']) {
    execFileSync(tsc, ['-p', fileURLToPath(new URL(`../../../packages/${pkg}/tsconfig.build.json`, import.meta.url))], { stdio: 'ignore' });
  }
  const guard = dbGuard();
  if (!guard.run) {
    process.stdout.write(`\n[haunted-ops] ${SKIP_MESSAGE}\n\n`);
    return;
  }

  const client = new pg.Client({ connectionString: guard.url });
  await client.connect();
  try {
    await client.query('DROP SCHEMA IF EXISTS public CASCADE');
    await client.query('CREATE SCHEMA public');
  } finally {
    await client.end();
  }

  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: apiRoot,
    // Point Prisma at the Test database only. Output is not echoed: it names the database host.
    env: { ...process.env, DATABASE_URL: guard.url },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
}
