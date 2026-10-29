// Opt-in published-delivery proof, restricted to the existing disposable profile.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, open, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  parseOpenCodeV2DeliveryManifest,
  parseOpenCodeV2InstalledReceipt,
  readOpenCodeV2DeliveryMap,
} from '../../../src/features/opencode-runtime-installer/core/domain/v2Delivery.ts';

const HELPER = 'local-cli/opencodeV2RunOwner.js';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const samePath = (left, right) => process.platform === 'win32'
  ? left.toLowerCase() === right.toLowerCase() : left === right;

async function physical(root, relative, directory = false) {
  assert(relative && !relative.includes('\\') && !path.isAbsolute(relative) &&
    relative.split('/').every((part) => part && part !== '.' && part !== '..' && !part.includes(':')));
  const base = path.resolve(root);
  assert(samePath(await realpath(base), base), 'Support proof root alias refused');
  assert((await lstat(base)).isDirectory() && !(await lstat(base)).isSymbolicLink());
  let file = base;
  const parts = relative.split('/');
  for (const [index, part] of parts.entries()) {
    file = path.join(file, part);
    const stat = await lstat(file);
    assert(!stat.isSymbolicLink() &&
      (index < parts.length - 1 || directory ? stat.isDirectory() : stat.isFile()),
    'Support proof link or non-regular path refused');
    assert(samePath(await realpath(file), file), 'Support proof path alias refused');
  }
  return file;
}

async function digest(file) {
  const before = await lstat(file);
  assert(before.isFile() && !before.isSymbolicLink() && before.size <= 256 * 1024 ** 2);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  const after = await lstat(file);
  assert(before.dev === after.dev && before.ino === after.ino && before.size === after.size &&
    before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs, 'Support proof bytes changed');
  return hash.digest('hex');
}

async function bounded(file, maximum) {
  const stat = await lstat(file);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= maximum);
  return readFile(file);
}

function ownedProfile(data) {
  assert(data.packaged === true && data.runtimeSetup === 'app-install-v2-repair' &&
    !data.candidateEvidence && !data.artifact?.candidate, 'Published V2 repair mode required');
  assert(path.isAbsolute(data.root) && /^opencode-diagnostics-e2e-/.test(path.basename(data.root)) &&
    data.userData === path.join(data.root, 'user-data'), 'Owned disposable profile required');
}

/** Observe actual app-installed bytes; no URL, cache import or fixture publisher. */
export async function v2SupportSnapshot(data, verifyFiles = 'all') {
  ownedProfile(data);
  assert(['none', 'selected', 'all'].includes(verifyFiles));
  await physical(data.root, 'user-data', true);
  const base = path.dirname(data.artifact.orchestrator.path);
  const descriptorFile = await physical(base, 'opencode-v2-delivery.json');
  const descriptor = JSON.parse(await bounded(descriptorFile, 64 * 1024));
  const platformKey = `${process.platform}-${process.arch}`;
  assert.equal(`${descriptor.platform}-${descriptor.arch}`, platformKey, 'Native support target mismatch');
  readOpenCodeV2DeliveryMap({ version: descriptor.runtimeVersion, assets: { [platformKey]: {} },
    opencodeV2: { qualified: { [platformKey]: descriptor.engineVersions } },
    opencodeV2Delivery: { [platformKey]: descriptor } });
  assert.equal(String(await bounded(await physical(base, 'VERSION'), 128)).trim(), descriptor.runtimeVersion);
  assert.equal(String(await bounded(await physical(base, 'COMMIT_SHA'), 128)).trim(), descriptor.sourceCommit);
  const identity = JSON.parse(await bounded(await physical(base, 'opencode-delivery.json'), 4096));
  assert.equal(identity.bunVersion, descriptor.requiredBunVersion);
  const currentFile = await physical(data.userData, 'data/runtimes/opencode/current.json');
  const currentBytes = await bounded(currentFile, 64 * 1024);
  const current = JSON.parse(currentBytes);
  assert(current.schemaVersion === 1 && /^2\.\d+\.\d+$/.test(current.version) &&
    current.platformPackage === `@opencode/cli-${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}` &&
    /^sha512-[A-Za-z0-9+/]+={0,2}$/.test(current.integrity), 'Verified managed native V2 identity required');
  assert(descriptor.engineVersions.includes(current.version),
    'Native V2 package is absent from the bundled qualification');
  const nativeRelative = path.relative(data.userData, current.binaryPath).split(path.sep).join('/');
  assert(nativeRelative.startsWith('data/runtimes/opencode/versions/'));
  const nativeFile = await physical(data.userData, nativeRelative);
  const nativePackage = JSON.parse(await bounded(await physical(path.dirname(path.dirname(nativeFile)), 'package.json'), 64 * 1024));
  assert(nativePackage.name === current.platformPackage && nativePackage.version === current.version);
  if (process.platform === 'win32') {
    const handle = await open(nativeFile, 'r');
    try {
      const header = Buffer.alloc(64);
      assert.equal((await handle.read(header, 0, 64, 0)).bytesRead, 64);
      assert.equal(header.readUInt16LE(0), 0x5a4d);
      const offset = header.readUInt32LE(0x3c), pe = Buffer.alloc(6);
      assert(offset >= 64 && offset + 6 <= (await handle.stat()).size);
      assert.equal((await handle.read(pe, 0, 6, offset)).bytesRead, 6);
      assert.equal(pe.readUInt32LE(0), 0x4550);
      assert.equal(pe.readUInt16LE(4), process.arch === 'arm64' ? 0xaa64 : 0x8664);
    } finally { await handle.close(); }
  }
  const relative = `data/runtimes/opencode-v2/${descriptor.runtimeVersion}/${platformKey}/${descriptor.archive.sha256}`;
  const receipt = parseOpenCodeV2InstalledReceipt(JSON.parse(await bounded(
    await physical(data.userData, `${relative}/installed.json`), 4096)), descriptor);
  const instanceRoot = await physical(data.userData, `${relative}/${receipt.instance}`, true);
  const manifestBytes = await bounded(await physical(instanceRoot, descriptor.manifest.file), descriptor.manifest.bytes);
  assert.equal(manifestBytes.length, descriptor.manifest.bytes);
  assert.equal(sha(manifestBytes), descriptor.manifest.sha256);
  const manifest = parseOpenCodeV2DeliveryManifest(JSON.parse(manifestBytes), descriptor);
  const rows = verifyFiles === 'all' ? manifest.files : verifyFiles === 'selected'
    ? manifest.files.filter((file) => file.path === HELPER) : [];
  assert(manifest.files.some((file) => file.path === HELPER), 'Known support helper absent');
  const deadline = Date.now() + 180_000;
  let next = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (next < rows.length) {
      assert(Date.now() < deadline, 'Support inventory verification budget exhausted');
      const row = rows[next++], file = await physical(instanceRoot, row.path);
      assert.equal((await lstat(file)).size, row.bytes);
      assert.equal(await digest(file), row.sha256, 'Installed support checksum mismatch');
    }
  }));
  return { descriptor, receipt, instanceRoot, filesVerified: rows.length,
    native: { binaryPath: nativeFile, version: current.version, platformPackage: current.platformPackage,
      integrity: current.integrity, currentSha256: sha(currentBytes), sha256: await digest(nativeFile) } };
}

/** Warm starts must reuse the exact successfully installed cold selection. */
export function assertV2SupportWarmReuse(baseline, observed) {
  assert(baseline?.native && baseline?.descriptor && baseline?.receipt &&
    observed?.native && observed?.descriptor && observed?.receipt,
  'Verified cold support baseline required');
  assert.deepEqual(observed.native, baseline.native, 'Warm start changed native selection or bytes');
  assert.deepEqual(observed.descriptor, baseline.descriptor, 'Warm start changed pinned delivery');
  assert.deepEqual(observed.receipt, baseline.receipt, 'Warm start changed support selection');
}

/** Only after the runner has proved warm app cleanup; mutate one single-link TEST helper. */
export async function prepareV2SupportRepair(data) {
  ownedProfile(data);
  assert(!data.launcher, 'Repair invalidation requires completed owned app cleanup');
  const before = await v2SupportSnapshot(data);
  assertV2SupportWarmReuse(data.v2SupportCold, before);
  const file = await physical(before.instanceRoot, HELPER);
  const handle = await open(file, 'r+');
  try {
    const opened = await handle.stat(), selected = await lstat(file);
    assert(opened.nlink === 1 && opened.size > 0 && opened.dev === selected.dev && opened.ino === selected.ino,
      'Repair helper must be the original single-link TEST file');
    const byte = Buffer.alloc(1);
    assert.equal((await handle.read(byte, 0, 1, 0)).bytesRead, 1);
    byte[0] ^= 1;
    assert.equal((await handle.write(byte, 0, 1, 0)).bytesWritten, 1);
    await handle.sync();
  } finally { await handle.close(); }
  return { before, invalidated: { relative: HELPER, sha256: await digest(file) } };
}

export async function verifyV2SupportRepair(data, restarted = false) {
  ownedProfile(data);
  const repair = data.supportRepair;
  assert(repair?.invalidated?.relative === HELPER, 'Original TEST support invalidation required');
  const after = await v2SupportSnapshot(data, 'all');
  assert.deepEqual(after.native, repair.before.native, 'Support repair changed native selection or bytes');
  assert.deepEqual(after.descriptor, repair.before.descriptor, 'Support repair changed pinned delivery');
  assert.notEqual(after.receipt.instance, repair.before.receipt.instance, 'Support repair reused corrupted instance');
  const priorRoot = await physical(data.userData,
    `data/runtimes/opencode-v2/${after.descriptor.runtimeVersion}/${after.descriptor.platform}-${after.descriptor.arch}/${after.descriptor.archive.sha256}/${repair.before.receipt.instance}`, true);
  assert.equal(await digest(await physical(priorRoot, HELPER)), repair.invalidated.sha256,
    'Support repair edited the old instance in place');
  if (restarted) assert.deepEqual(after.receipt, repair.after?.receipt, 'Restart changed repaired support selection');
  return after;
}
