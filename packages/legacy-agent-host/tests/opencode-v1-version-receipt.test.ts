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
    preferencesSelection: { defaultModelId: 'TEST-local/TEST-model-B', contextTokens: 64000, outputTokens: 1024 },
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
  preferencesSelection: { defaultModelId: 'TEST-local/TEST-model', contextTokens: 64000, outputTokens: 2000 },
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

const expectedUpdate = { electronVersion: '44.10.1', electronSha256: '8'.repeat(64) };
function updateFixture(): Record<string, unknown> {
  const before = {
    native: { pid: 1200, parent: 1199, birth: '123456789', device: '2049', inode: '9999', executableSha256: 'b'.repeat(64) },
    binarySha256: 'b'.repeat(64), profileSha256: '1'.repeat(64), sessionSha256: '2'.repeat(64),
    runtimeStateSha256: '3'.repeat(64), projectionSha256: '4'.repeat(64), checkpointSha256: '5'.repeat(64),
  };
  return { ...fixture(), selectedCliVersion: '1.19.4', nativeVersion: '1.19.4',
    steps: [...V1_VERSION_HOST_STEPS.slice(0, 2), 'managed_update_preserved_pending_native_session', ...V1_VERSION_HOST_STEPS.slice(2)],
    managedUpdate: { before, after: structuredClone(before), fromVersion: '1.19.4', toVersion: '1.19.5',
      source: 'app-managed', updatedBinarySha256: '9'.repeat(64), updatedIntegrity: `sha512-${Buffer.alloc(64).toString('base64')}`,
      oldManifestSha256: '6'.repeat(64), newManifestSha256: '7'.repeat(64),
      installerBundleSha256: 'a'.repeat(64), installerSourceSha256: 'c'.repeat(64), ...expectedUpdate,
      installerProcesses: [{ exitCode: 0, signalCode: null, cleanup: true }, { exitCode: 0, signalCode: null, cleanup: true }],
    },
  };
}
const verifyUpdate = (value: unknown) => verifyNativeV1VersionReceipt(value, head, '1.19.4', build, expectedUpdate);

test('baseline receipt requires actual managed-update evidence and the exact Electron binary', () => {
  assert.doesNotThrow(() => verifyUpdate(updateFixture()));
  const missing = updateFixture(); delete missing.managedUpdate;
  assert.throws(() => verifyUpdate(missing));
  assert.throws(() => verifyNativeV1VersionReceipt(updateFixture(), head, '1.19.4', build));
  assert.throws(() => verifyNativeV1VersionReceipt(updateFixture(), head, '1.19.4', build,
    { ...expectedUpdate, electronSha256: '0'.repeat(64) }));
});

for (const changed of ['pid', 'birth', 'inode', 'binarySha256', 'sessionSha256', 'runtimeStateSha256',
  'checkpointSha256', 'projectionSha256']) {
  test(`managed update cannot conceal changed original ${changed}`, () => {
    const receipt = updateFixture();
    const update = receipt.managedUpdate as Record<string, unknown>;
    const after = update.after as Record<string, unknown>;
    if (['pid', 'birth', 'inode'].includes(changed)) {
      const native = after.native as Record<string, unknown>;
      native[changed] = changed === 'pid' ? 1201 : '987654321';
    } else after[changed] = '0'.repeat(64);
    assert.throws(() => verifyUpdate(receipt));
  });
}
for (const [key, wrong] of Object.entries({
  source: 'override', toVersion: '2.1.4', updatedBinarySha256: 'b'.repeat(64),
  newManifestSha256: '6'.repeat(64), installerSourceSha256: '', electronVersion: '1.0.0',
  installerProcesses: [{ exitCode: 0, signalCode: null, cleanup: true }, { exitCode: 1, signalCode: null, cleanup: false }],
})) {
  test(`managed update refuses unproved ${key}`, () => {
    const receipt = updateFixture();
    (receipt.managedUpdate as Record<string, unknown>)[key] = wrong;
    assert.throws(() => verifyUpdate(receipt));
  });
}
