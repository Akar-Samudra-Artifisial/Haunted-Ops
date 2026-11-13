import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// The opt-in live test: one real Hunt with the real kiro-cli against a running Lab. It spends Credits,
// so it is not part of `pnpm test`. Run it with:  HUNT_LIVE=1 pnpm --filter ./apps/api test:live
const envFile = fileURLToPath(new URL('.env', import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

export default defineConfig({
  plugins: [
    swc.vite({
      jsc: {
        target: 'es2023',
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
      },
    }),
  ],
  resolve: {
    alias: {
      '@haunted-ops/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
      '@haunted-ops/exorcist-mcp/schemas': fileURLToPath(new URL('../../packages/exorcist-mcp/src/schemas.ts', import.meta.url)),
      '@haunted-ops/exorcist-mcp/untrusted': fileURLToPath(new URL('../../packages/exorcist-mcp/src/untrusted.ts', import.meta.url)),
      '@haunted-ops/exorcist-mcp/ledger': fileURLToPath(new URL('../../packages/exorcist-mcp/src/ledger.ts', import.meta.url)),
    },
  },
  test: {
    include: ['test-live/**/*.live.ts'],
    fileParallelism: false,
    testTimeout: 240_000,
    hookTimeout: 60_000,
  },
});
