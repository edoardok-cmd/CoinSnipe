import { defineConfig } from '@playwright/test';

/**
 * Marketing page checks (CSN-010). Run against a running build:
 *   pnpm --filter @coinsnipe/web build && pnpm --filter @coinsnipe/web start -p 3555
 *   E2E_BASE_URL=http://127.0.0.1:3555 pnpm --filter @coinsnipe/web exec playwright test -c e2e/playwright.config.ts
 * `channel: 'chrome'` uses the installed Google Chrome; set E2E_CHANNEL= (empty) to use Playwright's own Chromium.
 * The CI job that wires this up is CSN-074.
 */
export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  reporter: 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3555',
    channel:
      process.env.E2E_CHANNEL === undefined ? 'chrome' : process.env.E2E_CHANNEL || undefined,
  },
});
