import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    // agents created without a stateDir must never touch the real ~/.agent-hub: its codex-homes hold live auth.json
    env: { AGENT_STATE_DIR: mkdtempSync(join(tmpdir(), 'agent-hub-test-state-')) },
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
