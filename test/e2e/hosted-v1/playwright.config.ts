import { join } from 'node:path';

import { defineConfig } from '@playwright/test';

import {
  HOSTED_V1_BROWSER_SUITES,
  parseHostedV1BrowserSuite,
} from '../../fixtures/hosted-v1/browserSuites';

const outputDir = process.env.HOSTED_E2E_OUTPUT_DIR;
if (!outputDir) throw new Error('HOSTED_E2E_OUTPUT_DIR is required');

const suite = parseHostedV1BrowserSuite(process.env.HOSTED_E2E_SUITE);

export default defineConfig({
  testDir: '.',
  testMatch: HOSTED_V1_BROWSER_SUITES[suite].testMatch,
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
