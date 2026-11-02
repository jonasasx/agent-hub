import { fileURLToPath } from 'node:url';
import { defineProject } from 'vitest/config';

export default defineProject({
  resolve: {
    alias: {
      '@agent-hub/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
    },
  },
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    name: 'agent',
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // The integration test runs a real hub against Postgres.
    globalSetup: ['../hub/src/test/globalSetup.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
