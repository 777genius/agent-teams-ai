// TEST-only negative E2E for publicly downloadable native Host receipts.
// Deliberately fail before process allocation; never open user configuration.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isCompleteNativeHostReceipt, REQUIRED_NATIVE_HOST_STEPS } from './opencode-v2-native-receipt-verify.mjs';

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

function completeReceiptFixture() {
  return {
    kind: 'TEST_NATIVE_HOST_SPI_INSTRUCTIONS', version: '2.0.21',
    cleanup: true, qualified: false, productQualified: false,
    packagedElectronQualified: false, binarySha256: 'f'.repeat(64),
    pid: 1101, processStartTicks: '123456', nativeCustodyReadbacks: 4,
    nativePermissionReadbacks: 4, steps: [...REQUIRED_NATIVE_HOST_STEPS],
    nativeLogReadback: { readOnly: true, synced: true, watermark: 0,
      eventCount: 0, modelTurnProven: false },
    restart: { priorPid: 1101, priorStartTicks: '123456', pid: 1102,
      startTicks: '123489', readOnly: true, actualBinarySha256: 'f'.repeat(64) },
  };
}

test('native receipt gate rejects forged digest, incomplete stages and cold restart uncertainty', () => {
  assert.equal(isCompleteNativeHostReceipt(completeReceiptFixture()), true);
  const mutations = [
    r => { r.steps.pop(); },
    r => { r.steps.splice(r.steps.indexOf('real_native_ordered_ask_readback_without_tool_execution'), 1); },
    r => { r.steps.splice(r.steps.indexOf('real_native_fresh_session_durable_log_cursor_read_only'), 1); },
    r => { delete r.nativeLogReadback; },
    r => { r.nativeLogReadback.synced = false; },
    r => { r.nativeLogReadback.readOnly = false; },
    r => { r.nativeLogReadback.modelTurnProven = true; },
    r => { r.nativeLogReadback.watermark = -1; },
    r => { r.nativeLogReadback.eventCount = 4097; },
    r => { r.steps[0] = 'npm_wrapper_hashed'; },
    r => { r.steps.reverse(); },
    r => { r.binarySha256 = 'unverified'; },
    r => { r.binarySha256 = 'F'.repeat(64); },
    r => { r.nativeCustodyReadbacks = 3; },
    r => { r.nativePermissionReadbacks = 3; },
    r => { r.pid = 0; },
    r => { r.processStartTicks = 'not-a-start'; },
    r => { r.restart.priorPid++; },
    r => { r.restart.priorStartTicks = '1'; },
    r => { r.restart.pid = r.pid; r.restart.startTicks = r.processStartTicks; },
    r => { r.restart.actualBinarySha256 = 'a'.repeat(64); },
    r => { r.restart.readOnly = false; },
    r => { r.cleanup = false; },
    r => { r.cleanupError = 'native_process_cleanup_unconfirmed'; },
    r => { r.qualified = true; },
    r => { r.error = 'native_host_test_failed'; },
  ];
  for (const mutate of mutations) {
    const candidate = completeReceiptFixture();
    mutate(candidate);
    assert.equal(isCompleteNativeHostReceipt(candidate), false);
  }
  assert.equal(isCompleteNativeHostReceipt(undefined), false);
});

test('receipt verifier CLI refuses lockfile-only artifacts with sanitized diagnostics', () => {
  const root = mkdtempSync(join(tmpdir(), 'TEST-v2-native-proof-'));
  const path = join(root, 'receipt.json');
  try {
    for (const [payload, exitCode] of [
      [completeReceiptFixture(), 0],
      [{ lockfileVersion: 3, packages: { 'node_modules/@opencode/cli': { version: '2.0.21' } } }, 1],
      [{ ...completeReceiptFixture(), cleanup: false }, 1],
    ]) {
      writeFileSync(path, JSON.stringify(payload));
      const result = spawnSync(process.execPath, [
        fileURLToPath(new URL('./opencode-v2-native-receipt-verify.mjs', import.meta.url)), path,
      ], { encoding: 'utf8' });
      assert.equal(result.status, exitCode);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, exitCode ? 'native_host_receipt_missing_or_incomplete\n' : '');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
