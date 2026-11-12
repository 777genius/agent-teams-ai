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
): void {
  assert.match(sourceHead, /^[a-f0-9]{40}$/);
  assert.match(version, /^1\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/);
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  const r = value as Record<string, unknown>;
  const keys = [
    'kind', 'sourceHead', 'platform', 'status', 'cleanup', 'selectedCliVersion', 'nativeVersion',
    'nativeDigest', 'nativeIntegrity', 'wireProtocolRevision', 'nodeVersion', 'nodeDigest',
    'providerDigest', 'hostSourceDigest', 'hostDistDigest', 'steps', 'hosts', 'modelOrigin',
    'modelRequests', 'vendorAuthQualified', 'desktopQualified', 'releaseQualified',
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
  assert.deepEqual(r.steps, [...V1_VERSION_HOST_STEPS]);
  assert.deepEqual(r.hosts, [
    { exitCode: 0, signalCode: null, stdoutValid: true },
    { exitCode: 0, signalCode: null, stdoutValid: true },
  ]);
  assert.equal(r.modelOrigin, 'localhost-scripted');
  assert.equal(r.modelRequests, 8);
  assert.equal(r.vendorAuthQualified, false);
  assert.equal(r.desktopQualified, false);
  assert.equal(r.releaseQualified, false);
}
