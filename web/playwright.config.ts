import { defineConfig } from '@playwright/test';
import { PORT, SUB_PORT, SUB_PREFIXES } from './e2e/site';

// End-to-end tests against the assembled static site (npm run site), served
// by a plain file server: no application server anywhere (NFR-01). The site is
// served twice: at the root, and under a pull request's published sub-path.
export default defineConfig({
  testDir: 'e2e',
  timeout: 420_000,
  retries: 0,
  workers: 1,
  reporter: [['list'], ['json', { outputFile: 'e2e-results.json' }]],
  use: { baseURL: `http://localhost:${PORT}/`, viewport: { width: 1920, height: 1080 } },
  webServer: [
    { command: 'node scripts/serve.mjs ../dist-site', port: PORT, reuseExistingServer: true, env: { PORT: String(PORT) } },
    { command: 'node scripts/serve.mjs ../dist-site', port: SUB_PORT, reuseExistingServer: true, env: { PORT: String(SUB_PORT), PREFIXES: SUB_PREFIXES } },
  ],
});
