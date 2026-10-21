// TEST-only provenance snapshot. The app still uses its unchanged latest installer.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

const REGISTRY = 'https://registry.npmjs.org';
const ROOT = 'opencode-ai';
const PLATFORM = 'opencode-windows-x64';
const NATIVE = 'package/bin/opencode.exe';
const METADATA_LIMIT = 64 * 1024;
const ARCHIVE_LIMIT = 250 * 1024 * 1024;
const BINARY_LIMIT = 350 * 1024 * 1024;
const TAR_LIMIT = BINARY_LIMIT + 1024 * 1024;
const REQUEST_TIMEOUT_MS = 60_000;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function stableVersion(value) {
  assert(
    typeof value === 'string' && /^1\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(value),
    'Expected an explicitly supported stable OpenCode 1.x version'
  );
  return value;
}

function sha512Value(integrity) {
  assert(typeof integrity === 'string', 'Missing npm SHA512 integrity');
  const match = /^sha512-([A-Za-z0-9+/]{86}==)$/.exec(integrity);
  assert(match, 'Invalid npm SHA512 integrity');
  assert.equal(Buffer.from(match[1], 'base64').toString('base64'), match[1]);
  return match[1];
}

function freeze(value) {
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') freeze(child);
  }
  return Object.freeze(value);
}

async function fetchBytes(url, limit, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let reader;
  try {
    const response = await fetchImpl(url, { redirect: 'error', signal: controller.signal });
    assert(response.ok && response.body, `Official npm request failed: HTTP ${response.status}`);
    if (response.url) assert.equal(response.url, url, 'Unexpected npm response URL');
    const length = response.headers.get('content-length');
    if (length !== null) {
      assert(/^\d+$/.test(length), 'Invalid npm content length');
      assert(Number(length) <= limit, 'Official npm response exceeds size limit');
    }
    reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      assert(bytes <= limit, 'Official npm response exceeds size limit');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, bytes);
  } catch (error) {
    if (reader) await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader?.releaseLock();
    clearTimeout(timer);
  }
}

async function metadata(name, requestedVersion, fetchImpl) {
  const url = `${REGISTRY}/${name}/${requestedVersion}`;
  const body = await fetchBytes(url, METADATA_LIMIT, fetchImpl);
  const value = JSON.parse(body.toString('utf8'));
  assert(value && typeof value === 'object' && !Array.isArray(value), 'Invalid npm metadata');
  assert.equal(value.name, name, 'npm metadata package name mismatch');
  stableVersion(value.version);
  if (requestedVersion !== 'latest')
    assert.equal(value.version, requestedVersion, 'npm metadata version mismatch');
  const tarballUrl = `${REGISTRY}/${name}/-/${name}-${value.version}.tgz`;
  assert.equal(value.dist?.tarball, tarballUrl, 'Unexpected official npm tarball URL');
  sha512Value(value.dist?.integrity);
  return {
    value,
    receipt: {
      url,
      sha256: sha256(body),
      bytes: body.length,
      name,
      version: value.version,
      dist: { tarball: tarballUrl, integrity: value.dist.integrity },
    },
  };
}

function tarString(block, offset, length) {
  const field = block.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return field.subarray(0, end < 0 ? field.length : end).toString('utf8');
}

function tarOctal(block, offset, length) {
  const text = tarString(block, offset, length).trim();
  assert(/^[0-7]+$/.test(text), 'Invalid tar numeric field');
  const value = Number.parseInt(text, 8);
  assert(Number.isSafeInteger(value), 'Unsafe tar numeric field');
  return value;
}

// Independent from the production installer parser; no member is written or executed.
function archiveIdentity(archive, version) {
  const tar = gunzipSync(archive, { maxOutputLength: TAR_LIMIT });
  const names = new Set();
  const entries = [];
  let native;
  let packageJson;
  let offset = 0;
  for (;;) {
    assert(offset + 512 <= tar.length, 'Truncated tar header');
    const block = tar.subarray(offset, offset + 512);
    if (block.every((byte) => byte === 0)) {
      assert(offset + 1024 <= tar.length, 'Missing tar end blocks');
      assert(
        tar.subarray(offset).every((byte) => byte === 0),
        'Unexpected trailing tar data'
      );
      break;
    }
    assert(entries.length < 128, 'Tar entry count exceeds limit');
    const checksum = block.reduce(
      (sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte),
      0
    );
    assert.equal(tarOctal(block, 148, 8), checksum, 'Tar header checksum mismatch');
    const leaf = tarString(block, 0, 100);
    const prefix = tarString(block, 345, 155);
    const name = prefix ? `${prefix}/${leaf}` : leaf;
    const type = tarString(block, 156, 1);
    const canonical = type === '5' && name.endsWith('/') ? name.slice(0, -1) : name;
    assert(
      /^[\x20-\x7e]+$/.test(canonical) &&
        !canonical.includes('\\') &&
        !canonical.includes(':') &&
        canonical.split('/').every((part) => part && part !== '.' && part !== '..') &&
        (canonical === 'package' || canonical.startsWith('package/')),
      'Unsafe tar member path'
    );
    assert(!names.has(canonical), 'Duplicate tar member path');
    names.add(canonical);
    assert(type === '' || type === '0' || type === '5', 'Unsupported tar member type');
    const size = tarOctal(block, 124, 12);
    const start = offset + 512;
    const end = start + size;
    const next = start + Math.ceil(size / 512) * 512;
    assert(end <= tar.length && next <= tar.length, 'Truncated tar member');
    if (type === '5') assert.equal(size, 0, 'Tar directory has contents');
    const bytes = tar.subarray(start, end);
    entries.push({ path: canonical, bytes: size, sha256: sha256(bytes) });
    if (canonical === NATIVE) {
      assert(type !== '5' && size >= 64 && size <= BINARY_LIMIT, 'Invalid native binary member');
      assert.equal(bytes.toString('ascii', 0, 2), 'MZ', 'Native binary is not PE');
      const pe = bytes.readUInt32LE(60);
      assert(pe <= size - 6, 'Invalid PE header offset');
      assert.equal(bytes.readUInt32LE(pe), 0x00004550, 'Invalid PE signature');
      assert.equal(bytes.readUInt16LE(pe + 4), 0x8664, 'Native binary is not Windows x64');
      native = entries.at(-1);
    }
    if (canonical === 'package/package.json') {
      assert(type !== '5' && size > 0 && size <= METADATA_LIMIT, 'Invalid package.json member');
      const parsed = JSON.parse(bytes.toString('utf8'));
      assert.equal(parsed.name, PLATFORM, 'Archive package name mismatch');
      assert.equal(parsed.version, version, 'Archive package version mismatch');
      packageJson = { ...entries.at(-1), name: parsed.name, version: parsed.version };
    }
    offset = next;
  }
  assert(native && packageJson, 'Native package members missing');
  return { native, packageJson, entries };
}

/** Freeze official package authority before launching the unmodified real installer. */
export async function resolveNativeInstallExpectation({ fetchImpl = globalThis.fetch } = {}) {
  const root = await metadata(ROOT, 'latest', fetchImpl);
  const dependency = root.value.optionalDependencies?.[PLATFORM];
  assert(typeof dependency === 'string', 'Official Windows x64 package dependency missing');
  const version = stableVersion(dependency.replace(/^[~^]/, ''));
  root.receipt.optionalDependencies = { [PLATFORM]: dependency };
  const platform = await metadata(PLATFORM, version, fetchImpl);
  const archive = await fetchBytes(platform.receipt.dist.tarball, ARCHIVE_LIMIT, fetchImpl);
  assert.equal(
    createHash('sha512').update(archive).digest('base64'),
    sha512Value(platform.receipt.dist.integrity),
    'Official npm archive SHA512 integrity mismatch'
  );
  const identity = archiveIdentity(archive, version);
  return freeze({
    schemaVersion: 1,
    testOnly: true,
    resolvedAt: new Date().toISOString(),
    version,
    platformPackage: PLATFORM,
    integrity: platform.receipt.dist.integrity,
    tarballUrl: platform.receipt.dist.tarball,
    tarballSha256: sha256(archive),
    tarballBytes: archive.length,
    nativeSha256: identity.native.sha256,
    nativeBytes: identity.native.bytes,
    rootMetadata: root.receipt,
    platformMetadata: platform.receipt,
    packageJson: identity.packageJson,
    archiveEntries: identity.entries,
  });
}

/** Compare actual app publication to the prior snapshot; never refresh expectations. */
export function verifyNativeInstallExpectation(expectation, { status, manifest, binarySha256 }) {
  assert.equal(expectation.schemaVersion, 1);
  assert.equal(expectation.testOnly, true);
  stableVersion(expectation.version);
  assert.equal(expectation.platformPackage, PLATFORM);
  sha512Value(expectation.integrity);
  assert(/^[a-f0-9]{64}$/.test(expectation.nativeSha256), 'Invalid expected native SHA256');
  assert.equal(status.installed, true, 'App-managed native install did not complete');
  assert.equal(status.source, 'app-managed', 'Native install source mismatch');
  assert.equal(status.state, 'ready', 'Native install is not ready');
  assert.equal(status.version, expectation.version, 'Native install version drift');
  assert.equal(manifest.schemaVersion, 1, 'Managed manifest schema mismatch');
  assert.equal(manifest.version, expectation.version, 'Managed manifest version drift');
  assert.equal(manifest.platformPackage, PLATFORM, 'Managed platform package mismatch');
  assert.equal(manifest.integrity, expectation.integrity, 'Managed package integrity drift');
  assert(typeof status.binaryPath === 'string' && status.binaryPath.length > 0);
  assert.equal(manifest.binaryPath, status.binaryPath, 'Managed binary path mismatch');
  assert.equal(binarySha256, expectation.nativeSha256, 'Native installed binary SHA256 drift');
  return freeze({
    version: expectation.version,
    platformPackage: PLATFORM,
    integrity: expectation.integrity,
    binaryPath: status.binaryPath,
    nativeSha256: binarySha256,
  });
}
