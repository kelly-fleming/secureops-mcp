import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    pool: 'forks',
    isolate: true,
    maxConcurrency: 1,
    include: ['tests/**/*.test.ts'],
    setupFiles: ['./tests/setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      thresholds: {
        'src/application/**': { lines: 80, branches: 80 },
        'src/domain/**': { lines: 80, branches: 80 },
        'src/security/**': { lines: 80, branches: 80 },
      },
    },
  },
});
