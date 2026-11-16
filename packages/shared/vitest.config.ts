import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { include: ['test/**/*.test.ts'], setupFiles: [fileURLToPath(new URL('./test/setup-fast-check.ts', import.meta.url))] },
});
