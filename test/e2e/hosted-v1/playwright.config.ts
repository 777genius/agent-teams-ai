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
    screenshot: 'only-on-failure',
    // Traces record locator.fill arguments and would retain the personal pairing secret.
    trace: 'off',
  },
});
