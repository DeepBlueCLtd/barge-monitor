import { defineConfig } from '@playwright/test';

// End-to-end tests against the assembled static site (npm run site), served
// by a plain file server: no application server anywhere (NFR-01).
export default defineConfig({
  testDir: 'e2e',
  timeout: 300_000,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: 'e2e-results.json' }]],
  use: { baseURL: 'http://localhost:8080/', viewport: { width: 1400, height: 1000 } },
  webServer: { command: 'node scripts/serve.mjs ../dist-site', port: 8080, reuseExistingServer: true },
});
