import { fileURLToPath } from 'node:url';
import { defineProject } from 'vitest/config';

export default defineProject({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    name: 'shared',
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
