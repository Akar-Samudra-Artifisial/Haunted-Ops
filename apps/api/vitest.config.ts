import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// Local, git-ignored env file (DATABASE_URL, TEST_DATABASE_URL). Existing env vars win.
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
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    // Integration tests share one Test database, so files run one at a time.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
