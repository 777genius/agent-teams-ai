import assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { digestOpenExecutable } from '../dist/process/digestOpenExecutable.js';
import { createQualifiedLinuxProcessApi } from '../dist/process/LinuxRegisteredProcess.js';

const chunkBytes = 512 * 1024;
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const originalRead = fs.readSync;
const originalStat = fs.fstatSync;

function imageFixture(t: TestContext, size = chunkBytes + 37) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'TEST-executable-digest-')));
  const image = join(root, 'TEST-image-never-executed');
  const bytes = Buffer.alloc(size);
  for (let i = 0; i < bytes.length; ++i) bytes[i] = (i * 13 + 7) % 251;
  fs.writeFileSync(image, bytes);
  const file = fs.openSync(image, 'r');
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    fs.closeSync(file);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, image, bytes, file };
}

function interceptRead(t: TestContext, callback: (
  file: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number,
  position: number | null | undefined
) => number) {
  t.mock.method(fs, 'readSync', callback as typeof fs.readSync);
  syncBuiltinESMExports();
}

for (const size of [0, 1, chunkBytes - 1, chunkBytes, chunkBytes + 1, 2 * chunkBytes + 37]) {
  test(`fresh executable digest matches all ${size} bytes and leaves the borrowed fd open`, t => {
    const f = imageFixture(t, size);
    assert.equal(digestOpenExecutable(f.file), sha256(f.bytes));
    assert.equal(originalStat(f.file).size, size);
  });
}

test('fresh executable digest retains at most one 512 KiB read buffer for a larger image', t => {
  const f = imageFixture(t, 3 * chunkBytes + 37);
  let largestBuffer = 0;
  interceptRead(t, (file, buffer, offset, length, position) => {
    if (file === f.file) largestBuffer = Math.max(largestBuffer, buffer.byteLength);
    return originalRead(file, buffer, offset, length, position ?? null);
  });
  assert.equal(digestOpenExecutable(f.file), sha256(f.bytes));
  assert.ok(largestBuffer > 0 && largestBuffer <= chunkBytes,
    `executable read retained a ${largestBuffer}-byte buffer`);
});

test('positive short reads continue until all captured bytes have been hashed', t => {
  const f = imageFixture(t, 127);
  let reads = 0;
  interceptRead(t, (file, buffer, offset, length, position) => {
    if (file === f.file) ++reads;
    return originalRead(file, buffer, offset, Math.min(length, 17), position ?? null);
  });
  assert.equal(digestOpenExecutable(f.file), sha256(f.bytes));
  assert.ok(reads > 1);
});

test('short EOF hashes the available bytes and keeps the caller-owned fd open', t => {
  const f = imageFixture(t);
  let shortened = false;
  interceptRead(t, (file, buffer, offset, length, position) => {
    if (file === f.file && !shortened) {
      shortened = true;
      fs.truncateSync(f.image, 257);
    }
    return originalRead(file, buffer, offset, length, position ?? null);
  });
  assert.equal(digestOpenExecutable(f.file), sha256(f.bytes.subarray(0, 257)));
  assert.equal(originalStat(f.file).size, 257);
});

test('positive captured size does not consume bytes appended during the read', t => {
  const f = imageFixture(t);
  const appended = Buffer.from('TEST appended bytes');
  let grew = false;
  interceptRead(t, (file, buffer, offset, length, position) => {
    if (file === f.file && !grew) {
      grew = true;
      fs.appendFileSync(f.image, appended);
    }
    return originalRead(file, buffer, offset, length, position ?? null);
  });
  assert.equal(digestOpenExecutable(f.file), sha256(f.bytes));
  const remaining = Buffer.alloc(appended.length);
  assert.equal(originalRead(f.file, remaining, 0, remaining.length, null), appended.length);
  assert.deepEqual(remaining, appended);
});

test('zero captured size reads fresh available bytes through EOF', t => {
  const f = imageFixture(t, 0);
  const appended = Buffer.alloc(8193, 23);
  let grew = false;
  interceptRead(t, (file, buffer, offset, length, position) => {
    if (file === f.file && !grew) {
      grew = true;
      fs.appendFileSync(f.image, appended);
    }
    return originalRead(file, buffer, offset, length, position ?? null);
  });
  assert.equal(digestOpenExecutable(f.file), sha256(appended));
  assert.equal(originalStat(f.file).size, appended.length);
});

test('borrowed descriptor reads preserve the current offset without seeking', t => {
  const f = imageFixture(t, 127);
  assert.equal(originalRead(f.file, Buffer.alloc(7), 0, 7, null), 7);
  assert.equal(digestOpenExecutable(f.file), sha256(f.bytes.subarray(7)));
  assert.equal(originalRead(f.file, Buffer.alloc(1), 0, 1, null), 0);
});

test('fresh descriptors hash changed contents without retaining a prior digest', t => {
  const f = imageFixture(t, 127);
  assert.equal(digestOpenExecutable(f.file), sha256(f.bytes));
  const changed = Buffer.alloc(f.bytes.length, 99);
  fs.writeFileSync(f.image, changed);
  const next = fs.openSync(f.image, 'r');
  try { assert.equal(digestOpenExecutable(next), sha256(changed)); }
  finally { fs.closeSync(next); }
});

test('read failure propagates unchanged while the caller still owns the fd', t => {
  const f = imageFixture(t);
  const failure = Object.assign(new Error('TEST read refused'), { code: 'EIO' });
  interceptRead(t, file => {
    assert.equal(file, f.file);
    throw failure;
  });
  assert.throws(() => digestOpenExecutable(f.file), error => error === failure);
  assert.equal(originalStat(f.file).size, f.bytes.length);
});

test('Node positive-size ceiling refuses before reading without closing the borrowed fd', t => {
  const f = imageFixture(t, 0);
  fs.truncateSync(f.image, 2 ** 31);
  assert.throws(() => digestOpenExecutable(f.file), {
    name: 'RangeError', code: 'ERR_FS_FILE_TOO_LARGE',
    message: `File size (${2 ** 31}) is greater than 2 GiB`,
  });
  assert.equal(originalStat(f.file).size, 2 ** 31);
});

const linuxOnly = { skip: process.platform !== 'linux' || process.arch !== 'x64' };
for (const change of ['none', 'truncate', 'grow', 'overwrite', 'replace', 'native-inode',
  'currentness', 'read-error'] as const) {
  test(`Linux original executable ${change === 'none' ? 'retains identity' : `refuses ${change}`} and closes its fd`, linuxOnly, t => {
    const f = imageFixture(t);
    const artifact = join(f.root, 'registered-process.node');
    fs.writeFileSync(artifact, 'TEST mocked native bridge; never execute');
    const imageStat = fs.lstatSync(f.image, { bigint: true });
    const identity = { pid: 4100, sessionId: 4100, pidfdId: '1234', pidNamespaceId: '5678',
      bootId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' };
    let current = true, nativeInode = imageStat.ino.toString(), measured = 0;
    const native = {
      kernelIdentity: () => ({ kernelRelease: '6.18.57', machine: 'x86_64', glibcVersion: '2.39',
        pidfd: true, pidfs: true }),
      captureRoot: () => identity,
      readRootExecutable: () => {
        ++measured;
        return { ...identity, executablePath: f.image,
          executableDevice: imageStat.dev.toString(), executableInode: nativeInode };
      },
    };
    t.mock.method(process, 'dlopen', (module: { exports: unknown }, path: string) => {
      assert.equal(path, artifact);
      module.exports = native;
    });
    t.after(() => { delete createRequire(import.meta.url).cache[artifact]; });
    const api = createQualifiedLinuxProcessApi({ path: artifact,
      sha256: sha256(fs.readFileSync(artifact)), kernelCapability: 'pidfd-live-v1',
      libc: { family: 'glibc', minimumVersion: '2.17' } });
    assert.ok(api);
    const child = new ChildProcess();
    Object.defineProperty(child, 'pid', { value: identity.pid });
    api.captureRoot(child, () => current);
    const originalOpen = fs.openSync;
    let ownedFile: number | undefined;
    t.mock.method(fs, 'openSync', ((path, flags, mode) => {
      const fd = originalOpen(path, flags, mode);
      if (path === f.image) ownedFile = fd;
      return fd;
    }) as typeof fs.openSync);
    let changed = false;
    const readFailure = Object.assign(new Error('TEST image read refused'), { code: 'EIO' });
    interceptRead(t, (file, buffer, offset, length, position) => {
      if (file === ownedFile && !changed) {
        changed = true;
        if (change === 'truncate') fs.truncateSync(f.image, 257);
        if (change === 'grow') fs.appendFileSync(f.image, 'TEST growth');
        if (change === 'overwrite') fs.writeFileSync(f.image, Buffer.alloc(f.bytes.length, 99));
        if (change === 'replace') {
          fs.renameSync(f.image, join(f.root, 'TEST-original-image'));
          fs.writeFileSync(f.image, f.bytes);
        }
        if (change === 'native-inode') nativeInode = (imageStat.ino + 1n).toString();
        if (change === 'currentness') current = false;
        if (change === 'read-error') throw readFailure;
      }
      return originalRead(file, buffer, offset, length, position ?? null);
    });
    const read = () => api.readRootExecutable(child, { path: f.image, sha256: sha256(f.bytes) });
    if (change === 'none') {
      assert.deepEqual(read(), { executablePath: f.image, executableSha256: sha256(f.bytes),
        pid: identity.pid,
        startIdentity: `${identity.bootId}:${identity.pidNamespaceId}:${identity.pidfdId}` });
      assert.equal(measured, 2);
    } else if (change === 'read-error') {
      assert.throws(read, error => error === readFailure);
    } else {
      assert.throws(read, /custody unavailable/);
    }
    assert.notEqual(ownedFile, undefined);
    assert.throws(() => originalStat(ownedFile!), { code: 'EBADF' });
    assert.equal(originalStat(f.file).ino, Number(imageStat.ino), 'unrelated caller fd remains open');
  });
}
