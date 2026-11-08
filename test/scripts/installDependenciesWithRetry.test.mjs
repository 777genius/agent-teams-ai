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
    'ERR_SOCKET_TIMEOUT while downloading Electron',
    'UND_ERR_CONNECT_TIMEOUT while downloading Electron',
    'Socket timeout while downloading Electron',
    'HTTPError: Response code 504\nELIFECYCLE Command failed with exit code 1',
    'gyp ERR! stack TypeError: terminated',
    'SocketError: other side closed',
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

  it('retries Electron 504 after a nonfatal pnpm workspace engine warning', () => {
    // Native Windows packaged E2E, 2026-11-08: Node 26 warns that this
    // workspace expects Node 24, then Electron fetch hits a real HTTP 504.
    const output = [
      'packages/legacy-agent-host | [WARN] Unsupported engine: wanted: {"node":">=24.21.0 <25"} (current: {"node":"v26.12.1"})',
      '. postinstall: HTTPError: Response code 504 () for https://github.com/electron/electron/releases/download/v44.10.1/electron-v44.10.1-win32-x64.zip',
      '[ELIFECYCLE] Command failed with exit code 1.',
    ].join('\\n');
    assert.equal(isRetryableInstallFailure(output), true);
  });

  it('preserves hard unsupported-engine failures even after a network error', () => {
    for (const output of [
      'HTTPError: Response code 503\\nERR_PNPM_UNSUPPORTED_ENGINE: Unsupported engine',
      'HTTPError: Response code 504\\nUnsupported engine: wanted node >=99',
    ]) {
      assert.equal(isRetryableInstallFailure(output), false);
    }
  });

  it('lets a later deterministic error override an earlier transient marker', () => {
    const output =
      'HTTPError: Response code 503\nERR_PNPM_OUTDATED_LOCKFILE Cannot install with frozen-lockfile';
    assert.equal(isRetryableInstallFailure(output), false);
  });
});
