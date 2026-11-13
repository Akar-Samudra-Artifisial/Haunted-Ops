import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@haunted-ops/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
    },
  },
  // The manifest lets scripts/check-scene-bundle.mjs find the chunk behind the dynamic import.
  build: { manifest: true },
  server: { port: 5173 },
  test: { environment: 'jsdom', include: ['src/**/*.test.{ts,tsx}'] },
});
