/**
 * Tests for atomicWriteAsync - tmp + fsync + rename atomic write pattern.
 */

import * as fs from 'fs';
import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('fs', () => ({
  promises: {
    mkdir: vi.fn(),
    writeFile: vi.fn(),
    open: vi.fn(),
    lstat: vi.fn(),
    link: vi.fn(),
    readdir: vi.fn(),
    rename: vi.fn(),
    copyFile: vi.fn(),
    unlink: vi.fn(),
  },
}));

import {
  atomicCreateAsync,
  atomicWriteAsync,
  cleanupAtomicCreateTempLinks,
  renamePathWithRetry,
} from '../../../src/main/utils/atomicWrite';

// =============================================================================
// Setup
// =============================================================================

const mockMkdir = vi.mocked(fs.promises.mkdir);
const mockWriteFile = vi.mocked(fs.promises.writeFile);
const mockOpen = vi.mocked(fs.promises.open);
const mockLstat = vi.mocked(fs.promises.lstat);
const mockLink = vi.mocked(fs.promises.link);
const mockReaddir = vi.mocked(fs.promises.readdir);
const mockRename = vi.mocked(fs.promises.rename);
const mockCopyFile = vi.mocked(fs.promises.copyFile);
const mockUnlink = vi.mocked(fs.promises.unlink);

const TARGET_PATH = path.resolve('/Users/test/project/src/index.ts');
const TARGET_DIR = path.dirname(TARGET_PATH);
const CONTENT = 'export const hello = "world";';

/** Extract the tmp path from writeFile calls */
function getTmpPath(): string {
  const call = mockWriteFile.mock.calls[0];
  const filePath = call?.[0];
  if (typeof filePath !== 'string') throw new Error('Expected a string temporary path');
  return filePath;
}

beforeEach(() => {
  vi.resetAllMocks();

  // Default happy path
  mockMkdir.mockResolvedValue(undefined);
  mockWriteFile.mockResolvedValue(undefined);
  mockOpen.mockResolvedValue({
    sync: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as fs.promises.FileHandle);
  mockLstat.mockResolvedValue({
    dev: 1,
    ino: 2,
    nlink: 1,
  } as unknown as Awaited<ReturnType<typeof fs.promises.lstat>>);
  mockLink.mockResolvedValue(undefined);
  mockReaddir.mockResolvedValue([]);
  mockRename.mockResolvedValue(undefined);
  mockUnlink.mockResolvedValue(undefined);
});

// =============================================================================
// Tests
// =============================================================================

describe('atomicWriteAsync', () => {
  it('writes to tmp file in same directory then renames to target', async () => {
    await atomicWriteAsync(TARGET_PATH, CONTENT);

    // writeFile should be called with a tmp path in the same directory
    expect(mockWriteFile).toHaveBeenCalledTimes(1);
    const tmpPath = getTmpPath();
    const escapedDir = TARGET_DIR.replace(/[\\]/g, '\\\\');
    expect(tmpPath).toMatch(new RegExp(`^${escapedDir}[/\\\\]\\.tmp\\.[a-f0-9-]+$`));

    // rename from tmp to target
    expect(mockRename).toHaveBeenCalledWith(tmpPath, TARGET_PATH);
  });

  it('creates parent directories recursively', async () => {
    await atomicWriteAsync(TARGET_PATH, CONTENT);

    expect(mockMkdir).toHaveBeenCalledWith(TARGET_DIR, { recursive: true });
  });

  it('writes content with utf8 encoding', async () => {
    await atomicWriteAsync(TARGET_PATH, CONTENT);

    expect(mockWriteFile).toHaveBeenCalledWith(expect.any(String), CONTENT, {
      encoding: 'utf8',
      flag: 'wx',
    });
  });

  it('preserves requested file mode on tmp writes', async () => {
    await atomicWriteAsync(TARGET_PATH, CONTENT, { mode: 0o600 });

    expect(mockWriteFile).toHaveBeenCalledWith(expect.any(String), CONTENT, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
  });

  it('calls fsync on tmp file before rename', async () => {
    const mockSync = vi.fn().mockResolvedValue(undefined);
    const mockClose = vi.fn().mockResolvedValue(undefined);
    mockOpen.mockResolvedValue({
      sync: mockSync,
      close: mockClose,
    } as unknown as fs.promises.FileHandle);

    await atomicWriteAsync(TARGET_PATH, CONTENT);

    const tmpPath = getTmpPath();
    expect(mockOpen).toHaveBeenCalledWith(tmpPath, 'r+');
    expect(mockSync).toHaveBeenCalled();
    expect(mockClose).toHaveBeenCalled();
  });

  it('still renames even if fsync fails (best-effort)', async () => {
    mockOpen.mockRejectedValue(new Error('fsync not supported'));

    await atomicWriteAsync(TARGET_PATH, CONTENT);

    expect(mockRename).toHaveBeenCalled();
  });

  it('fails closed before publish when strict fsync fails', async () => {
    mockOpen.mockRejectedValue(new Error('fsync unavailable'));

    await expect(atomicWriteAsync(TARGET_PATH, CONTENT, { durability: 'strict' })).rejects.toThrow(
      'fsync unavailable'
    );

    expect(mockRename).not.toHaveBeenCalled();
    expect(mockUnlink).toHaveBeenCalledWith(getTmpPath());
  });

  it('fails closed instead of copying over the target on impossible same-dir EXDEV', async () => {
    const exdevError = Object.assign(new Error('Cross-device link'), { code: 'EXDEV' });
    mockRename.mockRejectedValue(exdevError);

    await expect(atomicWriteAsync(TARGET_PATH, CONTENT)).rejects.toThrow('Cross-device link');

    const tmpPath = getTmpPath();
    expect(mockCopyFile).not.toHaveBeenCalled();
    expect(mockUnlink).toHaveBeenCalledWith(tmpPath);
  });

  it.each(['EPERM', 'EACCES', 'EBUSY'])(
    'retries transient %s rename failures before publishing',
    async (code) => {
      const transientError = Object.assign(new Error(`Transient ${code}`), { code });
      mockRename
        .mockRejectedValueOnce(transientError)
        .mockRejectedValueOnce(transientError)
        .mockResolvedValue(undefined);

      await atomicWriteAsync(TARGET_PATH, CONTENT);

      const tmpPath = getTmpPath();
      expect(mockRename).toHaveBeenCalledTimes(3);
      expect(mockRename).toHaveBeenLastCalledWith(tmpPath, TARGET_PATH);
      expect(mockUnlink).not.toHaveBeenCalled();
    }
  );

  it('revalidates compare-and-swap state before every rename retry', async () => {
    const transientError = Object.assign(new Error('Transient EPERM'), { code: 'EPERM' });
    const beforeCommit = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('external edit'));
    mockRename.mockRejectedValueOnce(transientError);

    await expect(atomicWriteAsync(TARGET_PATH, CONTENT, { beforeCommit })).rejects.toThrow(
      'external edit'
    );

    expect(beforeCommit).toHaveBeenCalledTimes(2);
    expect(mockRename).toHaveBeenCalledTimes(1);
    expect(mockUnlink).toHaveBeenCalledWith(getTmpPath());
  });

  it('syncs the parent directory only when requested', async () => {
    await atomicWriteAsync(TARGET_PATH, CONTENT, { syncDirectory: true });

    expect(mockOpen).toHaveBeenNthCalledWith(1, getTmpPath(), 'r+');
    expect(mockOpen).toHaveBeenNthCalledWith(2, TARGET_DIR, 'r');
  });

  it('reports a strict directory fsync failure after publish', async () => {
    const fileHandle = {
      sync: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const directoryHandle = {
      sync: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('directory device failure'), { code: 'EIO' })),
      close: vi.fn().mockResolvedValue(undefined),
    };
    mockOpen
      .mockResolvedValueOnce(fileHandle as unknown as fs.promises.FileHandle)
      .mockResolvedValueOnce(directoryHandle as unknown as fs.promises.FileHandle);

    await expect(
      atomicWriteAsync(TARGET_PATH, CONTENT, {
        durability: 'strict',
        syncDirectory: true,
      })
    ).rejects.toThrow('directory device failure');

    expect(mockRename).toHaveBeenCalledWith(getTmpPath(), TARGET_PATH);
    expect(directoryHandle.close).toHaveBeenCalled();
  });

  it('accepts an explicitly unsupported directory fsync result in strict mode', async () => {
    const fileHandle = {
      sync: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const directoryHandle = {
      sync: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('unsupported directory sync'), { code: 'EINVAL' })),
      close: vi.fn().mockResolvedValue(undefined),
    };
    mockOpen
      .mockResolvedValueOnce(fileHandle as unknown as fs.promises.FileHandle)
      .mockResolvedValueOnce(directoryHandle as unknown as fs.promises.FileHandle);

    await expect(
      atomicWriteAsync(TARGET_PATH, CONTENT, {
        durability: 'strict',
        syncDirectory: true,
      })
    ).resolves.toBeUndefined();
  });

  it('continues retrying beyond short antivirus-style locks', async () => {
    const transientError = Object.assign(new Error('Transient EPERM'), { code: 'EPERM' });
    mockRename.mockImplementation(async () => {
      if (mockRename.mock.calls.length < 12) {
        throw transientError;
      }
    });

    await atomicWriteAsync(TARGET_PATH, CONTENT);

    const tmpPath = getTmpPath();
    expect(mockRename).toHaveBeenCalledTimes(12);
    expect(mockRename).toHaveBeenLastCalledWith(tmpPath, TARGET_PATH);
    expect(mockUnlink).not.toHaveBeenCalled();
  });

  it('retries managed path renames without using atomic-write EXDEV fallback', async () => {
    const transientError = Object.assign(new Error('Transient EPERM'), { code: 'EPERM' });
    mockRename.mockRejectedValueOnce(transientError).mockResolvedValue(undefined);

    await renamePathWithRetry('/tmp/source', '/tmp/target');

    expect(mockRename).toHaveBeenCalledTimes(2);
    expect(mockRename).toHaveBeenLastCalledWith('/tmp/source', '/tmp/target');
    expect(mockCopyFile).not.toHaveBeenCalled();
    expect(mockUnlink).not.toHaveBeenCalled();
  });

  it('does not copy generic managed paths on EXDEV rename failure', async () => {
    const exdevError = Object.assign(new Error('Cross-device link'), { code: 'EXDEV' });
    mockRename.mockRejectedValue(exdevError);

    await expect(renamePathWithRetry('/tmp/source-dir', '/tmp/target-dir')).rejects.toThrow(
      'Cross-device link'
    );

    expect(mockRename).toHaveBeenCalledTimes(1);
    expect(mockCopyFile).not.toHaveBeenCalled();
  });

  it('does not retry ENOENT rename failures and cleans tmp', async () => {
    const missingError = Object.assign(new Error('No such file or directory'), { code: 'ENOENT' });
    mockRename.mockRejectedValue(missingError);

    await expect(atomicWriteAsync(TARGET_PATH, CONTENT)).rejects.toThrow(
      'No such file or directory'
    );
    expect(mockRename).toHaveBeenCalledTimes(1);
    expect(mockUnlink).toHaveBeenCalled();
  });

  it('cleans tmp after retryable rename failures are exhausted', async () => {
    const transientError = Object.assign(new Error('Transient lock stayed active'), {
      code: 'EBUSY',
    });
    mockRename.mockRejectedValue(transientError);

    await expect(atomicWriteAsync(TARGET_PATH, CONTENT)).rejects.toThrow(
      'Transient lock stayed active'
    );
    expect(mockRename).toHaveBeenCalledTimes(20);
    expect(mockUnlink).toHaveBeenCalled();
  });

  it('re-throws non-retryable rename errors and cleans tmp', async () => {
    const writeError = Object.assign(new Error('Disk unavailable'), { code: 'ENOSPC' });
    mockRename.mockRejectedValue(writeError);

    await expect(atomicWriteAsync(TARGET_PATH, CONTENT)).rejects.toThrow('Disk unavailable');
    expect(mockRename).toHaveBeenCalledTimes(1);
    expect(mockUnlink).toHaveBeenCalled();
  });

  it('cleans up tmp file on writeFile failure', async () => {
    mockWriteFile.mockRejectedValue(new Error('Disk full'));

    await expect(atomicWriteAsync(TARGET_PATH, CONTENT)).rejects.toThrow('Disk full');
    expect(mockUnlink).toHaveBeenCalled();
  });

  it('creates parent directories for deeply nested paths', async () => {
    const deepPath = '/Users/test/project/src/deep/nested/file.ts';
    await atomicWriteAsync(deepPath, CONTENT);

    expect(mockMkdir).toHaveBeenCalledWith(path.dirname(deepPath), { recursive: true });
  });
});

describe('atomicCreateAsync', () => {
  it('publishes a fully-synced temp file without overwriting an existing target', async () => {
    const result = await atomicCreateAsync(TARGET_PATH, CONTENT);

    const tmpPath = getTmpPath();
    expect(tmpPath).toMatch(/\.review-create\.[a-f0-9-]+\.tmp$/);
    expect(mockLink).toHaveBeenCalledWith(tmpPath, TARGET_PATH);
    expect(mockUnlink).toHaveBeenCalledWith(tmpPath);
    expect(result).toEqual({ dev: 1, ino: 2 });
  });

  it('cleans the complete temp file and preserves the raced target on EEXIST', async () => {
    mockLink.mockRejectedValue(Object.assign(new Error('exists'), { code: 'EEXIST' }));

    await expect(atomicCreateAsync(TARGET_PATH, CONTENT)).rejects.toMatchObject({
      code: 'EEXIST',
    });

    expect(mockUnlink).toHaveBeenCalledWith(getTmpPath());
    expect(mockUnlink).not.toHaveBeenCalledWith(TARGET_PATH);
  });

  it('reports terminal success when only crash-temp cleanup fails after publish', async () => {
    mockUnlink.mockRejectedValueOnce(Object.assign(new Error('temporary lock'), { code: 'EBUSY' }));

    await expect(atomicCreateAsync(TARGET_PATH, CONTENT)).resolves.toEqual({ dev: 1, ino: 2 });

    expect(mockLink).toHaveBeenCalledWith(getTmpPath(), TARGET_PATH);
    expect(mockUnlink).not.toHaveBeenCalledWith(TARGET_PATH);
  });

  it('removes only a crash-left owned temp hardlink', async () => {
    mockLstat.mockResolvedValue({
      dev: 7,
      ino: 9,
      nlink: 2,
    } as unknown as Awaited<ReturnType<typeof fs.promises.lstat>>);
    mockReaddir.mockResolvedValue([
      '.review-create.12345678-1234-1234-1234-123456789abc.tmp',
      'user-file.tmp',
    ] as unknown as Awaited<ReturnType<typeof fs.promises.readdir>>);

    await cleanupAtomicCreateTempLinks(TARGET_PATH);

    expect(mockUnlink).toHaveBeenCalledTimes(1);
    expect(String(mockUnlink.mock.calls[0]?.[0])).toContain('.review-create.');
  });
});
