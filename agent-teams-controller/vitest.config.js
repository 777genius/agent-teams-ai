const { defineConfig } = require('vitest/config');

module.exports = defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.js', 'test/**/*.test.ts'],
    testTimeout: 15_000,
  },
});
