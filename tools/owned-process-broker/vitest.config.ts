import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { environment: 'node',
  include: ['tools/owned-process-broker/protocol.test.ts'], testTimeout: 5000 } });
