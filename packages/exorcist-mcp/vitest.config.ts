import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@haunted-ops/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 20_000,
    setupFiles: [fileURLToPath(new URL('../../packages/shared/test/setup-fast-check.ts', import.meta.url))],
  },
});
