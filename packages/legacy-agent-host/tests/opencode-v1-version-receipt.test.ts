import assert from 'node:assert/strict';
import { test } from 'node:test';

import { verifyNativeV1VersionReceipt, V1_VERSION_HOST_STEPS } from './opencode-v1-version-receipt.ts';

const head = 'a'.repeat(40);
const version = '1.19.5';
const build = { providerDigest: 'd'.repeat(64), hostSourceDigest: 'e'.repeat(64), hostDistDigest: 'f'.repeat(64) };
function fixture(): Record<string, unknown> {
  return {
    kind: 'TEST_NATIVE_V1_VERSION_HOST', sourceHead: head, platform: 'linux-x64',
    status: 'PASS', cleanup: true, selectedCliVersion: version, nativeVersion: version,
    nativeDigest: 'b'.repeat(64), nativeIntegrity: `sha512-${Buffer.alloc(64).toString('base64')}`,
    wireProtocolRevision: '1.19.4', nodeVersion: 'v24.21.0', nodeDigest: 'c'.repeat(64),
    providerDigest: 'd'.repeat(64), hostSourceDigest: 'e'.repeat(64), hostDistDigest: 'f'.repeat(64),
    steps: [...V1_VERSION_HOST_STEPS],
    hosts: [
      { exitCode: 0, signalCode: null, stdoutValid: true },
      { exitCode: 0, signalCode: null, stdoutValid: true },
    ],
    modelOrigin: 'localhost-scripted', modelRequests: 8,
    vendorAuthQualified: false, desktopQualified: false, releaseQualified: false,
  };
}

test('receipt validator accepts a complete scoped TEST shape, not a vendor certificate', () => {
  assert.doesNotThrow(() => verifyNativeV1VersionReceipt(fixture(), head, version, build));
});

for (const [key, wrong] of Object.entries({
  sourceHead: '0'.repeat(40), selectedCliVersion: '1.19.4', nativeVersion: '2.1.4',
  platform: 'darwin-arm64', status: 'INCOMPLETE', cleanup: false, nativeDigest: '',
  nodeVersion: 'v22.16.0', wireProtocolRevision: 'latest', modelRequests: 9,
  nativeIntegrity: 'sha512-aA==', modelOrigin: 'paid-provider', releaseQualified: true,
  vendorAuthQualified: true, desktopQualified: true, steps: V1_VERSION_HOST_STEPS.slice(0, 4),
  hostSourceDigest: '0'.repeat(64), hostDistDigest: '1'.repeat(64), providerDigest: '2'.repeat(64),
  hosts: [{ exitCode: 0, signalCode: null, stdoutValid: true }],
})) {
  test(`receipt validator refuses missing or mismatched ${key}`, () => {
    assert.throws(() => verifyNativeV1VersionReceipt({ ...fixture(), [key]: wrong }, head, version, build));
    const missing = fixture(); delete missing[key];
    assert.throws(() => verifyNativeV1VersionReceipt(missing, head, version, build));
  });
}

test('receipt validator refuses reordered stages and unknown diagnostic data', () => {
  assert.throws(() => verifyNativeV1VersionReceipt({ ...fixture(), steps: [...V1_VERSION_HOST_STEPS].reverse() }, head, version, build));
  assert.throws(() => verifyNativeV1VersionReceipt({ ...fixture(), rawError: 'TEST-private' }, head, version, build));
});
