import { defineConfig } from '@playwright/test';

// End-to-end tests against the assembled static site (npm run site), served
// by a plain file server: no application server anywhere (NFR-01).
// E2E_BACKEND=python runs the same tests against the Python back end (e2e/backend.ts);
// PORT moves the file server (default 8080).
const PORT = Number(process.env.PORT ?? 8080);
export default defineConfig({
  testDir: 'e2e',
  timeout: 420_000,
  retries: 0,
  workers: 1,
  reporter: [['list'], ['json', { outputFile: process.env.E2E_BACKEND === 'python' ? 'e2e-results-python.json' : 'e2e-results.json' }]],
  use: { baseURL: `http://localhost:${PORT}/`, viewport: { width: 1920, height: 1080 } },
  webServer: { command: 'node scripts/serve.mjs ../dist-site', port: PORT, reuseExistingServer: true },
});
