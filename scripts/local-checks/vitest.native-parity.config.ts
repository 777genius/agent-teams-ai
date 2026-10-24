import { defineConfig } from 'vitest/config';

// Opt in only: ordinary Vitest discovery and dependencies remain unchanged.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/native-tool-parity/*.pilot.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    maxWorkers: 1,
  },
});
