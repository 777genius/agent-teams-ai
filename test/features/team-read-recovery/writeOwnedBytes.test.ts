// @vitest-environment node
import * as fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import {
  OwnedReadDescriptors,
  type DescriptorCallbacks,
} from '../../../src/features/team-read-recovery/main/infrastructure/OwnedReadDescriptors';
import { writeOwnedBytes } from '../../../src/features/team-read-recovery/main/infrastructure/writeOwnedBytes';

let directory: string;
let path: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'TEST-sentry-owned-write-'));
  path = join(directory, 'captured.bin');
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

it('completes real partial writes across a chunk boundary using captured bytes and options', async () => {
  const data = Buffer.from('x'.repeat(1024 * 1024 - 1) + '😀tail');
  const expected = Buffer.from(data);
  const ranges: { position: number; count: number; bytes: number }[] = [];
  let syncCalls = 0;
  const write: DescriptorCallbacks['write'] = (fd, buffer, offset, bytes, position, callback) => {
    fs.write(fd, buffer, offset, Math.min(bytes, 64 * 1024), position, (error, count) => {
      ranges.push({ position, count, bytes });
      callback(error, count);
    });
  };
  const fsync: DescriptorCallbacks['fsync'] = (fd, callback) => {
    syncCalls++;
    fs.fsync(fd, callback);
  };
  const owner = new OwnedReadDescriptors({ ...fs, write, fsync });
  const options = {
    flags: fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
    maxBytes: data.byteLength,
    sync: true,
  };
  const task = writeOwnedBytes(path, data, options, owner);
  data.fill(120);
  options.sync = false;
  options.flags = fs.constants.O_RDONLY;
  options.maxBytes = 0;
  await task.result;
  expect(await task.physical).toEqual({ kind: 'closed' });
  expect(fs.readFileSync(path)).toEqual(expected);
  expect(ranges.length).toBeGreaterThan(1);
  let position = 0;
  for (const range of ranges) {
    expect(range.position).toBe(position);
    expect(range.bytes).toBeLessThanOrEqual(1024 * 1024);
    position += range.count;
  }
  expect(position).toBe(expected.byteLength);
  expect(syncCalls).toBe(1);
  expect(await owner.retire()).toEqual({ kind: 'closed' });
});

it('preserves explicit creation mode and exclusive-open failure without overwriting a file', async () => {
  const owner = new OwnedReadDescriptors();
  const options = {
    flags: fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
    mode: 0o600,
    maxBytes: 3,
    sync: false,
  };
  const first = writeOwnedBytes(path, Buffer.from('one'), options, owner);
  await first.result;
  expect(await first.physical).toEqual({ kind: 'closed' });
  if (process.platform !== 'win32') expect(fs.statSync(path).mode & 0o777).toBe(0o600);
  const second = writeOwnedBytes(path, Buffer.from('two'), options, owner);
  await expect(second.result).rejects.toMatchObject({ code: 'EEXIST' });
  expect(await second.physical).toEqual({ kind: 'closed' });
  expect(fs.readFileSync(path, 'utf8')).toBe('one');
  expect(await owner.retire()).toEqual({ kind: 'closed' });
});

it('waits for original close delivery after fsync before reporting write completion', async () => {
  let release!: () => void;
  let closed!: () => void;
  const observed = new Promise<void>((resolve) => {
    closed = resolve;
  });
  const close: DescriptorCallbacks['close'] = (fd, callback) =>
    fs.close(fd, (error) => {
      release = () => callback(error);
      closed();
    });
  const owner = new OwnedReadDescriptors({ ...fs, close });
  const task = writeOwnedBytes(
    path,
    Buffer.from('done'),
    { flags: fs.constants.O_WRONLY | fs.constants.O_CREAT, maxBytes: 4, sync: true },
    owner
  );
  await observed;
  const sentinel = Symbol();
  try {
    expect(await Promise.race([task.result, Promise.resolve(sentinel)])).toBe(sentinel);
    expect(await Promise.race([task.physical, Promise.resolve(sentinel)])).toBe(sentinel);
    expect(fs.readFileSync(path, 'utf8')).toBe('done');
  } finally {
    release();
    await task.physical;
  }
  await task.result;
  expect(await owner.retire()).toEqual({ kind: 'closed' });
});

it('rejects oversized data before creating or truncating a source file', async () => {
  const owner = new OwnedReadDescriptors();
  expect(() =>
    writeOwnedBytes(
      path,
      Buffer.from('large'),
      { flags: fs.constants.O_WRONLY | fs.constants.O_CREAT, maxBytes: 2, sync: false },
      owner
    )
  ).toThrow('byte limit');
  expect(fs.existsSync(path)).toBe(false);
  expect(await owner.retire()).toEqual({ kind: 'closed' });
});

it('fails a zero-progress original write instead of repeating it indefinitely', async () => {
  let writes = 0;
  const write: DescriptorCallbacks['write'] = (fd, buffer, offset, _bytes, position, callback) => {
    writes++;
    fs.write(fd, buffer, offset, 0, position, callback);
  };
  const owner = new OwnedReadDescriptors({ ...fs, write });
  const task = writeOwnedBytes(
    path,
    Buffer.from('data'),
    { flags: fs.constants.O_WRONLY | fs.constants.O_CREAT, maxBytes: 4, sync: false },
    owner
  );
  await expect(task.result).rejects.toThrow('valid progress');
  expect(writes).toBe(1);
  expect(await task.physical).toEqual({ kind: 'closed' });
  expect(fs.statSync(path).size).toBe(0);
  expect(await owner.retire()).toEqual({ kind: 'closed' });
});

it('refuses descriptor capacity before accessing or copying the complete input payload', async () => {
  fs.writeFileSync(path, 'existing');
  const owner = new OwnedReadDescriptors(fs, { maxOpenFiles: 1, maxReadsPerFile: 1 });
  const occupied = owner.open(path);
  await occupied.result;
  const data = new Uint8Array(4);
  const capture = vi.spyOn(Buffer, 'copyBytesFrom');
  try {
    const task = writeOwnedBytes(
      path,
      data,
      { flags: fs.constants.O_WRONLY | fs.constants.O_TRUNC, maxBytes: 4, sync: false },
      owner
    );
    await expect(task.result).rejects.toThrow('acquisition capacity');
    expect(capture).not.toHaveBeenCalled();
    expect(await task.physical).toEqual({ kind: 'closed' });
    expect(fs.readFileSync(path, 'utf8')).toBe('existing');
  } finally {
    capture.mockRestore();
    await owner.retire();
  }
  expect(await occupied.physical).toEqual({ kind: 'closed' });
});

it.each(['zero length', 'throwing metadata'])(
  'writes the complete intrinsic byte view despite %s',
  async (kind) => {
    fs.writeFileSync(path, 'existing');
    const data = Uint8Array.from([120, 65, 66, 121]).subarray(1, 3);
    if (kind === 'zero length') Object.defineProperty(data, 'length', { value: 0 });
    else {
      for (const key of ['length', 'byteLength', 'buffer', 'byteOffset', 'valueOf']) {
        Object.defineProperty(data, key, {
          get() {
            throw new Error('shadowed metadata');
          },
        });
      }
    }
    const owner = new OwnedReadDescriptors();
    try {
      const task = writeOwnedBytes(
        path,
        data,
        { flags: fs.constants.O_WRONLY | fs.constants.O_TRUNC, maxBytes: 2, sync: false },
        owner
      );
      data.fill(90);
      await task.result;
      expect(await task.physical).toEqual({ kind: 'closed' });
      expect(fs.readFileSync(path)).toEqual(Buffer.from([65, 66]));
    } finally {
      expect(await owner.retire()).toEqual({ kind: 'closed' });
    }
  }
);

it('rejects an intrinsically oversized view despite understated byteLength before truncation', async () => {
  fs.writeFileSync(path, 'existing');
  const data = Uint8Array.of(65, 66, 67);
  Object.defineProperty(data, 'byteLength', { value: 0 });
  const owner = new OwnedReadDescriptors();
  try {
    expect(() =>
      writeOwnedBytes(
        path,
        data,
        { flags: fs.constants.O_WRONLY | fs.constants.O_TRUNC, maxBytes: 2, sync: false },
        owner
      )
    ).toThrow('byte limit');
    expect(fs.readFileSync(path, 'utf8')).toBe('existing');
  } finally {
    expect(await owner.retire()).toEqual({ kind: 'closed' });
  }
});
