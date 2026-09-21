import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isRetryableInstallFailure } from '../../scripts/ci/install-dependencies-with-retry.mjs';

describe('install-dependencies-with-retry', () => {
  for (const output of [
    'HTTPError: Response code 504 (Gateway Time-out)',
    'request failed with status code 502',
    'ERR_PNPM_FETCH_503 GET https://registry.npmjs.org/package',
    'ERR_PNPM_META_FETCH_FAIL ECONNRESET',
    'getaddrinfo EAI_AGAIN registry.npmjs.org',
    'socket hang up while downloading Electron',
  ]) {
    it(`retries transient network failure: ${output}`, () => {
      assert.equal(isRetryableInstallFailure(output), true);
    });
  }

  for (const output of [
    'ERR_PNPM_OUTDATED_LOCKFILE Cannot install with frozen-lockfile',
    'Unsupported engine: wanted node >=99',
    'Lifecycle script failed with exit code 1',
    'HTTPError: Response code 404 (Not Found)',
  ]) {
    it(`does not retry deterministic failure: ${output}`, () => {
      assert.equal(isRetryableInstallFailure(output), false);
    });
  }
});
