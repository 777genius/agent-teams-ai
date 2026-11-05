import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { OpenCodeV2RuntimeLock, OpenCodeV2Selection } from '../src/composition/openCodeV2StaticPreflight.ts';

const sourceMode = process.env.LEGACY_PROVIDER_SOURCE_TEST === '1';
const { isCanonicalOpenCodeV2Directory, preflightOpenCodeV2Selection }: typeof import('../src/composition/openCodeV2StaticPreflight.ts') =
  await import(sourceMode
    ? '../src/composition/openCodeV2StaticPreflight.ts'
    : '../dist/composition/openCodeV2StaticPreflight.js');

// Read the Stage 1 checkout's current product manifest, not a duplicate allowlist.
const lock = JSON.parse(readFileSync(new URL('../../../runtime.lock.json', import.meta.url), 'utf8')) as OpenCodeV2RuntimeLock;
const selected: OpenCodeV2Selection = {
  generation: 'v2', platform: 'darwin-arm64', version: '2.0.0',
  nativeReportedVersion: '2.0.0',
  executableSha256: 'a'.repeat(64), observedExecutableSha256: 'a'.repeat(64),
  endpoint: 'http://127.0.0.1:14321', directory: '/TEST-opencode-v2-workspace',
  nativeSessionId: 'ses_TESTowned', sessionBinding: 'TEST-owner/generation1',
  accountBinding: 'TEST-isolated-account',
};

test('V2.0 creates a static candidate, never a native readiness/launch receipt', () => {
  assert.deepEqual(preflightOpenCodeV2Selection(selected, lock), {
    kind: 'candidate', platform: 'darwin-arm64', version: '2.0.0',
    sourceCommit: lock.opencodeV2Delivery!['darwin-arm64']!.sourceCommit,
    archiveSha256: lock.opencodeV2Delivery!['darwin-arm64']!.archive!.sha256,
  });
});

test('driver version and runtime manifest qualification are separate gates', () => {
  for (const version of ['2.0.32', '2.1.4', '3.0.0', '1.19.4'])
    assert.deepEqual(preflightOpenCodeV2Selection({ ...selected, version, nativeReportedVersion: version }, lock),
      { kind: 'hold', reason: 'driver-version' });
  assert.deepEqual(preflightOpenCodeV2Selection({ ...selected, version: '2.0.21', nativeReportedVersion: '2.0.21' }, lock),
    { kind: 'hold', reason: 'runtime-version' });
  for (const platform of ['win32-x64', 'win32-arm64'])
    assert.deepEqual(preflightOpenCodeV2Selection({ ...selected, platform }, lock),
      { kind: 'hold', reason: 'runtime-version' });
  assert.deepEqual(preflightOpenCodeV2Selection({ ...selected, platform: 'linux-arm64' }, lock),
    { kind: 'hold', reason: 'delivery' });
});

test('no implicit V1 promotion, forged binary, endpoint, identity or missing native proof', () => {
  const cases: Array<[Partial<OpenCodeV2Selection>, string]> = [
    [{ generation: 'v1' }, 'generation'],
    [{ platform: 'unknown' }, 'generation'],
    [{ nativeReportedVersion: '2.0.32' }, 'native-version'],
    [{ observedExecutableSha256: 'b'.repeat(64) }, 'binary-digest'],
    [{ executableSha256: '' }, 'binary-digest'],
    [{ endpoint: 'http://localhost:14321' }, 'binding'],
    [{ endpoint: 'http://127.0.0.1:65536' }, 'binding'],
    [{ endpoint: 'http://127.0.0.1:14321/foreign' }, 'binding'],
    [{ nativeSessionId: 'V1_session' }, 'binding'],
    [{ sessionBinding: '' }, 'binding'],
    [{ accountBinding: '' }, 'binding'],
  ];
  for (const [change, reason] of cases)
    assert.deepEqual(preflightOpenCodeV2Selection({ ...selected, ...change }, lock),
      { kind: 'hold', reason }, JSON.stringify(change));
});

test('missing or damaged platform delivery cannot be promoted to V2 candidate', () => {
  const withoutDelivery: OpenCodeV2RuntimeLock = lock.opencodeV2 ? { opencodeV2: lock.opencodeV2 } : {};
  assert.deepEqual(preflightOpenCodeV2Selection(selected, withoutDelivery),
    { kind: 'hold', reason: 'delivery' });
  assert.deepEqual(preflightOpenCodeV2Selection(selected, {
    ...lock,
    opencodeV2Delivery: {
      ...lock.opencodeV2Delivery,
      'darwin-arm64': {
        ...lock.opencodeV2Delivery?.['darwin-arm64'],
        archive: { sha256: 'bad' },
      },
    },
  }), { kind: 'hold', reason: 'delivery' });
  // Delivery metadata must explicitly include the selected engine, even when other
  // descriptor fields are well-formed.
  assert.deepEqual(preflightOpenCodeV2Selection(selected, {
    ...lock,
    opencodeV2Delivery: {
      ...lock.opencodeV2Delivery,
      'darwin-arm64': {
        ...lock.opencodeV2Delivery?.['darwin-arm64'],
        engineVersions: ['2.0.32', '2.1.4'],
      },
    },
  }), { kind: 'hold', reason: 'delivery' });
});

test('V2 workspace bindings are lexically canonical on their selected host OS', () => {
  assert.equal(isCanonicalOpenCodeV2Directory('darwin-arm64', selected.directory), true);
  for (const directory of ['/', '/TEST/../foreign', '/TEST//duplicate', 'relative/workspace', '/TEST\u0000foreign']) {
    assert.equal(isCanonicalOpenCodeV2Directory('darwin-arm64', directory), false);
    assert.deepEqual(preflightOpenCodeV2Selection({ ...selected, directory }, lock),
      { kind: 'hold', reason: 'binding' });
  }

  // Windows tuples remain unqualified in the product manifest. These fixtures
  // validate only native path syntax and do NOT promote a Windows driver version.
  assert.equal(isCanonicalOpenCodeV2Directory('win32-x64', 'C:\\TEST\\owned'), true);
  for (const directory of [
    'C:\\', 'C:TEST\\owned', '\\\\server\\share\\owned', 'C:\\TEST\\..\\other',
    'C:/TEST/owned', 'C:\\TEST\\\\owned', 'C:\\TEST\\\0owned',
    'C:\\ ', 'C:\\TEST.\\owned', 'C:\\TEST \\owned', 'C:\\TEST\\owned.', 'C:\\TEST\\owned ',
  ]) assert.equal(isCanonicalOpenCodeV2Directory('win32-x64', directory), false, JSON.stringify(directory));
});
