import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareV2SupportRepair, v2SupportSnapshot, verifyV2SupportRepair } from './v2-support-repair.mjs';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const helper = 'local-cli/opencodeV2RunOwner.js';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'opencode-diagnostics-e2e-repair-'));
  const userData = path.join(root, 'user-data'), base = path.join(root, 'app/resources/runtime');
  const version = '0.0.999', sourceCommit = 'a'.repeat(40), archiveSha256 = 'b'.repeat(64);
  const identity = { schemaVersion: 1, runtimeVersion: version, sourceCommit, bridgeProtocol: 1,
    platform: process.platform, arch: process.arch, requiredBunVersion: '1.3.11', engineVersions: ['2.1.4'] };
  const files = Object.fromEntries(['opencodeV2RunOwner.js', 'opencodeV2Server.js',
    'opencodeV2ExecutionServer.js', 'opencode-v2-graphs.json', 'node_modules/test/index.js']
    .map((name) => [`local-cli/${name}`, Buffer.from(`TEST original ${name}`)]));
  const manifest = { ...identity, files: Object.entries(files).map(([name, bytes]) => ({
    path: name, bytes: bytes.length, sha256: sha(bytes), executable: false,
  })).sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path))) };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const descriptor = { ...identity, archive: {
    file: `agent-teams-opencode-v2-support-${process.platform}-${process.arch}-v${version}.zip`,
    kind: 'zip', sha256: archiveSha256, bytes: 100, entries: manifest.files.length + 1,
    expandedBytes: manifestBytes.length + Object.values(files).reduce((sum, bytes) => sum + bytes.length, 0),
  }, manifest: { file: 'opencode-v2-engine-manifest.json', sha256: sha(manifestBytes),
    bytes: manifestBytes.length, files: manifest.files.length } };
  await mkdir(base, { recursive: true });
  await writeFile(path.join(base, 'opencode-v2-delivery.json'), JSON.stringify(descriptor));
  await writeFile(path.join(base, 'VERSION'), version);
  await writeFile(path.join(base, 'COMMIT_SHA'), sourceCommit);
  await writeFile(path.join(base, 'opencode-delivery.json'), JSON.stringify({ bunVersion: identity.requiredBunVersion }));
  const packageName = `@opencode/cli-${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`;
  const nativeRoot = path.join(userData, 'data/runtimes/opencode/versions/2.1.4', packageName, randomUUID());
  await mkdir(path.join(nativeRoot, 'bin'), { recursive: true });
  let native = Buffer.from('TEST native binary');
  if (process.platform === 'win32') {
    native = Buffer.alloc(128); native.write('MZ'); native.writeUInt32LE(64, 60);
    native.writeUInt32LE(0x4550, 64); native.writeUInt16LE(process.arch === 'arm64' ? 0xaa64 : 0x8664, 68);
  }
  const nativeFile = path.join(nativeRoot, 'bin/opencode.exe');
  await writeFile(nativeFile, native);
  await writeFile(path.join(nativeRoot, 'package.json'), JSON.stringify({ name: packageName, version: '2.1.4' }));
  await writeFile(path.join(userData, 'data/runtimes/opencode/current.json'), JSON.stringify({
    schemaVersion: 1, version: '2.1.4', binaryPath: nativeFile, platformPackage: packageName,
    integrity: 'sha512-dGVzdA==', installedAt: new Date().toISOString(),
  }));
  const directory = path.join(userData, 'data/runtimes/opencode-v2', version,
    `${process.platform}-${process.arch}`, archiveSha256);
  const publish = async () => {
    const instance = randomUUID(), target = path.join(directory, instance);
    for (const [name, bytes] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(target, name)), { recursive: true });
      await writeFile(path.join(target, name), bytes);
    }
    await writeFile(path.join(target, descriptor.manifest.file), manifestBytes);
    await writeFile(path.join(directory, 'installed.json'), JSON.stringify({ schemaVersion: 1,
      runtimeVersion: version, sourceCommit, bridgeProtocol: 1, platform: process.platform, arch: process.arch,
      archiveSha256, manifestSha256: descriptor.manifest.sha256, instance }));
    return target;
  };
  const original = await publish();
  return { root, original, nativeFile, directory, publish, files,
    data: { root, userData, packaged: true, runtimeSetup: 'app-install-v2-repair',
      artifact: { orchestrator: { path: path.join(base, 'claude-multimodel.exe') } } } };
}

test('support-only repair requires a new fully verified instance and preserves exact native selection through restart', async () => {
  const f = await fixture();
  try {
    const native = await readFile(f.nativeFile);
    f.data.supportRepair = await prepareV2SupportRepair(f.data);
    assert.notDeepEqual(await readFile(path.join(f.original, helper)), f.files[helper]);
    assert.deepEqual(await readFile(f.nativeFile), native);
    await assert.rejects(verifyV2SupportRepair(f.data), /checksum mismatch/);
    const repaired = await f.publish();
    const result = await verifyV2SupportRepair(f.data);
    assert.equal(result.instanceRoot, repaired);
    assert.equal(result.filesVerified, Object.keys(f.files).length);
    f.data.supportRepair.after = result;
    assert.deepEqual((await verifyV2SupportRepair(f.data, true)).receipt, result.receipt);
    assert.deepEqual(await readFile(f.nativeFile), native);
    await writeFile(path.join(repaired, 'local-cli/node_modules/test/index.js'), 'tampered dependency');
    await assert.rejects(verifyV2SupportRepair(f.data));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('repair refuses changed native bytes and in-place repair', async () => {
  const f = await fixture();
  try {
    f.data.supportRepair = await prepareV2SupportRepair(f.data);
    await writeFile(path.join(f.original, helper), f.files[helper]);
    await assert.rejects(verifyV2SupportRepair(f.data), /reused corrupted instance/);
    await f.publish();
    const native = await readFile(f.nativeFile);
    native[native.length - 1] ^= 1;
    await writeFile(f.nativeFile, native);
    await assert.rejects(verifyV2SupportRepair(f.data), /native selection or bytes/);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('repair invalidation requires a stopped disposable published profile and a single-link known helper', async () => {
  const f = await fixture();
  try {
    await assert.rejects(prepareV2SupportRepair({ ...f.data, launcher: { pid: 1 } }), /completed owned app cleanup/);
    await assert.rejects(prepareV2SupportRepair({ ...f.data, candidateEvidence: 'candidate.json' }), /Published V2/);
    await assert.rejects(prepareV2SupportRepair({ ...f.data, userData: os.tmpdir() }), /Owned disposable/);
    await link(path.join(f.original, helper), path.join(f.root, 'retained-helper.js'));
    await assert.rejects(prepareV2SupportRepair(f.data), /single-link TEST file/);
    assert.deepEqual(await readFile(path.join(f.original, helper)), f.files[helper]);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('support proof rejects escaping receipt instances and linked profile ancestors', async () => {
  const f = await fixture();
  try {
    const receiptFile = path.join(f.directory, 'installed.json');
    const receipt = JSON.parse(await readFile(receiptFile));
    await writeFile(receiptFile, JSON.stringify({ ...receipt, instance: '..' }));
    await assert.rejects(v2SupportSnapshot(f.data), /Invalid pinned/);
    if (process.platform !== 'win32') {
      const linkedRoot = `${f.root}-alias`;
      await symlink(f.root, linkedRoot);
      try {
        await assert.rejects(v2SupportSnapshot({ ...f.data, root: linkedRoot,
          userData: path.join(linkedRoot, 'user-data') }), /root alias/);
      } finally { await rm(linkedRoot); }
    }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
