import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['shared', 'hub', 'hub/vitest.migrations.config.ts', 'agent', 'web', 'desktop'],
  },
});
