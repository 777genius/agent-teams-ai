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

test('V2 native session binding matches pinned private driver alphabet, not merely URL-safe IDs', () => {
  for (const nativeSessionId of ['ses_TESTowned1', 'ses_a1', 'ses_' + 'a'.repeat(256)])
    assert.deepEqual(preflightOpenCodeV2Selection({ ...selected, nativeSessionId }, lock).kind,
      'candidate', nativeSessionId);
  for (const nativeSessionId of ['ses_', 'ses_a-b', 'ses_a_b', 'ses_bad/other', 'ses_bad?x=1', 'ses_bad#section', 'ses_bad%2fother',
    'ses_bad\\\\other', 'ses_' + 'a'.repeat(257)])
    assert.deepEqual(preflightOpenCodeV2Selection({ ...selected, nativeSessionId }, lock),
      { kind: 'hold', reason: 'binding' }, nativeSessionId);
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
    [{ platform: 'unknown' }, 'platform'],
    [{ nativeReportedVersion: '2.0.32' }, 'native-version'],
    [{ observedExecutableSha256: 'b'.repeat(64) }, 'binary-digest'],
    [{ observedExecutableSha256: 'invalid' }, 'binary-digest'],
    [{ observedExecutableSha256: 'B'.repeat(64) }, 'binary-digest'],
    [{ executableSha256: '' }, 'binary-digest'],
    [{ endpoint: 'http://localhost:14321' }, 'binding'],
    [{ endpoint: 'http://127.0.0.1:65536' }, 'binding'],
    [{ endpoint: 'http://127.0.0.1:99999' }, 'binding'],
    [{ endpoint: 'http://127.0.0.1:00080' }, 'binding'],
    [{ endpoint: 'http://127.0.0.1:14321/foreign' }, 'binding'],
    [{ nativeSessionId: 'V1_session' }, 'binding'],
    [{ sessionBinding: '' }, 'binding'],
    [{ sessionBinding: ' \t ' }, 'binding'],
    [{ accountBinding: '' }, 'binding'],
    [{ accountBinding: '   ' }, 'binding'],
  ];
  for (const [change, reason] of cases)
    assert.deepEqual(preflightOpenCodeV2Selection({ ...selected, ...change }, lock),
      { kind: 'hold', reason }, JSON.stringify(change));
});

test('V2 loopback endpoint validation accepts the top IANA TCP port without a verbose regex', () => {
  for (const port of [1, 14321, 65535])
    assert.deepEqual(preflightOpenCodeV2Selection({
      ...selected, endpoint: `http://127.0.0.1:${port}`,
    }, lock).kind, 'candidate', String(port));
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


test('V2 Windows workspace capture refuses device aliases and stream syntax', () => {
  // The lexical guard is not a filesystem or native process-custody proof.
  for (const directory of [
    'C:\\TEST\\CON', 'C:\\TEST\\con.log', 'C:\\NUL\\owned',
    'C:\\TEST\\CONIN$', 'C:\\TEST\\CONOUT$', 'C:\\TEST\\CONIN$.txt', 'C:\\TEST\\conout$.log',
    'C:\\TEST\\prn.txt', 'C:\\TEST\\AUX', 'C:\\TEST\\com1',
    'C:\\TEST\\LPT9.txt', 'C:\\TEST\\COM¹', 'C:\\TEST\\lpt².log',
    'C:\\TEST\\item:stream', 'C:\\TEST\\file::$DATA',
    'C:\\TEST\\bad<name', 'C:\\TEST\\bad>name',
    'C:\\TEST\\bad"quote', 'C:\\TEST\\bad|pipe',
    'C:\\TEST\\bad?question', 'C:\\TEST\\bad*asterisk',
    'C:\\TEST\\' + String.fromCharCode(1) + 'control',
  ]) {
    assert.equal(isCanonicalOpenCodeV2Directory('win32-x64', directory),
      false, JSON.stringify(directory));
  }
  for (const directory of [
    'C:\\TEST\\owned', 'C:\\TEST\\com10', 'C:\\TEST\\conifer',
    'C:\\TEST\\.config',
  ]) {
    assert.equal(isCanonicalOpenCodeV2Directory('win32-x64', directory),
      true, JSON.stringify(directory));
  }
});

test('V2 static preflight refuses malformed JSON version lists and non-string binding captures', () => {
  // An unvalidated manifest can contain a string instead of a string array.
  // String.includes('2.0.0') would incorrectly admit this forged substring.
  for (const versions of ['unqualified-2.0.0', 200, null, { release: '2.0.0' }, ['2.0.0', 200]]) {
    const damaged = {
      ...lock,
      opencodeV2: {
        ...lock.opencodeV2,
        qualified: { ...lock.opencodeV2?.qualified, 'darwin-arm64': versions },
      },
    } as unknown as OpenCodeV2RuntimeLock;
    assert.deepEqual(preflightOpenCodeV2Selection(selected, damaged),
      { kind: 'hold', reason: 'runtime-version' }, JSON.stringify(versions));
  }
  for (const versions of ['prefix-2.0.0-suffix', 200, null, { release: '2.0.0' }, ['2.0.0', false]]) {
    const damaged = {
      ...lock,
      opencodeV2Delivery: {
        ...lock.opencodeV2Delivery,
        'darwin-arm64': {
          ...lock.opencodeV2Delivery?.['darwin-arm64'],
          engineVersions: versions,
        },
      },
    } as unknown as OpenCodeV2RuntimeLock;
    assert.deepEqual(preflightOpenCodeV2Selection(selected, damaged),
      { kind: 'hold', reason: 'delivery' }, JSON.stringify(versions));
  }
  for (const [key, value] of [
    ['sessionBinding', 123],
    ['sessionBinding', { id: 'TEST-owner' }],
    ['accountBinding', 456],
    ['accountBinding', ['TEST-account']],
  ] as const) {
    const damaged = { ...selected, [key]: value } as unknown as OpenCodeV2Selection;
    assert.deepEqual(preflightOpenCodeV2Selection(damaged, lock),
      { kind: 'hold', reason: 'binding' }, key);
  }
});

test('V2 delivery release and OS identity cannot be borrowed from another tuple', () => {
  const original = lock.opencodeV2Delivery?.['darwin-arm64'];
  assert.ok(original);
  for (const changed of [
    { platform: 'linux' },
    { platform: 'win32' },
    { arch: 'x64' },
    { runtimeVersion: '0.0.999' },
    { runtimeVersion: null },
  ]) {
    const corrupted = {
      ...lock,
      opencodeV2Delivery: {
        ...lock.opencodeV2Delivery,
        'darwin-arm64': { ...original, ...changed },
      },
    } as unknown as OpenCodeV2RuntimeLock;
    assert.deepEqual(preflightOpenCodeV2Selection(selected, corrupted),
      { kind: 'hold', reason: 'delivery' }, JSON.stringify(changed));
  }
  for (const version of [undefined, '', '0.0.999']) {
    assert.deepEqual(preflightOpenCodeV2Selection(selected, { ...lock, version }),
      { kind: 'hold', reason: 'delivery' }, String(version));
  }
});
