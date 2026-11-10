// @vitest-environment node
import * as fs from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';

import {
  OwnedReadDescriptors,
  type DescriptorCallbacks,
} from '../../../src/features/team-read-recovery/main/infrastructure/OwnedReadDescriptors';
import { syncOwnedPath } from '../../../src/features/team-read-recovery/main/infrastructure/syncOwnedPath';

let directory: string;
let file: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'TEST-sentry-owned-sync-'));
  file = join(directory, 'source');
  await writeFile(file, 'retained');
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

it('uses captured directory policy and closes the real directory descriptor', async () => {
  const owner = new OwnedReadDescriptors();
  const options = { target: 'directory' as const, durability: 'strict' as const };
  const task = syncOwnedPath(directory, options, owner);
  Object.assign(options, { target: 'file', durability: 'invalid' });
  const report = await task.result;
  if (process.platform === 'win32') expect(['synced', 'unsupported']).toContain(report.status);
  else expect(report).toEqual({ status: 'synced' });
  expect(await task.physical).toEqual({ kind: 'closed' });
  expect(await owner.retire()).toEqual({ kind: 'closed' });
});

it('retains both completion ports until the original close callback is delivered', async () => {
  let release!: () => void;
  let observed!: () => void;
  const reachedClose = new Promise<void>((resolve) => {
    observed = resolve;
  });
  const close: DescriptorCallbacks['close'] = (fd, callback) =>
    fs.close(fd, (error) => {
      release = () => callback(error);
      observed();
    });
  const owner = new OwnedReadDescriptors({ ...fs, close });
  const task = syncOwnedPath(file, { target: 'file', durability: 'strict' }, owner);
  let logical = false;
  let physical = false;
  void task.result.then(() => {
    logical = true;
  });
  void task.physical.then(() => {
    physical = true;
  });
  try {
    await reachedClose;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(logical).toBe(false);
    expect(physical).toBe(false);
  } finally {
    release();
  }
  expect(await task.result).toEqual({ status: 'synced' });
  expect(await task.physical).toEqual({ kind: 'closed' });
  expect(await owner.retire()).toEqual({ kind: 'closed' });
});

function syncFailure(error: NodeJS.ErrnoException): DescriptorCallbacks['fsync'] {
  // Execute real fsync first; substitute only delivered error for the policy contract.
  return (fd, callback) => fs.fsync(fd, (nativeError) => callback(nativeError ?? error));
}

it('reports a best-effort storage fault but preserves strict failure after closure', async () => {
  const error = Object.assign(new Error('storage failed'), { code: 'EIO' });
  const owner = new OwnedReadDescriptors({ ...fs, fsync: syncFailure(error) });
  const strict = syncOwnedPath(directory, { target: 'directory', durability: 'strict' }, owner);
  await expect(strict.result).rejects.toBe(error);
  expect(await strict.physical).toEqual({ kind: 'closed' });
  const best = syncOwnedPath(file, { target: 'file', durability: 'best-effort' }, owner);
  expect(await best.result).toEqual({ status: 'best-effort-failed', fault: 'storage failed' });
  expect(await best.physical).toEqual({ kind: 'closed' });
  expect(await owner.retire()).toEqual({ kind: 'closed' });
});

it('suppresses unsupported directory sync without suppressing the same file error', async () => {
  const error = Object.assign(new Error('sync unsupported'), { code: 'EINVAL' });
  const owner = new OwnedReadDescriptors({ ...fs, fsync: syncFailure(error) });
  const dir = syncOwnedPath(directory, { target: 'directory', durability: 'strict' }, owner);
  expect(await dir.result).toEqual({ status: 'unsupported', fault: 'sync unsupported' });
  const regular = syncOwnedPath(file, { target: 'file', durability: 'strict' }, owner);
  await expect(regular.result).rejects.toBe(error);
  expect(await dir.physical).toEqual({ kind: 'closed' });
  expect(await regular.physical).toEqual({ kind: 'closed' });
  expect(await owner.retire()).toEqual({ kind: 'closed' });
});

it('never turns unconfirmed close into best-effort success or retries the fd', async () => {
  let closes = 0;
  const error = Object.assign(new Error('close unconfirmed'), { code: 'EIO' });
  const close: DescriptorCallbacks['close'] = (fd, callback) => {
    closes++;
    fs.close(fd, (nativeError) => callback(nativeError ?? error));
  };
  const owner = new OwnedReadDescriptors({ ...fs, close });
  const task = syncOwnedPath(file, { target: 'file', durability: 'best-effort' }, owner);
  await expect(task.result).rejects.toThrow('close unconfirmed');
  expect(await task.physical).toEqual({ kind: 'unknown', fault: 'close unconfirmed' });
  expect(await owner.retire()).toEqual({ kind: 'unknown', fault: 'close unconfirmed' });
  expect(closes).toBe(1);
  expect(owner.unresolvedLeases()).toHaveLength(1);
});

it('does not let a throwing error-code getter escape directory failure cleanup', async () => {
  const error = new Error('fault code is unavailable');
  Object.defineProperty(error, 'code', {
    get() {
      throw new Error('bad getter');
    },
  });
  const owner = new OwnedReadDescriptors({ ...fs, fsync: syncFailure(error) });
  const task = syncOwnedPath(directory, { target: 'directory', durability: 'strict' }, owner);
  await expect(task.result).rejects.toBe(error);
  expect(await task.physical).toEqual({ kind: 'closed' });
  expect(await owner.retire()).toEqual({ kind: 'closed' });
});
