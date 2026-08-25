import { join } from 'node:path';

import { defineConfig } from '@playwright/test';

const outputDir = process.env.HOSTED_E2E_OUTPUT_DIR;
if (!outputDir) throw new Error('HOSTED_E2E_OUTPUT_DIR is required');

export default defineConfig({
  testDir: '.',
  testMatch: 'hosted-v1.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  outputDir,
  reporter: [['line'], ['json', { outputFile: join(outputDir, 'results.json') }]],
  use: {
    browserName: 'chromium',
    headless: true,
    ignoreHTTPSErrors: true,
    // Screenshots and traces can retain the personal pairing secret in pixels or locator inputs.
    // The runner retains only bounded, post-redacted text/JSON evidence.
    screenshot: 'off',
    trace: 'off',
    video: 'off',
  },
});
