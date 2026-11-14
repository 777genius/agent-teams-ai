import assert from 'node:assert/strict';
import type { NativeV1HostBuild } from './opencode-v1-version-source.ts';

/** Required original native stages; a green process or hand-written ACK alone cannot pass. */
export const V1_VERSION_HOST_STEPS = [
  'native_version_package_integrity_and_source_measured',
  'original_host_native_runtime_and_mcp_ready',
  'native_model_tools_permission_task_and_reply_completed_once',
  'original_host_runtime_stop_and_cleanup_confirmed',
  'cold_receipt_readback_without_native_replay_or_source_mutation',
] as const;

/** Validate a sanitized receipt against the exact source and selected CLI of this TEST run. */
export function verifyNativeV1VersionReceipt(
  value: unknown, sourceHead: string, version: string, build: NativeV1HostBuild,
  expectedUpdate?: { electronVersion: string; electronSha256: string },
): void {
  assert.match(sourceHead, /^[a-f0-9]{40}$/);
  assert.match(version, /^1\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/);
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  const r = value as Record<string, unknown>;
  const keys = [
    'kind', 'sourceHead', 'platform', 'status', 'cleanup', 'selectedCliVersion', 'nativeVersion',
    'nativeDigest', 'nativeIntegrity', 'wireProtocolRevision', 'nodeVersion', 'nodeDigest',
    'providerDigest', 'hostSourceDigest', 'hostDistDigest', 'steps', 'hosts', 'modelOrigin',
    'modelRequests', 'coordination', 'preferencesSelection', 'vendorAuthQualified', 'desktopQualified', 'releaseQualified',
    ...(expectedUpdate ? ['managedUpdate'] : []),
  ];
  assert.deepEqual(Object.keys(r).sort(), keys.sort(), 'no missing proof or extra private diagnostics');
  assert.equal(r.kind, 'TEST_NATIVE_V1_VERSION_HOST');
  assert.equal(r.platform, 'linux-x64');
  assert.equal(r.sourceHead, sourceHead);
  assert.equal(r.status, 'PASS');
  assert.equal(r.cleanup, true);
  assert.equal(r.selectedCliVersion, version);
  assert.equal(r.nativeVersion, version);
  assert.equal(r.wireProtocolRevision, '1.19.4');
  assert.equal(r.nodeVersion, 'v24.21.0');
  for (const key of ['nativeDigest', 'nodeDigest', 'providerDigest', 'hostSourceDigest', 'hostDistDigest'])
    assert.ok(typeof r[key] === 'string' && /^[a-f0-9]{64}$/.test(r[key] as string), key);
  for (const key of ['hostSourceDigest', 'hostDistDigest', 'providerDigest'] as const) {
    assert.match(build[key], /^[a-f0-9]{64}$/);
    assert.equal(r[key], build[key], 'receipt must attest the source and build from this runner');
  }
  assert.equal(typeof r.nativeIntegrity, 'string');
  assert.match(r.nativeIntegrity as string, /^sha512-[A-Za-z0-9+/]+={0,2}$/);
  assert.equal(Buffer.from((r.nativeIntegrity as string).slice(7), 'base64').length, 64);
  assert.deepEqual(r.steps, expectedUpdate
    ? [...V1_VERSION_HOST_STEPS.slice(0, 2), 'managed_update_preserved_pending_native_session', ...V1_VERSION_HOST_STEPS.slice(2)]
    : [...V1_VERSION_HOST_STEPS]);
  assert.deepEqual(r.hosts, [
    { exitCode: 0, signalCode: null, stdoutValid: true },
    { exitCode: 0, signalCode: null, stdoutValid: true },
  ]);
  assert.equal(r.modelOrigin, 'localhost-scripted');
  assert.equal(r.modelRequests, 8);
  assert.deepEqual(r.coordination, { status: 'unqualified', cleanup: null });
  assert.deepEqual(r.preferencesSelection, {
    defaultModelId: 'TEST-local/TEST-model-B', contextTokens: 64000, outputTokens: 1024,
  });
  assert.equal(r.vendorAuthQualified, false);
  assert.equal(r.desktopQualified, false);
  assert.equal(r.releaseQualified, false);
  if (expectedUpdate) verifyManagedUpdate(r.managedUpdate, r.nativeDigest, version, expectedUpdate);
}

function verifyManagedUpdate(value: unknown, nativeDigest: unknown, version: string,
  expected: { electronVersion: string; electronSha256: string }): void {
  const object = (item: unknown, keys: string[]) => {
    assert.ok(item !== null && typeof item === 'object' && !Array.isArray(item));
    assert.deepEqual(Object.keys(item).sort(), keys.sort());
    return item as Record<string, unknown>;
  };
  const sha = (item: unknown) => { assert.equal(typeof item, 'string'); assert.match(item as string, /^[a-f0-9]{64}$/); };
  assert.equal(version, '1.19.4', 'the active update belongs only to the baseline scenario');
  const update = object(value, ['before', 'after', 'fromVersion', 'toVersion', 'source',
    'updatedBinarySha256', 'updatedIntegrity', 'oldManifestSha256', 'newManifestSha256',
    'installerBundleSha256', 'installerSourceSha256', 'electronVersion', 'electronSha256', 'installerProcesses']);
  assert.equal(update.fromVersion, version); assert.equal(update.source, 'app-managed');
  assert.equal(typeof update.toVersion, 'string');
  assert.match(update.toVersion as string, /^1\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/);
  const [, minor, patch] = (update.toVersion as string).split('.').map(Number);
  assert.ok(Number.isSafeInteger(minor) && Number.isSafeInteger(patch) &&
    (minor! > 19 || minor === 19 && patch! > 4), 'an actual newer V1 release was selected');
  const before = object(update.before, ['native', 'binarySha256', 'profileSha256', 'sessionSha256',
    'runtimeStateSha256', 'projectionSha256', 'checkpointSha256']);
  const native = object(before.native, ['pid', 'parent', 'birth', 'device', 'inode', 'executableSha256']);
  for (const key of ['pid', 'parent']) assert.ok(Number.isSafeInteger(native[key]) && (native[key] as number) > 0);
  for (const key of ['birth', 'device', 'inode']) {
    assert.equal(typeof native[key], 'string'); assert.match(native[key] as string, /^\d+$/);
  }
  for (const key of ['binarySha256', 'profileSha256', 'sessionSha256', 'runtimeStateSha256',
    'projectionSha256', 'checkpointSha256']) sha(before[key]);
  assert.equal(before.binarySha256, nativeDigest); assert.equal(native.executableSha256, nativeDigest);
  assert.deepEqual(update.after, before, 'old executable, process birth, session, pending input and checkpoint all survive update');
  for (const key of ['updatedBinarySha256', 'oldManifestSha256', 'newManifestSha256',
    'installerBundleSha256', 'installerSourceSha256', 'electronSha256']) sha(update[key]);
  assert.notEqual(update.updatedBinarySha256, nativeDigest);
  assert.notEqual(update.oldManifestSha256, update.newManifestSha256);
  assert.equal(typeof update.updatedIntegrity, 'string');
  assert.match(update.updatedIntegrity as string, /^sha512-[A-Za-z0-9+/]+={0,2}$/);
  assert.equal(Buffer.from((update.updatedIntegrity as string).slice(7), 'base64').length, 64);
  assert.equal(update.electronVersion, expected.electronVersion);
  assert.equal(update.electronSha256, expected.electronSha256);
  assert.deepEqual(update.installerProcesses, [
    { exitCode: 0, signalCode: null, cleanup: true },
    { exitCode: 0, signalCode: null, cleanup: true },
  ]);
}
