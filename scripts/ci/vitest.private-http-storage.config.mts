import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  cacheDir: resolve(process.env.PRIVATE_HTTP_TEST_CACHE ?? tmpdir(), 'private-http-storage-cache'),
  test: {
    environment: 'node',
    setupFiles: [],
    include: [
      'test/features/local-http-auth/privateAcl.test.ts',
      'test/features/local-http-auth/privateStorage.test.ts',
    ],
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
  resolve: { alias: { '@features': resolve('src/features') } },
});
