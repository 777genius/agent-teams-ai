// TEST-only negative E2E for publicly downloadable native Host receipts.
// Deliberately fail before process allocation; never open user configuration.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

test('a failed native Host proof publishes only sanitized diagnostics and no raw paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'TEST-v2-host-failure-receipt-'));
  const path = join(root, 'receipt.json');
  const secret = 'TEST_PRIVATE_SECRET_' + randomBytes(12).toString('hex');
  try {
    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL('./opencode-v2-native-instructions.mjs', import.meta.url)),
    ], {
      env: { ...process.env, OPENCODE_V2_TEST_NPM_ROOT: '/' + secret,
        OPENCODE_V2_HOST_NATIVE_RECEIPT: path },
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1, 'unsupported native root must fail closed');
    const receipt = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(receipt.error, 'native_host_test_failed');
    assert.equal(receipt.qualified, false);
    assert.equal(receipt.productQualified, false);
    assert.equal(receipt.packagedElectronQualified, false);
    assert.equal(receipt.cleanup, true, 'no native process was allocated');
    assert.equal(receipt.pid, undefined);
    assert.equal(receipt.processStartTicks, undefined);
    assert.doesNotMatch(JSON.stringify(receipt) + result.stderr, /TEST_PRIVATE_SECRET_|\bat\s+file:\/\//);
    assert.match(result.stderr, /native_host_test_failed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
