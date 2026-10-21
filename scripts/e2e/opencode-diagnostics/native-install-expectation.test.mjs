import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { gzipSync } from 'node:zlib';

import {
  resolveNativeInstallExpectation,
  verifyNativeInstallExpectation,
} from './native-install-expectation.mjs';

const REGISTRY = 'https://registry.npmjs.org';
const PLATFORM = 'opencode-windows-x64';
const VERSION = '1.19.3';
const sri = (bytes) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const native = Buffer.alloc(256, 0);
native.write('MZ');
native.writeUInt32LE(128, 60);
native.writeUInt32LE(0x00004550, 128);
native.writeUInt16LE(0x8664, 132);

function tar(entries) {
  return Buffer.concat([
    ...entries.flatMap(({ name, bytes, type = '0' }) => {
      const header = Buffer.alloc(512);
      header.write(name);
      header.write('0000755\0', 100);
      header.write(`${bytes.length.toString(8).padStart(11, '0')}\0`, 124);
      header.fill(32, 148, 156);
      header.write(type, 156);
      header.write('ustar\0', 257);
      const checksum = header.reduce((sum, byte) => sum + byte, 0);
      header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148);
      return [header, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512)];
    }),
    Buffer.alloc(1024),
  ]);
}

const normalEntries = () => [
  {
    name: 'package/package.json',
    bytes: Buffer.from(JSON.stringify({ name: PLATFORM, version: VERSION })),
  },
  { name: 'package/bin/opencode.exe', bytes: native },
];

function fixture({ entries = normalEntries(), editTar, rootPatch, platformPatch, tamper } = {}) {
  const tarBytes = tar(entries);
  if (editTar) editTar(tarBytes);
  const archive = gzipSync(tarBytes);
  const root = {
    name: 'opencode-ai',
    version: VERSION,
    optionalDependencies: { [PLATFORM]: VERSION },
    dist: {
      tarball: `${REGISTRY}/opencode-ai/-/opencode-ai-${VERSION}.tgz`,
      integrity: sri(Buffer.from('root package, not downloaded')),
    },
  };
  const platform = {
    name: PLATFORM,
    version: VERSION,
    dist: {
      tarball: `${REGISTRY}/${PLATFORM}/-/${PLATFORM}-${VERSION}.tgz`,
      integrity: sri(archive),
    },
  };
  rootPatch?.(root);
  platformPatch?.(platform);
  const responses = new Map([
    [`${REGISTRY}/opencode-ai/latest`, Buffer.from(JSON.stringify(root))],
    [`${REGISTRY}/${PLATFORM}/${VERSION}`, Buffer.from(JSON.stringify(platform))],
    [platform.dist.tarball, tamper ? Buffer.from('tampered archive') : archive],
  ]);
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push(url);
    assert.equal(options.redirect, 'error');
    assert(options.signal instanceof AbortSignal);
    assert(responses.has(url), `Unexpected test request: ${url}`);
    return new Response(responses.get(url));
  };
  return { fetchImpl, calls, root, platform, archive };
}

test('freezes official latest1.19.3 package and independent native identity before installation', async () => {
  const data = fixture();
  const result = await resolveNativeInstallExpectation(data);
  assert.equal(result.version, VERSION);
  assert.equal(result.platformPackage, PLATFORM);
  assert.equal(result.integrity, data.platform.dist.integrity);
  assert.equal(result.tarballSha256, sha(data.archive));
  assert.equal(result.nativeSha256, sha(native));
  assert.equal(result.nativeBytes, native.length);
  assert.equal(result.rootMetadata.sha256, sha(Buffer.from(JSON.stringify(data.root))));
  assert.equal(result.platformMetadata.sha256, sha(Buffer.from(JSON.stringify(data.platform))));
  assert.deepEqual(result.rootMetadata.optionalDependencies, { [PLATFORM]: VERSION });
  assert.equal(result.packageJson.version, VERSION);
  assert.equal(result.archiveEntries.length, 2);
  assert.equal(data.calls.length, 3);
  assert(Object.isFrozen(result));
  assert(Object.isFrozen(result.rootMetadata.optionalDependencies));
  assert(Object.isFrozen(result.archiveEntries[0]));
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});

test('normalizes only the single prefix the real installer removes', async () => {
  const result = await resolveNativeInstallExpectation(
    fixture({ rootPatch: (root) => (root.optionalDependencies[PLATFORM] = `^${VERSION}`) })
  );
  assert.equal(result.version, VERSION);
  assert.equal(result.rootMetadata.optionalDependencies[PLATFORM], `^${VERSION}`);
});

for (const [name, options, pattern] of [
  ['wrong root name', { rootPatch: (root) => (root.name = 'foreign') }, /package name mismatch/],
  ['unsupported major', { rootPatch: (root) => (root.version = '2.0.0') }, /stable OpenCode 1.x/],
  ['prerelease', { rootPatch: (root) => (root.version = '1.19.3-beta') }, /stable OpenCode 1.x/],
  [
    'missing direct package',
    { rootPatch: (root) => (root.optionalDependencies = {}) },
    /dependency missing/,
  ],
  [
    'dependency range',
    { rootPatch: (root) => (root.optionalDependencies[PLATFORM] = '>=1.19.3') },
    /stable OpenCode 1.x/,
  ],
  [
    'wrong platform name',
    { platformPatch: (value) => (value.name = 'foreign') },
    /package name mismatch/,
  ],
  [
    'wrong platform version',
    { platformPatch: (value) => (value.version = '1.19.0') },
    /version mismatch/,
  ],
  [
    'foreign tarball',
    { platformPatch: (value) => (value.dist.tarball = 'https://foreign.test/native.tgz') },
    /tarball URL/,
  ],
  [
    'invalid SRI',
    { platformPatch: (value) => (value.dist.integrity = 'sha1-untrusted') },
    /SHA512 integrity/,
  ],
  ['tarball tampering', { tamper: true }, /archive SHA512 integrity mismatch/],
  [
    'traversal',
    { entries: [...normalEntries(), { name: 'package/../escape', bytes: Buffer.from('x') }] },
    /Unsafe tar member path/,
  ],
  [
    'symlink',
    { entries: [...normalEntries(), { name: 'package/link', bytes: Buffer.alloc(0), type: '2' }] },
    /Unsupported tar member type/,
  ],
  [
    'duplicate native',
    { entries: [...normalEntries(), normalEntries()[1]] },
    /Duplicate tar member path/,
  ],
  ['missing native', { entries: normalEntries().slice(0, 1) }, /members missing/],
  [
    'wrong inner version',
    {
      entries: [
        {
          name: 'package/package.json',
          bytes: Buffer.from(JSON.stringify({ name: PLATFORM, version: '1.19.0' })),
        },
        normalEntries()[1],
      ],
    },
    /Archive package version mismatch/,
  ],
  ['header corruption', { editTar: (bytes) => (bytes[20] ^= 1) }, /checksum mismatch/],
  [
    'nonzero trailing data',
    { editTar: (bytes) => (bytes[bytes.length - 1] = 1) },
    /trailing tar data/,
  ],
]) {
  test(`rejects ${name} before any installed identity can become an expectation`, async () => {
    await assert.rejects(resolveNativeInstallExpectation(fixture(options)), pattern);
  });
}

test('refuses HTTP and size failures without retrying', async () => {
  let calls = 0;
  await assert.rejects(
    resolveNativeInstallExpectation({
      fetchImpl: async () => {
        calls++;
        return new Response('unavailable', { status: 503 });
      },
    }),
    /HTTP 503/
  );
  assert.equal(calls, 1);
  for (const response of [
    new Response('{}', { headers: { 'content-length': '65537' } }),
    new Response(Buffer.alloc(65537, 32)),
  ]) {
    await assert.rejects(
      resolveNativeInstallExpectation({ fetchImpl: async () => response }),
      /exceeds size limit/
    );
  }
});

test('requires exact app-managed publication and rejects observed version, hash, and manifest drift', async () => {
  const expectation = await resolveNativeInstallExpectation(fixture());
  const status = {
    installed: true,
    source: 'app-managed',
    state: 'ready',
    version: VERSION,
    binaryPath: 'C:\\TEST\\opencode.exe',
  };
  const manifest = {
    schemaVersion: 1,
    version: VERSION,
    platformPackage: PLATFORM,
    integrity: expectation.integrity,
    binaryPath: status.binaryPath,
  };
  const observation = { status, manifest, binarySha256: expectation.nativeSha256 };
  assert.equal(verifyNativeInstallExpectation(expectation, observation).version, VERSION);
  for (const [field, value, pattern] of [
    ['installed', false, /did not complete/],
    ['source', 'path', /source mismatch/],
    ['state', 'failed', /not ready/],
    ['version', '1.19.0', /version drift/],
  ]) {
    assert.throws(
      () =>
        verifyNativeInstallExpectation(expectation, {
          ...observation,
          status: { ...status, [field]: value },
        }),
      pattern
    );
  }
  for (const [field, value, pattern] of [
    ['schemaVersion', 2, /schema mismatch/],
    ['version', '1.19.0', /version drift/],
    ['platformPackage', 'opencode-windows-x64-baseline', /package mismatch/],
    ['integrity', sri(Buffer.from('other package')), /integrity drift/],
    ['binaryPath', 'C:\\TEST\\foreign.exe', /path mismatch/],
  ]) {
    assert.throws(
      () =>
        verifyNativeInstallExpectation(expectation, {
          ...observation,
          manifest: { ...manifest, [field]: value },
        }),
      pattern
    );
  }
  assert.throws(
    () =>
      verifyNativeInstallExpectation(expectation, { ...observation, binarySha256: '0'.repeat(64) }),
    /SHA256 drift/
  );
  assert.equal(expectation.nativeSha256, sha(native));
  assert.equal(expectation.version, VERSION);
});
