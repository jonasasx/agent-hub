import { defineConfig, devices } from '@playwright/test';

// Runs against a live hub: E2E_BASE_URL (default http://localhost:8080). For a local hub start it with
// NODE_ENV=test and AUTH_DEV_EMAIL so /auth/dev-login replaces Google OIDC.
export default defineConfig({
  testDir: 'tests',
  timeout: 30_000,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:8080',
    // Use the installed Edge/Chrome when Playwright browsers are not downloaded.
    channel: process.env.E2E_CHANNEL ?? undefined,
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'phone', use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } } },
  ],
});
