import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isRetryableInstallFailure } from './install-dependencies-with-retry.mjs';

test('transient release 5xx stays retryable even with a harmless engine warning', () => {
  const output = [
    'packages/legacy-agent-host | WARN Unsupported engine: wanted: {node: >=24 <25}',
    'postinstall: HTTPError: Response code 503 () for https://github.com/electron/electron/releases/download/v44.10.1/electron.zip',
  ].join('\n');
  assert.equal(isRetryableInstallFailure(output), true);
  assert.equal(isRetryableInstallFailure(output.replace('503', '504')), true);
});

test('real install constraints do not become retryable', () => {
  for (const fatal of [
    'ERR_PNPM_UNSUPPORTED_ENGINE: unsupported required engine',
    'ERR_PNPM_OUTDATED_LOCKFILE',
    'HTTPError: Response code 404',
    'HTTPError: Response code 403',
  ]) {
    assert.equal(isRetryableInstallFailure(`Response code 503\n${fatal}`), false, fatal);
  }
  assert.equal(isRetryableInstallFailure('WARN Unsupported engine'), false);
  assert.equal(isRetryableInstallFailure('Failed due to incorrect local configuration'), false);
});
