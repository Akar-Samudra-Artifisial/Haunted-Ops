// Prisma configuration for the demo server. The repository config (apps/api/prisma.config.ts) is TypeScript and
// imports "prisma/config"; a plain object does the same job and needs no TypeScript loader.
// Used by install.sh as: prisma <command> --config deploy/server/prisma.config.mjs, with DATABASE_URL in the environment.
import { fileURLToPath } from 'node:url';

const here = (relative) => fileURLToPath(new URL(relative, import.meta.url));

export default {
  schema: here('../../apps/api/prisma/schema.prisma'),
  migrations: { path: here('../../apps/api/prisma/migrations') },
  datasource: { url: process.env.DATABASE_URL },
};
