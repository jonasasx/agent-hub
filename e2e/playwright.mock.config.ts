import { defineConfig, devices } from '@playwright/test';

// Web e2e against an in-memory hub (mock/hub.ts): the Vite dev server serves the app, the API and /ws/ui are
// answered by route interception. The same scenarios on the live stand run from playwright.config.ts (QA).
// a port of its own, and never another worktree's Vite on it (QA M3c: the run picked up a foreign dev server)
const PORT = Number(process.env.E2E_MOCK_PORT ?? 5191);
// change voice-input: Chromium's fake microphone (a beep) granted without the permission prompt, for the dictation tests;
// the other tests never ask for media
const FAKE_MIC = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'];

export default defineConfig({
  testDir: 'tests-mock',
  timeout: 30_000,
  // several windows per test and the image tests run in parallel against one dev server: give the UI time
  expect: { timeout: 10_000 },
  fullyParallel: true,
  use: {
    baseURL: `http://localhost:${PORT}`,
    channel: process.env.E2E_CHANNEL ?? undefined,
    // Requests of a service worker would bypass route interception.
    serviceWorkers: 'block',
  },
  webServer: {
    command: `npm run dev -w web -- --port ${PORT} --strictPort`,
    cwd: '..',
    url: `http://localhost:${PORT}`,
    reuseExistingServer: process.env.E2E_REUSE_SERVER === '1',
    timeout: 60_000,
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, launchOptions: { args: FAKE_MIC } }, testMatch: [/desktop\..*spec\.ts/, /ui-gates\.spec\.ts/] },
    { name: 'phone', use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 }, launchOptions: { args: FAKE_MIC } }, testMatch: [/phone\..*spec\.ts/, /ui-gates\.spec\.ts/] },
  ],
});
