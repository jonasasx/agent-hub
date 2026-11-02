import { fileURLToPath } from 'node:url';
import { defineProject } from 'vitest/config';

export default defineProject({
  resolve: {
    // the 1.3 snapshot first: a prefix alias would turn it into …/index.ts/snapshots/… (claude-subscriptions 7.2)
    alias: {
      '@agent-hub/shared/snapshots/protocol-1.3': fileURLToPath(new URL('../shared/src/snapshots/protocol-1.3.ts', import.meta.url)),
      '@agent-hub/shared/snapshots/protocol-1.6': fileURLToPath(new URL('../shared/src/snapshots/protocol-1.6.ts', import.meta.url)),
      '@agent-hub/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
    },
  },
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    name: 'hub',
    include: ['src/**/*.test.ts'],
    // In the project hub-migrations (vitest.migrations.config.ts).
    exclude: ['src/db/migrate.test.ts', 'src/start.test.ts'],
    environment: 'node',
    // One Postgres for the run (Docker container, or TEST_DATABASE_URL); each test file gets its own database.
    globalSetup: ['src/test/globalSetup.ts'],
    testTimeout: 20_000,
    // a test database with all migrations and the fixtures: beyond 2 min when the full run loads the machine
    hookTimeout: 240_000,
  },
});
