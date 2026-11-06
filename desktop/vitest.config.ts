import { fileURLToPath } from 'node:url';
import { defineProject } from 'vitest/config';

export default defineProject({
  resolve: {
    alias: { '@agent-hub/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)) },
  },
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    name: 'desktop',
    include: ['src/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['src/test/setup.ts'],
  },
});
