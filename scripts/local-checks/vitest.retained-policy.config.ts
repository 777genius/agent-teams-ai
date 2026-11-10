import { defineConfig } from 'vitest/config';

// Separate explicit audit: inherited fallback gaps must remain visible failures.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/native-tool-parity/*.audit.ts'],
    hookTimeout: 120_000,
    testTimeout: 60_000,
    maxWorkers: 1,
  },
});
