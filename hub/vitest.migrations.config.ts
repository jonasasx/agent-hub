import { fileURLToPath } from 'node:url';
import { defineProject } from 'vitest/config';

// Migration tests: each builds databases from scratch (no template) and runs every migration, so they get their own
// project — one file at a time, longer timeouts — instead of competing with the rest of the hub tests for time limits.
export default defineProject({
  resolve: {
    alias: { '@agent-hub/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)) },
  },
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    name: 'hub-migrations',
    include: ['src/db/migrate.test.ts', 'src/start.test.ts'],
    environment: 'node',
    globalSetup: ['src/test/globalSetup.ts'],
    fileParallelism: false,
    // after every other project (groupOrder 0): alone each test takes ≤3 s, beside ~60 workers creating databases one
    // hit the 90 s limit
    sequence: { groupOrder: 1 },
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
