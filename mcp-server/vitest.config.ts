import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: ['test/**/*.e2e.test.ts'],
    testTimeout: 15_000,
  },
});
