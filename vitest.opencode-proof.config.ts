import { defineConfig } from 'vitest/config';

import baseConfig from './vitest.config';

// Only these proof entrypoints may preserve wrapper-owned HOME/XDG paths.
export default defineConfig({
  resolve: baseConfig.resolve,
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 15000,
    setupFiles: ['./test/opencode-proof.setup.ts'],
    include: [
      'test/main/services/team/OpenCodeFullTeamCollaboration.live.test.ts',
      'test/main/services/team/OpenCodeMixedTeamCollaboration.live.test.ts',
      'test/scripts/fixtures/opencodeProofBoundary.test.ts',
    ],
  },
});
