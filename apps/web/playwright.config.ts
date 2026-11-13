import { defineConfig, devices } from '@playwright/test';

// Browsers live inside the workspace (node_modules), not in a global cache:
//   PLAYWRIGHT_BROWSERS_PATH=0 pnpm --filter @haunted-ops/web exec playwright install chromium
process.env.PLAYWRIGHT_BROWSERS_PATH ??= '0';

const PORT = 4173;

export default defineConfig({
  testDir: 'e2e',
  // Screenshots and traces go here. The folder is git-ignored.
  outputDir: 'test-results',
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1280, height: 720 },
    // Software WebGL, so the smoke test needs no GPU.
    launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 720 } } }],
  webServer: {
    command: `pnpm exec vite --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
