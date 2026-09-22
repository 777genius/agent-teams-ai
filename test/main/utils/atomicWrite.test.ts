/**
 * Tests for atomicWriteAsync - tmp + fsync + rename atomic write pattern.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as lockfile from 'proper-lockfile';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('fs', () => ({
  promises: {
    mkdir: vi.fn(),
    writeFile: vi.fn(),
    readFile: vi.fn(),
    open: vi.fn(),
    lstat: vi.fn(),
    link: vi.fn(),
    readdir: vi.fn(),
    rename: vi.fn(),
    copyFile: vi.fn(),
    unlink: vi.fn(),
    mkdtemp: vi.fn(),
    rmdir: vi.fn(),
    utimes: vi.fn(),
    opendir: vi.fn(),
  },
  constants: {
    O_RDONLY: 0,
    O_DIRECTORY: 0x10000,
    O_NOFOLLOW: 0x20000,
  },
}));

vi.mock('proper-lockfile', () => ({
  lock: vi.fn(async () => async () => undefined),
}));

import {
  atomicCreateAsync,
  atomicWriteAsync,
  cleanupAtomicCreateTempLinks,
  renamePathWithRetry,
} from '../../../src/main/utils/atomicWrite';
import {
  retireOwnedPrivateChild,
  retireOwnedPrivateDirectory,
} from '../../../src/main/utils/atomicCreateCleanupIdentity';
import {
  allocateAtomicCreateRecoveryDirectory,
  withAtomicCreateCleanupCapacity,
} from '../../../src/main/utils/atomicCreateCleanupCapacity';
import { withAtomicCreateCleanupLeaseLifetime } from '../../../src/main/utils/atomicCreateCleanupLeaseLifetime';
import { allocateAtomicCreateRecoveryDirectoryAuthority } from '../../../src/main/utils/atomicCreateCleanupRecoveryDirectory';
import { readBoundedRegularText } from '../../../src/main/utils/atomicCreateCleanupRecoveryIo';

// =============================================================================
// Setup
// =============================================================================

const mockMkdir = vi.mocked(fs.promises.mkdir);
const mockWriteFile = vi.mocked(fs.promises.writeFile);
const mockReadFile = vi.mocked(fs.promises.readFile);
const mockOpen = vi.mocked(fs.promises.open);
const mockLstat = vi.mocked(fs.promises.lstat);
const mockLink = vi.mocked(fs.promises.link);
const mockReaddir = vi.mocked(fs.promises.readdir);
const mockRename = vi.mocked(fs.promises.rename);
const mockCopyFile = vi.mocked(fs.promises.copyFile);
const mockUnlink = vi.mocked(fs.promises.unlink);
const mockMkdtemp = vi.mocked(fs.promises.mkdtemp);
const mockRmdir = vi.mocked(fs.promises.rmdir);
const mockUtimes = vi.mocked(fs.promises.utimes);
const mockOpendir = vi.mocked(fs.promises.opendir);

type ExactGenerationMockOperations = {
  unlinkExactGeneration?: (pathname: string, identity: unknown) => Promise<void>;
  rmdirExactGeneration?: (pathname: string, identity: unknown) => Promise<void>;
  renameExactGeneration?: (source: string, destination: string, identity: unknown) => Promise<void>;
  mkdtempWithHandle?: (prefix: string) => Promise<{
    pathname: string;
    directoryHandle: fs.promises.FileHandle;
  }>;
};

function exactGenerationMockOperations(): ExactGenerationMockOperations {
  return fs.promises as typeof fs.promises & ExactGenerationMockOperations;
}

function hasExactMockIdentity(actual: unknown, expected: unknown, file: boolean): boolean {
  const actualIdentity = actual as Partial<fs.Stats>;
  const expectedIdentity = expected as Partial<fs.Stats>;
  return (
    actualIdentity.dev === expectedIdentity.dev &&
    actualIdentity.ino === expectedIdentity.ino &&
    actualIdentity.birthtimeMs === expectedIdentity.birthtimeMs &&
    (!file || actualIdentity.size === expectedIdentity.size)
  );
}

function hasUsableExactMockIdentity(identity: unknown, file: boolean): boolean {
  const candidate = identity as Partial<fs.Stats>;
  return (
    Number.isSafeInteger(candidate.dev) &&
    Number.isSafeInteger(candidate.ino) &&
    Number(candidate.ino) > 0 &&
    Number.isFinite(candidate.birthtimeMs) &&
    (!file || Number.isFinite(candidate.size))
  );
}

function missing(): NodeJS.ErrnoException {
  return Object.assign(new Error('missing'), { code: 'ENOENT' });
}

const TARGET_PATH = path.resolve('/Users/test/project/src/index.ts');
const TARGET_DIR = path.dirname(TARGET_PATH);
const CONTENT = 'export const hello = "world";';
let mockFileContents = new Map<string, string>();

/** Extract the tmp path from writeFile calls */
function getTmpPath(): string {
  const call = mockWriteFile.mock.calls[0];
  const filePath = call?.[0];
  if (typeof filePath !== 'string') throw new Error('Expected a string temporary path');
  return filePath;
}

type DirectoryFailureStage = 'open' | 'sync' | 'close';

function directoryEntries(...batches: string[][]): void {
  for (const batch of batches) {
    const entries = batch.map((name) => ({ name, isDirectory: () => true })) as fs.Dirent[];
    mockOpendir.mockResolvedValueOnce({
      [Symbol.asyncIterator]: async function* () {
        yield* entries;
      },
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as fs.promises.Dir);
  }
}

function mockDirectoryFailure(stage: DirectoryFailureStage, error: Error): void {
  const fileHandle = {
    sync: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as fs.promises.FileHandle;
  mockOpen.mockReset().mockResolvedValueOnce(fileHandle);

  if (stage === 'open') {
    mockOpen.mockRejectedValueOnce(error);
    return;
  }

  mockOpen.mockResolvedValueOnce({
    sync:
      stage === 'sync' ? vi.fn().mockRejectedValue(error) : vi.fn().mockResolvedValue(undefined),
    close:
      stage === 'close' ? vi.fn().mockRejectedValue(error) : vi.fn().mockResolvedValue(undefined),
  } as unknown as fs.promises.FileHandle);
}

beforeEach(() => {
  vi.resetAllMocks();
  mockFileContents = new Map<string, string>();

  // Default happy path
  mockMkdir.mockResolvedValue(undefined);
  mockWriteFile.mockImplementation(async (pathname, data) => {
    mockFileContents.set(String(pathname), String(data));
  });
  mockReadFile.mockImplementation(async (pathname) => mockFileContents.get(String(pathname)) ?? '');
  mockOpen.mockImplementation(
    async (pathname) =>
      ({
        fd: 77,
        sync: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        readFile: vi.fn().mockResolvedValue(''),
        read: vi.fn(async (buffer: Buffer) => {
          const content = await mockReadFile(pathname, 'utf8');
          buffer.write(content, 'utf8');
          return { bytesRead: Buffer.byteLength(content), buffer };
        }),
        stat: vi
          .fn()
          .mockResolvedValue(
            String(pathname).endsWith('.atomic-create-recovery.json')
              ? { isFile: () => true }
              : {
                  dev: 7,
                  ino: 10,
                  birthtimeMs: 12,
                  size: 0,
                  isDirectory: () => true,
                  isFile: () => true,
                }
          ),
      }) as unknown as fs.promises.FileHandle
  );
  mockLstat.mockResolvedValue({
    dev: 1,
    ino: 2,
    birthtimeMs: 3,
    size: CONTENT.length,
    nlink: 1,
    isDirectory: () => true,
    isFile: () => true,
    isSymbolicLink: () => false,
  } as unknown as Awaited<ReturnType<typeof fs.promises.lstat>>);
  // The cleanup lease publishes owner.json by atomically linking a complete
  // pending file. Model that filesystem visibility so release can fence the
  // owner record just as production does.
  mockLink.mockImplementation(async (source, destination) => {
    const data = mockFileContents.get(String(source));
    if (data !== undefined) mockFileContents.set(String(destination), data);
  });
  mockReaddir.mockResolvedValue([]);
  mockRename.mockImplementation(async (source, destination) => {
    const content = mockFileContents.get(String(source));
    if (content !== undefined) {
      mockFileContents.delete(String(source));
      mockFileContents.set(String(destination), content);
    }
  });
  mockUnlink.mockImplementation(async (pathname) => {
    mockFileContents.delete(String(pathname));
  });
  mockMkdtemp.mockImplementation(async (prefix) => `${String(prefix)}cleanup-test`);
  mockRmdir.mockResolvedValue(undefined);
  mockUtimes.mockResolvedValue(undefined);
  mockOpendir.mockImplementation(
    async () =>
      ({
        [Symbol.asyncIterator]: async function* () {},
        close: vi.fn().mockResolvedValue(undefined),
      }) as unknown as fs.promises.Dir
  );
  vi.mocked(lockfile.lock).mockResolvedValue(async () => undefined);
  // The production path deliberately requires an inode-bound primitive. The
  // ordinary fake requires a usable identity token; adversarial schedules
  // below replace it with an atomic inode-state model that rejects a mismatch
  // at the destructive boundary.
  exactGenerationMockOperations().unlinkExactGeneration = async (pathname, identity) => {
    if (!hasUsableExactMockIdentity(identity, true)) throw missing();
    await fs.promises.unlink(pathname);
  };
  exactGenerationMockOperations().rmdirExactGeneration = async (pathname, identity) => {
    if (!hasUsableExactMockIdentity(identity, false)) throw missing();
    await fs.promises.rmdir(pathname);
  };
  exactGenerationMockOperations().renameExactGeneration = async (source, destination, identity) => {
    if (!hasUsableExactMockIdentity(identity, true)) throw missing();
    await fs.promises.rename(source, destination);
  };
  exactGenerationMockOperations().mkdtempWithHandle = async (prefix) => {
    const pathname = await fs.promises.mkdtemp(prefix);
    return { pathname, directoryHandle: await fs.promises.open(pathname, fs.constants.O_RDONLY) };
  };
});

describe('atomic-create cleanup descriptor and heartbeat boundaries', () => {
  it('does not close a timed-out record descriptor until its read has drained', async () => {
    vi.useFakeTimers();
    try {
      let finishRead: (() => void) | undefined;
      const readMayFinish = new Promise<void>((resolve) => {
        finishRead = resolve;
      });
      const close = vi.fn().mockResolvedValue(undefined);
      mockLstat.mockResolvedValue({
        dev: 7,
        ino: 10,
        birthtimeMs: 12,
        size: 4,
        isFile: () => true,
        isSymbolicLink: () => false,
      } as unknown as Awaited<ReturnType<typeof fs.promises.lstat>>);
      mockOpen.mockResolvedValue({
        close,
        stat: vi.fn().mockResolvedValue({
          dev: 7,
          ino: 10,
          birthtimeMs: 12,
          size: 4,
          isFile: () => true,
        }),
        read: vi.fn(async () => {
          await readMayFinish;
          return { bytesRead: 0 };
        }),
      } as unknown as fs.promises.FileHandle);

      const read = readBoundedRegularText('/tmp/atomic-create-delayed-owner', 16);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(read).rejects.toThrow('read timed out');
      expect(close).not.toHaveBeenCalled();

      finishRead?.();
      await Promise.resolve();
      await Promise.resolve();
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops heartbeat scheduling and drains the in-flight heartbeat before release', async () => {
    vi.useFakeTimers();
    try {
      let heartbeatStarted: (() => void) | undefined;
      const heartbeatRunning = new Promise<void>((resolve) => {
        heartbeatStarted = resolve;
      });
      let finishHeartbeat: (() => void) | undefined;
      const heartbeatMayFinish = new Promise<void>((resolve) => {
        finishHeartbeat = resolve;
      });
      let finishOperation: (() => void) | undefined;
      const operationMayFinish = new Promise<void>((resolve) => {
        finishOperation = resolve;
      });
      const events: string[] = [];
      const lifetime = withAtomicCreateCleanupLeaseLifetime(
        async () => {
          await operationMayFinish;
          return 'complete';
        },
        async () => ({ lease: 'A' }),
        async () => {
          events.push('heartbeat');
          heartbeatStarted?.();
          await heartbeatMayFinish;
          events.push('heartbeat-drained');
        },
        async () => {
          events.push('released');
        },
        10
      );

      await vi.advanceTimersByTimeAsync(10);
      await heartbeatRunning;
      finishOperation?.();
      await Promise.resolve();
      expect(events).toEqual(['heartbeat']);

      finishHeartbeat?.();
      await expect(lifetime).resolves.toBe('complete');
      expect(events).toEqual(['heartbeat', 'heartbeat-drained', 'released']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('removes a published lease when owner-lock acquisition fails', async () => {
    const ownerLockFailure = Object.assign(new Error('owner lock failed'), { code: 'EIO' });
    const releaseAdmissionLock = vi.fn().mockResolvedValue(undefined);
    vi.mocked(lockfile.lock)
      .mockResolvedValueOnce(releaseAdmissionLock)
      .mockRejectedValueOnce(ownerLockFailure);

    await expect(
      withAtomicCreateCleanupCapacity('/proc/self/fd/77/.', async () => undefined)
    ).rejects.toBe(ownerLockFailure);

    expect(releaseAdmissionLock).toHaveBeenCalledTimes(1);
    expect(mockUnlink).toHaveBeenCalledWith(
      expect.stringMatching(/\.atomic-create-cleanup-lease-[a-f0-9-]+\/owner\.json$/)
    );
    expect(mockRmdir).toHaveBeenCalledWith(
      expect.stringMatching(/\.atomic-create-cleanup-lease-[a-f0-9-]+$/)
    );
  });

  it('closes a newly-created recovery descriptor when admission is lost before capture', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    exactGenerationMockOperations().mkdtempWithHandle = async () => ({
      pathname: '/proc/self/fd/77/.review-create-cleanup-lost-identity',
      directoryHandle: { close } as unknown as fs.promises.FileHandle,
    });
    let ownershipChecks = 0;

    await expect(
      allocateAtomicCreateRecoveryDirectoryAuthority(
        '/proc/self/fd/77/.',
        '/proc/self/fd/77/.review-create-cleanup-lost-',
        async () => 0,
        64,
        async (operation) =>
          operation({
            assertOwnership: async () => {
              ownershipChecks++;
              if (ownershipChecks === 3) throw new Error('admission lost');
            },
          }),
        async () => undefined
      )
    ).rejects.toThrow('admission lost');

    expect(close).toHaveBeenCalledTimes(1);
  });
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
    const onDirectorySyncOutcome = vi.fn();
    await atomicWriteAsync(TARGET_PATH, CONTENT, {
      syncDirectory: true,
      onDirectorySyncOutcome,
    });

    expect(mockOpen).toHaveBeenNthCalledWith(1, getTmpPath(), 'r+');
    expect(mockOpen).toHaveBeenNthCalledWith(2, TARGET_DIR, 'r');
    expect(onDirectorySyncOutcome).toHaveBeenCalledWith('durable');
  });

  it.each(['open', 'sync'] as const)(
    'fails strict parent-directory %s before publish',
    async (stage) => {
      const failure = new Error(`directory ${stage} failed`);
      mockDirectoryFailure(stage, failure);

      await expect(
        atomicWriteAsync(TARGET_PATH, CONTENT, {
          durability: 'strict',
          syncDirectory: true,
        })
      ).rejects.toBe(failure);

      expect(mockRename).not.toHaveBeenCalled();
      expect(mockOpen).toHaveBeenNthCalledWith(2, TARGET_DIR, 'r');
    }
  );

  it('does not misreport a close failure after strict publication succeeds', async () => {
    const onDirectorySyncOutcome = vi.fn();
    mockDirectoryFailure('close', new Error('directory close failed'));

    await expect(
      atomicWriteAsync(TARGET_PATH, CONTENT, {
        durability: 'strict',
        syncDirectory: true,
        onDirectorySyncOutcome,
      })
    ).resolves.toBeUndefined();

    expect(mockRename).toHaveBeenCalledOnce();
    expect(onDirectorySyncOutcome).toHaveBeenCalledWith('durable');
  });

  it('does not misreport a directory sync failure after strict publication succeeds', async () => {
    const onDirectorySyncOutcome = vi.fn();
    const directorySync = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('post-publish directory sync failed'));
    mockOpen
      .mockResolvedValueOnce({
        sync: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
      } as unknown as fs.promises.FileHandle)
      .mockResolvedValueOnce({
        sync: directorySync,
        close: vi.fn().mockResolvedValue(undefined),
      } as unknown as fs.promises.FileHandle);

    await expect(
      atomicWriteAsync(TARGET_PATH, CONTENT, {
        durability: 'strict',
        syncDirectory: true,
        onDirectorySyncOutcome,
      })
    ).resolves.toBeUndefined();

    expect(directorySync).toHaveBeenCalledTimes(2);
    expect(mockRename).toHaveBeenCalledOnce();
    expect(onDirectorySyncOutcome).toHaveBeenCalledWith('failed-after-publish');
  });

  it('does not let a directory-sync outcome observer misreport a published write', async () => {
    const observerFailure = new Error('directory outcome observer failed');

    await expect(
      atomicWriteAsync(TARGET_PATH, CONTENT, {
        durability: 'strict',
        syncDirectory: true,
        onDirectorySyncOutcome: () => {
          throw observerFailure;
        },
      })
    ).resolves.toBeUndefined();

    expect(mockRename).toHaveBeenCalledOnce();
  });

  it('uses strict file durability with supported Windows directory-sync fallback', async () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const onDirectorySyncOutcome = vi.fn();

    await expect(
      atomicWriteAsync(TARGET_PATH, CONTENT, {
        durability: 'strict',
        syncDirectory: true,
        onDirectorySyncOutcome,
      })
    ).resolves.toBeUndefined();

    expect(mockOpen).toHaveBeenCalledTimes(1);
    expect(mockOpen).toHaveBeenCalledWith(getTmpPath(), 'r+');
    expect(mockRename).toHaveBeenCalledOnce();
    expect(onDirectorySyncOutcome).toHaveBeenCalledWith('unsupported-platform');
    platform.mockRestore();
  });

  it('rejects a strict directory device failure before publish', async () => {
    const failure = Object.assign(new Error('directory device failure'), { code: 'EIO' });
    mockDirectoryFailure('sync', failure);

    await expect(
      atomicWriteAsync(TARGET_PATH, CONTENT, {
        durability: 'strict',
        syncDirectory: true,
      })
    ).rejects.toBe(failure);

    expect(mockRename).not.toHaveBeenCalled();
  });

  it('accepts an explicitly unsupported directory fsync result in strict mode', async () => {
    const fileHandle = {
      sync: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const directoryHandle = {
      sync: vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('unsupported directory sync'), { code: 'EINVAL' })
        ),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const onDirectorySyncOutcome = vi.fn();
    mockOpen
      .mockResolvedValueOnce(fileHandle as unknown as fs.promises.FileHandle)
      .mockResolvedValueOnce(directoryHandle as unknown as fs.promises.FileHandle);

    await expect(
      atomicWriteAsync(TARGET_PATH, CONTENT, {
        durability: 'strict',
        syncDirectory: true,
        onDirectorySyncOutcome,
      })
    ).resolves.toBeUndefined();

    expect(mockRename).toHaveBeenCalledOnce();
    expect(onDirectorySyncOutcome).toHaveBeenCalledWith('unsupported-platform');
  });

  it.each(['open', 'sync', 'close'] as const)(
    'keeps parent-directory %s failure best-effort without strict durability',
    async (stage) => {
      const onDirectorySyncOutcome = vi.fn();
      mockDirectoryFailure(stage, new Error(`directory ${stage} unavailable`));

      await expect(
        atomicWriteAsync(TARGET_PATH, CONTENT, {
          syncDirectory: true,
          onDirectorySyncOutcome,
        })
      ).resolves.toBeUndefined();

      expect(mockRename).toHaveBeenCalledOnce();
      expect(onDirectorySyncOutcome).toHaveBeenCalledWith(
        stage === 'close' ? 'durable' : 'best-effort-unavailable'
      );
    }
  );

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

  it('reports a transient directory-sync failure without renaming a second time', async () => {
    // The rename has already published the data. Repeating it would only find
    // that the source name is gone and report ENOENT for a completed move.
    const syncError = Object.assign(new Error('Directory handle busy'), { code: 'EBUSY' });
    const missingSource = Object.assign(new Error('No such file or directory'), {
      code: 'ENOENT',
    });
    const sourcePath = path.join(TARGET_DIR, 'source');
    const destinationPath = path.join(TARGET_DIR, 'destination');
    mockRename.mockImplementation(() =>
      mockRename.mock.calls.length > 1 ? Promise.reject(missingSource) : Promise.resolve(undefined)
    );
    mockOpen.mockRejectedValue(syncError);

    await expect(
      renamePathWithRetry(sourcePath, destinationPath, {
        syncDirectories: true,
        durability: 'strict',
      })
    ).rejects.toThrow('Directory handle busy');

    expect(mockRename).toHaveBeenCalledTimes(1);
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
  it('returns the exact retained inode pin without a second fallible hardlink step', async () => {
    const result = await atomicCreateAsync(TARGET_PATH, CONTENT, { retainPin: true });

    const pinPath = getTmpPath();
    expect(mockLink).toHaveBeenCalledWith(pinPath, TARGET_PATH);
    expect(mockUnlink).not.toHaveBeenCalledWith(pinPath);
    expect(result).toEqual({
      dev: 1,
      ino: 2,
      birthtimeMs: 3,
      size: CONTENT.length,
      pinPath,
    });
  });

  it('fails before publication when a caller requires trustworthy identity', async () => {
    mockLstat.mockResolvedValueOnce({
      dev: 1,
      ino: 0,
      birthtimeMs: 3,
      size: CONTENT.length,
      nlink: 1,
    } as unknown as Awaited<ReturnType<typeof fs.promises.lstat>>);

    await expect(
      atomicCreateAsync(TARGET_PATH, CONTENT, {
        retainPin: true,
        requireTrustworthyIdentity: true,
      })
    ).rejects.toThrow('Atomic create identity is not trustworthy enough for publication');

    expect(mockLink).not.toHaveBeenCalled();
    expect(mockUnlink).toHaveBeenCalledWith(getTmpPath());
  });

  it('publishes a fully-synced temp file without overwriting an existing target', async () => {
    const result = await atomicCreateAsync(TARGET_PATH, CONTENT);

    const tmpPath = getTmpPath();
    expect(tmpPath).toMatch(/\.review-create\.[a-f0-9-]+\.tmp$/);
    expect(mockLink).toHaveBeenCalledWith(tmpPath, TARGET_PATH);
    expect(mockUnlink).toHaveBeenCalledWith(tmpPath);
    expect(result).toEqual({ dev: 1, ino: 2, birthtimeMs: 3, size: CONTENT.length });
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

    await expect(atomicCreateAsync(TARGET_PATH, CONTENT)).resolves.toEqual({
      dev: 1,
      ino: 2,
      birthtimeMs: 3,
      size: CONTENT.length,
    });

    expect(mockLink).toHaveBeenCalledWith(getTmpPath(), TARGET_PATH);
    expect(mockUnlink).not.toHaveBeenCalledWith(TARGET_PATH);
  });

  it('reports terminal success when directory sync fails after publish', async () => {
    const fileHandle = {
      sync: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as fs.promises.FileHandle;
    const directorySync = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('directory fsync failed after publish'));
    const directoryHandle = {
      sync: directorySync,
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as fs.promises.FileHandle;
    mockOpen.mockResolvedValueOnce(fileHandle).mockResolvedValueOnce(directoryHandle);

    await expect(atomicCreateAsync(TARGET_PATH, CONTENT)).resolves.toEqual({
      dev: 1,
      ino: 2,
      birthtimeMs: 3,
      size: CONTENT.length,
    });

    expect(directorySync).toHaveBeenCalledTimes(2);
    expect(mockLink).toHaveBeenCalledWith(getTmpPath(), TARGET_PATH);
    expect(mockUnlink).not.toHaveBeenCalledWith(TARGET_PATH);
  });

  it('removes only a crash-left owned temp hardlink', async () => {
    const ownedStats = {
      dev: 7,
      ino: 9,
      birthtimeMs: 11,
      size: 13,
      nlink: 2,
      isFile: () => true,
      isSymbolicLink: () => false,
    } as unknown as Awaited<ReturnType<typeof fs.promises.lstat>>;
    const cleanupDirectoryStats = {
      dev: 7,
      ino: 10,
      birthtimeMs: 12,
      isDirectory: () => true,
      isFile: () => false,
      isSymbolicLink: () => false,
    } as unknown as Awaited<ReturnType<typeof fs.promises.lstat>>;
    mockLstat.mockImplementation(async (pathname) =>
      (String(pathname).includes('.review-create-cleanup-') ||
        /^\/proc\/self\/fd\//.test(String(pathname))) &&
      !String(pathname).includes('.atomic-create-cleanup-admission-owner') &&
      !String(pathname).includes('.atomic-create-recovery') &&
      !String(pathname).includes('.atomic-create-retired') &&
      !String(pathname).includes('/owner.json')
        ? cleanupDirectoryStats
        : ownedStats
    );
    directoryEntries(
      [],
      ['.review-create.12345678-1234-1234-1234-123456789abc.tmp', 'user-file.tmp']
    );

    await cleanupAtomicCreateTempLinks(TARGET_PATH);

    // Lease/admission ownership now advances through durable election rather
    // than pathname unlink, leaving only exact detached-record cleanup here.
    expect(mockUnlink).toHaveBeenCalledTimes(2);
    expect(mockUnlink).not.toHaveBeenCalledWith(
      path.join(TARGET_DIR, '.review-create.12345678-1234-1234-1234-123456789abc.tmp')
    );
    expect(mockRmdir).toHaveBeenCalledTimes(2);
  });

  it('reuses one durable retirement name when an EBUSY unlink retries', async () => {
    const directory = '/proc/self/fd/77/.';
    const child = '.review-create.12345678-1234-1234-1234-123456789abc.tmp';
    const identity = { dev: 7, ino: 9, birthtimeMs: 11, size: 13 };
    mockLstat.mockResolvedValue({
      ...identity,
      isFile: () => true,
      isSymbolicLink: () => false,
    } as unknown as Awaited<ReturnType<typeof fs.promises.lstat>>);
    let unlinkAttempts = 0;
    mockUnlink.mockImplementation(async () => {
      unlinkAttempts++;
      if (unlinkAttempts === 1) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    });
    const selectedNames: string[] = [];

    await expect(
      retireOwnedPrivateChild(directory, child, identity, async (name) => {
        selectedNames.push(name);
        return name;
      })
    ).resolves.toBe(true);

    expect(selectedNames).toHaveLength(1);
    expect(mockRename).toHaveBeenCalledWith(
      path.join(directory, child),
      path.join(directory, selectedNames[0]!)
    );
    expect(new Set(mockUnlink.mock.calls.map(([pathname]) => String(pathname)))).toEqual(
      new Set([path.join(directory, selectedNames[0]!)])
    );
  });

  it('uses a retirement claim rather than revalidating a mutable pathname before retrying', async () => {
    const directory = '/proc/self/fd/77/.';
    const file = { dev: 7, ino: 9, birthtimeMs: 11, size: 13 };
    const ownedFileStats = {
      ...file,
      isFile: () => true,
      isSymbolicLink: () => false,
    } as unknown as Awaited<ReturnType<typeof fs.promises.lstat>>;
    const timeout = vi.spyOn(global, 'setTimeout').mockImplementation((callback) => {
      queueMicrotask(callback as () => void);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });
    try {
      mockLstat.mockResolvedValue(ownedFileStats);
      mockUnlink.mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'EBUSY' }));
      await expect(retireOwnedPrivateChild(directory, 'owned', file)).resolves.toBe(true);
      expect(mockUnlink).toHaveBeenCalledTimes(2);

      const ownedDirectory = {
        dev: 7,
        ino: 11,
        birthtimeMs: 12,
        isDirectory: () => true,
        isSymbolicLink: () => false,
      } as unknown as Awaited<ReturnType<typeof fs.promises.lstat>>;
      mockLstat.mockResolvedValue(ownedDirectory);
      mockRmdir.mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'EBUSY' }));
      await expect(
        retireOwnedPrivateDirectory(directory, 'owned-directory', {
          dev: 7,
          ino: 11,
          birthtimeMs: 12,
        })
      ).resolves.toBe(true);
      expect(mockRmdir).toHaveBeenCalledTimes(2);
    } finally {
      timeout.mockRestore();
    }
  });

  it('fails closed when replacement occurs immediately before and between exact-release retries', async () => {
    const directory = '/proc/self/fd/77/.';
    const file = { dev: 7, ino: 9, birthtimeMs: 11, size: 13 };
    const retiredFile = path.join(
      directory,
      '.atomic-create-retired-12345678-1234-1234-1234-123456789abc'
    );
    const retiredDirectory = path.join(
      directory,
      '.review-create-cleanup-retired-12345678-1234-1234-1234-123456789abc'
    );
    const fileStats = {
      ...file,
      isFile: () => true,
      isSymbolicLink: () => false,
    } as unknown as Awaited<ReturnType<typeof fs.promises.lstat>>;
    const directoryIdentity = { dev: 7, ino: 11, birthtimeMs: 12 };
    const directoryStats = {
      ...directoryIdentity,
      isDirectory: () => true,
      isSymbolicLink: () => false,
    } as unknown as Awaited<ReturnType<typeof fs.promises.lstat>>;
    const replacementTargets: string[] = [];
    let unlinkAttempts = 0;
    let rmdirAttempts = 0;
    mockLstat.mockImplementation(async (pathname) => {
      if (String(pathname) === retiredFile) return fileStats;
      if (String(pathname) === retiredDirectory) return directoryStats;
      return fileStats;
    });
    exactGenerationMockOperations().unlinkExactGeneration = async (pathname, identity) => {
      unlinkAttempts++;
      replacementTargets.push(String(pathname));
      expect(identity).toEqual(file);
      if (unlinkAttempts === 1) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      // The platform primitive sees the replacement at the destructive
      // boundary and refuses it; a raw unlink would have deleted it instead.
      throw Object.assign(new Error('replacement'), { code: 'ENOENT' });
    };
    exactGenerationMockOperations().rmdirExactGeneration = async (pathname, identity) => {
      rmdirAttempts++;
      replacementTargets.push(String(pathname));
      expect(identity).toEqual(directoryIdentity);
      if (rmdirAttempts === 1) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      throw Object.assign(new Error('replacement'), { code: 'ENOTEMPTY' });
    };
    const timeout = vi.spyOn(global, 'setTimeout').mockImplementation((callback) => {
      queueMicrotask(callback as () => void);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });
    try {
      await expect(
        retireOwnedPrivateChild(directory, path.basename(retiredFile), file)
      ).resolves.toBe(false);
      await expect(
        retireOwnedPrivateDirectory(directory, path.basename(retiredDirectory), directoryIdentity)
      ).resolves.toBe(false);
    } finally {
      timeout.mockRestore();
    }

    // path.join normalizes the descriptor-root '/.' alias. Both retries are
    // bound to the identity passed to the primitive, and no raw pathname
    // destructive syscall can reach the replacement.
    expect(replacementTargets).toEqual([
      retiredFile,
      retiredFile,
      retiredDirectory,
      retiredDirectory,
    ]);
    expect(unlinkAttempts).toBe(2);
    expect(rmdirAttempts).toBe(2);
    expect(mockUnlink).not.toHaveBeenCalled();
    expect(mockRmdir).not.toHaveBeenCalled();
  });

  it('retains authenticated private releases when exact-generation capabilities are absent', async () => {
    const directory = '/proc/self/fd/77/.';
    const fileIdentity = { dev: 7, ino: 9, birthtimeMs: 11, size: 13 };
    const directoryIdentity = { dev: 7, ino: 10, birthtimeMs: 12 };
    mockLstat.mockImplementation(
      async (pathname) =>
        ({
          ...(String(pathname).includes('directory') ? directoryIdentity : fileIdentity),
          isFile: () => !String(pathname).includes('directory'),
          isDirectory: () => String(pathname).includes('directory'),
          isSymbolicLink: () => false,
        }) as unknown as Awaited<ReturnType<typeof fs.promises.lstat>>
    );
    delete exactGenerationMockOperations().unlinkExactGeneration;
    delete exactGenerationMockOperations().rmdirExactGeneration;

    await expect(retireOwnedPrivateChild(directory, 'owned', fileIdentity)).resolves.toBe(false);
    await expect(
      retireOwnedPrivateDirectory(directory, 'owned-directory', directoryIdentity)
    ).resolves.toBe(false);

    expect(mockUnlink).not.toHaveBeenCalled();
    expect(mockRmdir).not.toHaveBeenCalled();
  });

  it('retains a staged recovery authority after complete 20x20 EBUSY exhaustion', async () => {
    const guardName = '.review-create.12345678-1234-1234-1234-123456789abc.tmp';
    const identity = { dev: 7, ino: 9, birthtimeMs: 11, size: 13, nlink: 2 };
    const directoryStats = {
      dev: 7,
      ino: 10,
      birthtimeMs: 12,
      isDirectory: () => true,
      isSymbolicLink: () => false,
    } as unknown as Awaited<ReturnType<typeof fs.promises.lstat>>;
    const fileStats = {
      ...identity,
      isFile: () => true,
      isSymbolicLink: () => false,
    } as unknown as Awaited<ReturnType<typeof fs.promises.lstat>>;
    let retiredAttachmentPresent = false;
    let retiredName: string | undefined;
    directoryEntries([], [guardName]);
    mockLstat.mockImplementation(async (pathname) => {
      const name = String(pathname);
      if (name.includes('.atomic-create-recovery')) return fileStats;
      if (retiredName !== undefined && name.endsWith(retiredName)) {
        if (retiredAttachmentPresent) return fileStats;
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      }
      if (retiredName !== undefined && name.endsWith(guardName)) {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      }
      // path.join('/proc/self/fd/<n>/.', child) normalizes away the trailing
      // dot, so match the descriptor-root alias the production code actually
      // passes to lstat rather than an unobservable '/.' spelling.
      if (/^\/proc\/self\/fd\/[^/]+\/?$/.test(name)) return directoryStats;
      if (name.includes('.review-create-cleanup-') && !name.includes('.atomic-create-retired-')) {
        return directoryStats;
      }
      return fileStats;
    });
    mockOpen.mockImplementation(
      async (pathname) =>
        ({
          sync: vi.fn().mockResolvedValue(undefined),
          close: vi.fn().mockResolvedValue(undefined),
          stat: vi
            .fn()
            .mockResolvedValue(
              String(pathname).includes('.atomic-create-recovery') ||
                String(pathname).includes('directory-retirement')
                ? fileStats
                : directoryStats
            ),
          read: vi.fn(async (buffer: Buffer) => {
            const contents = mockFileContents.get(String(pathname)) ?? '';
            buffer.write(contents, 'utf8');
            return { bytesRead: Buffer.byteLength(contents), buffer };
          }),
        }) as unknown as fs.promises.FileHandle
    );
    mockWriteFile.mockImplementation(async (pathname, data) => {
      const name = String(pathname);
      if (name.includes('.atomic-create-recovery.pending.json') && mockFileContents.has(name)) {
        throw Object.assign(new Error('already staged'), { code: 'EEXIST' });
      }
      mockFileContents.set(name, String(data));
    });
    mockRename.mockImplementation(async (source, destination) => {
      const name = String(destination);
      // Recovery-record retirement has the same generated-name prefix. Match
      // only the guard move, and do not use endsWith('') before the first
      // destination has actually been observed.
      if (String(source).endsWith(guardName) && name.includes('.atomic-create-retired-')) {
        if (retiredName !== undefined)
          throw Object.assign(new Error('already moved'), { code: 'ENOENT' });
        retiredName = path.basename(name);
        retiredAttachmentPresent = true;
        return;
      }
      const content = mockFileContents.get(String(source));
      if (content !== undefined) {
        mockFileContents.delete(String(source));
        mockFileContents.set(name, content);
      }
    });
    let exhaust = true;
    let detachedUnlinkAttempts = 0;
    mockUnlink.mockImplementation(async (pathname) => {
      if (retiredName !== undefined && String(pathname).endsWith(retiredName)) {
        detachedUnlinkAttempts++;
        if (exhaust) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
        retiredAttachmentPresent = false;
      }
      mockFileContents.delete(String(pathname));
    });
    const timeout = vi.spyOn(global, 'setTimeout').mockImplementation((callback) => {
      queueMicrotask(callback as () => void);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });
    try {
      await expect(cleanupAtomicCreateTempLinks(TARGET_PATH)).rejects.toMatchObject({
        code: 'EBUSY',
      });
    } finally {
      timeout.mockRestore();
    }

    // releaseDetachedLink retries its complete authenticated transaction and
    // retireOwnedPrivateChild retries each unlink, so full exhaustion is
    // bounded at 20 x 20 attempts. The staged pending record remains the
    // scanner-visible authority for a later invocation to resume.
    expect(detachedUnlinkAttempts).toBe(400);
    expect(retiredName).toBeDefined();
    expect(mockWriteFile).toHaveBeenCalledWith(
      expect.stringContaining('.atomic-create-recovery.pending.json'),
      expect.any(String),
      { encoding: 'utf8', flag: 'wx', mode: 0o600 }
    );
    expect(
      mockRename.mock.calls.filter(
        ([, destination]) => retiredName !== undefined && String(destination).endsWith(retiredName)
      )
    ).toHaveLength(1);

    // A later cleanup scans the staged pending record, finds its exact
    // retired attachment, and resumes deletion without relying on the now
    // missing original guard name.
    exhaust = false;
    const cleanupName = `${path.basename(String(mockMkdtemp.mock.calls[0]?.[0]))}cleanup-test`;
    directoryEntries([cleanupName], []);
    await expect(cleanupAtomicCreateTempLinks(TARGET_PATH)).resolves.toBeUndefined();
    expect(detachedUnlinkAttempts).toBe(401);
  });

  it("keeps B behind A's live admission owner while A is paused at 63", async () => {
    const directory = '/proc/self/fd/77/.';
    const admissionOwner = path.join(directory, '.atomic-create-cleanup-admission-owner.json');
    const owners = new Map<string, string>();
    let releaseFirstCount: (() => void) | undefined;
    const firstCountStarted = new Promise<void>((resolve) => {
      releaseFirstCount = resolve;
    });
    let firstCountEntered: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      firstCountEntered = resolve;
    });
    let secondObservedLiveOwner: (() => void) | undefined;
    const liveOwnerObserved = new Promise<void>((resolve) => {
      secondObservedLiveOwner = resolve;
    });
    let lockAcquisitions = 0;
    mockReadFile.mockImplementation(async (pathname) => {
      if (String(pathname) !== admissionOwner) return '';
      const owner = owners.get(admissionOwner);
      if (owner === undefined) throw missing();
      if (lockAcquisitions >= 2) secondObservedLiveOwner?.();
      return owner;
    });
    mockWriteFile.mockImplementation(async (pathname, data) => {
      const name = String(pathname);
      if (owners.has(name)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      owners.set(name, String(data));
    });
    mockLink.mockImplementation(async (source, destination) => {
      const owner = owners.get(String(source));
      if (owner === undefined) throw missing();
      if (owners.has(String(destination)))
        throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      owners.set(String(destination), owner);
    });
    mockRename.mockImplementation(async (source, destination) => {
      const owner = owners.get(String(source));
      if (owner === undefined) throw missing();
      owners.delete(String(source));
      owners.set(String(destination), owner);
    });
    mockUnlink.mockImplementation(async (pathname) => {
      if (String(pathname) === admissionOwner) owners.delete(admissionOwner);
    });
    vi.mocked(lockfile.lock).mockImplementation(async () => {
      lockAcquisitions++;
      return async () => undefined;
    });
    let countCalls = 0;
    const countExisting = async (): Promise<number> => {
      countCalls++;
      if (countCalls === 1) {
        firstCountEntered?.();
        await firstCountStarted;
        return 63;
      }
      return 64;
    };

    const first = allocateAtomicCreateRecoveryDirectory(
      directory,
      `${directory}/.review-create-cleanup-a-`,
      countExisting
    );
    await entered;
    const second = allocateAtomicCreateRecoveryDirectory(
      directory,
      `${directory}/.review-create-cleanup-b-`,
      countExisting
    );
    await liveOwnerObserved;
    expect(countCalls).toBe(1);
    expect(mockMkdtemp).not.toHaveBeenCalled();

    releaseFirstCount?.();
    await expect(first).resolves.toContain('.review-create-cleanup-a-');
    await expect(second).rejects.toThrow('recovery authority capacity (64) exhausted');
    expect(countCalls).toBe(2);
    expect(mockMkdtemp).toHaveBeenCalledTimes(1);
  });

  it("retains admission from mkdtemp through A's exact recovery-directory capture", async () => {
    const directory = '/proc/self/fd/77/.';
    const admissionOwner = path.join(directory, '.atomic-create-cleanup-admission-owner.json');
    const aDirectory = path.join(directory, '.review-create-cleanup-a-63');
    const owners = new Map<string, string>();
    const aIdentity = { dev: 7, ino: 201, birthtimeMs: 11 };
    let releaseCapture: (() => void) | undefined;
    const captureMayContinue = new Promise<void>((resolve) => {
      releaseCapture = resolve;
    });
    let captureEntered: (() => void) | undefined;
    const aPausedAfterMkdtemp = new Promise<void>((resolve) => {
      captureEntered = resolve;
    });
    let bObservedLiveOwner: (() => void) | undefined;
    const bBlockedByAdmission = new Promise<void>((resolve) => {
      bObservedLiveOwner = resolve;
    });
    let lockAcquisitions = 0;
    mockReadFile.mockImplementation(async (pathname) => {
      if (String(pathname) !== admissionOwner) return '';
      const owner = owners.get(admissionOwner);
      if (owner === undefined) throw missing();
      if (lockAcquisitions >= 2) bObservedLiveOwner?.();
      return owner;
    });
    mockWriteFile.mockImplementation(async (pathname, data) => {
      const name = String(pathname);
      if (owners.has(name)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      owners.set(name, String(data));
    });
    mockLink.mockImplementation(async (source, destination) => {
      const owner = owners.get(String(source));
      if (owner === undefined) throw missing();
      if (owners.has(String(destination)))
        throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      owners.set(String(destination), owner);
    });
    mockRename.mockImplementation(async (source, destination) => {
      const owner = owners.get(String(source));
      if (owner === undefined) throw missing();
      owners.delete(String(source));
      owners.set(String(destination), owner);
    });
    mockUnlink.mockImplementation(async (pathname) => {
      if (String(pathname) === admissionOwner) owners.delete(admissionOwner);
    });
    mockLstat.mockImplementation(async (pathname) => {
      if (String(pathname) === admissionOwner) {
        const owner = owners.get(admissionOwner);
        if (owner === undefined) throw missing();
        return {
          dev: 7,
          ino: 101,
          birthtimeMs: 11,
          size: owner.length,
          isFile: () => true,
          isDirectory: () => false,
          isSymbolicLink: () => false,
        } as unknown as Awaited<ReturnType<typeof fs.promises.lstat>>;
      }
      if (String(pathname) === aDirectory) {
        // This is deliberately after mkdtemp has returned, but before its
        // first identity observation. B must not be able to publish an owner
        // or substitute this pathname during that asynchronous pause.
        captureEntered?.();
        await captureMayContinue;
        return {
          ...aIdentity,
          size: 0,
          isFile: () => false,
          isDirectory: () => true,
          isSymbolicLink: () => false,
        } as unknown as Awaited<ReturnType<typeof fs.promises.lstat>>;
      }
      return {
        dev: 7,
        ino: 12,
        birthtimeMs: 11,
        size: 0,
        isFile: () => false,
        isDirectory: () => true,
        isSymbolicLink: () => false,
      } as unknown as Awaited<ReturnType<typeof fs.promises.lstat>>;
    });
    mockMkdtemp.mockImplementation(async (prefix) => {
      if (String(prefix).includes('.review-create-cleanup-a-')) return aDirectory;
      throw new Error('B must not mutate while A is capturing its generation');
    });
    mockOpen.mockImplementation(
      async (pathname) =>
        ({
          fd: 77,
          sync: vi.fn().mockResolvedValue(undefined),
          close: vi.fn().mockResolvedValue(undefined),
          stat: vi.fn(async () => {
            if (String(pathname) === aDirectory) {
              // Recovery authority capture is descriptor based. Pause that
              // descriptor observation, not a mutable pathname lstat.
              captureEntered?.();
              await captureMayContinue;
              return {
                ...aIdentity,
                isFile: () => false,
                isDirectory: () => true,
                isSymbolicLink: () => false,
              } as unknown as fs.Stats;
            }
            return {
              dev: 7,
              ino: 12,
              birthtimeMs: 11,
              isFile: () => false,
              isDirectory: () => true,
              isSymbolicLink: () => false,
            } as unknown as fs.Stats;
          }),
        }) as unknown as fs.promises.FileHandle
    );
    vi.mocked(lockfile.lock).mockImplementation(async () => {
      lockAcquisitions++;
      return async () => undefined;
    });
    let countCalls = 0;
    const countExisting = async (): Promise<number> => {
      countCalls++;
      return countCalls === 1 ? 63 : 64;
    };

    const allocationA = allocateAtomicCreateRecoveryDirectory(
      directory,
      `${directory}/.review-create-cleanup-a-`,
      countExisting
    );
    await aPausedAfterMkdtemp;
    const allocationB = allocateAtomicCreateRecoveryDirectory(
      directory,
      `${directory}/.review-create-cleanup-b-`,
      countExisting
    );
    await bBlockedByAdmission;

    // B has tried to admit while A is between mkdtemp and lstat, but A's
    // still-live fence prevents B from scanning capacity, publishing an owner,
    // or replacing the pathname that A is about to authenticate.
    expect(countCalls).toBe(1);
    expect(mockMkdtemp).toHaveBeenCalledTimes(1);
    // Publication retains the private hardlink as the authenticated pin, so
    // the active public record has one private alias while A is paused.
    expect(owners.has(admissionOwner)).toBe(true);

    releaseCapture?.();
    await expect(allocationA).resolves.toBe(aDirectory);
    await expect(allocationB).rejects.toThrow('recovery authority capacity (64) exhausted');
    expect(mockMkdtemp).toHaveBeenCalledTimes(1);
  });

  it("does not capture or roll back B when admission and the pathname change during A's first capture", async () => {
    const directory = '/proc/self/fd/77/.';
    const admissionOwner = path.join(directory, '.atomic-create-cleanup-admission-owner.json');
    const aDirectory = path.join(directory, '.review-create-cleanup-a-63');
    const aIdentity = { dev: 7, ino: 201, birthtimeMs: 11 };
    const bIdentity = { dev: 7, ino: 202, birthtimeMs: 11 };
    const owners = new Map<
      string,
      { raw: string; identity: { dev: number; ino: number; birthtimeMs: number; size: number } }
    >();
    const recoveryDirectories = new Map<string, typeof aIdentity>();
    let nextOwnerInode = 100;
    let replaceDuringCapture = false;
    const successorRaw = JSON.stringify({
      version: 1,
      fence: 'abcdefab-cdef-cdef-cdef-abcdefabcdef',
      pid: process.pid,
      incarnation: null,
    });

    mockReadFile.mockImplementation(async (pathname) => {
      const owner = owners.get(String(pathname));
      if (!owner) throw missing();
      return owner.raw;
    });
    mockWriteFile.mockImplementation(async (pathname, data) => {
      const name = String(pathname);
      if (owners.has(name)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      const raw = String(data);
      owners.set(name, {
        raw,
        identity: { dev: 7, ino: nextOwnerInode++, birthtimeMs: 11, size: raw.length },
      });
    });
    mockLink.mockImplementation(async (source, destination) => {
      const owner = owners.get(String(source));
      if (!owner) throw missing();
      if (owners.has(String(destination)))
        throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      owners.set(String(destination), owner);
    });
    mockRename.mockImplementation(async (source, destination) => {
      const owner = owners.get(String(source));
      if (!owner) throw missing();
      owners.delete(String(source));
      owners.set(String(destination), owner);
    });
    mockLstat.mockImplementation(async (pathname) => {
      const pathnameString = String(pathname);
      if (pathnameString === aDirectory && replaceDuringCapture) {
        // A gets past its pre-capture fence, then a stale admission callback
        // replaces both names before lstat resolves. The returned identity is
        // B's and must never become A's rollback authority.
        recoveryDirectories.set(aDirectory, bIdentity);
        owners.set(admissionOwner, {
          raw: successorRaw,
          identity: { dev: 7, ino: nextOwnerInode++, birthtimeMs: 11, size: successorRaw.length },
        });
        replaceDuringCapture = false;
      }
      const owner = owners.get(pathnameString);
      if (owner)
        return {
          ...owner.identity,
          isFile: () => true,
          isDirectory: () => false,
          isSymbolicLink: () => false,
        } as unknown as Awaited<ReturnType<typeof fs.promises.lstat>>;
      const recoveryDirectory = recoveryDirectories.get(pathnameString);
      if (recoveryDirectory)
        return {
          ...recoveryDirectory,
          size: 0,
          isFile: () => false,
          isDirectory: () => true,
          isSymbolicLink: () => false,
        } as unknown as Awaited<ReturnType<typeof fs.promises.lstat>>;
      return {
        dev: 7,
        ino: 12,
        birthtimeMs: 11,
        size: 0,
        isFile: () => false,
        isDirectory: () => true,
        isSymbolicLink: () => false,
      } as unknown as Awaited<ReturnType<typeof fs.promises.lstat>>;
    });
    mockMkdtemp.mockImplementation(async () => {
      recoveryDirectories.set(aDirectory, aIdentity);
      replaceDuringCapture = true;
      return aDirectory;
    });
    mockOpen.mockImplementation(
      async (pathname) =>
        ({
          fd: 77,
          sync: vi.fn().mockResolvedValue(undefined),
          close: vi.fn().mockResolvedValue(undefined),
          stat: vi.fn(async () => {
            if (String(pathname) === aDirectory && replaceDuringCapture) {
              recoveryDirectories.set(aDirectory, bIdentity);
              owners.set(admissionOwner, {
                raw: successorRaw,
                identity: {
                  dev: 7,
                  ino: nextOwnerInode++,
                  birthtimeMs: 11,
                  size: successorRaw.length,
                },
              });
              replaceDuringCapture = false;
            }
            const identity = recoveryDirectories.get(String(pathname)) ?? aIdentity;
            return {
              ...identity,
              isFile: () => false,
              isDirectory: () => true,
              isSymbolicLink: () => false,
            } as unknown as fs.Stats;
          }),
        }) as unknown as fs.promises.FileHandle
    );
    const exactRollbacks: Array<{ pathname: string; identity: unknown }> = [];
    exactGenerationMockOperations().rmdirExactGeneration = async (pathname, identity) => {
      exactRollbacks.push({ pathname: String(pathname), identity });
      const current = recoveryDirectories.get(String(pathname));
      if (!current || !hasExactMockIdentity(current, identity, false)) throw missing();
      recoveryDirectories.delete(String(pathname));
    };

    await expect(
      allocateAtomicCreateRecoveryDirectory(
        directory,
        `${directory}/.review-create-cleanup-a-`,
        async () => 63
      )
    ).rejects.toThrow('Atomic-create cleanup admission fence was lost');

    expect(exactRollbacks).toEqual([]);
    expect(recoveryDirectories.get(aDirectory)).toEqual(bIdentity);
    expect(owners.get(admissionOwner)?.raw).toBe(successorRaw);
  });

  it('does not capture or roll back an untrusted pathname after admission deletion before capture', async () => {
    const directory = '/proc/self/fd/77/.';
    const admissionOwner = path.join(directory, '.atomic-create-cleanup-admission-owner.json');
    const aDirectory = path.join(directory, '.review-create-cleanup-a-63');
    const owners = new Map<string, string>();
    let captureAttempts = 0;
    const exactRollbacks: Array<{ pathname: string; identity: unknown }> = [];

    mockReadFile.mockImplementation(async (pathname) => {
      const owner = owners.get(String(pathname));
      if (owner === undefined) throw missing();
      return owner;
    });
    mockWriteFile.mockImplementation(async (pathname, data) => {
      owners.set(String(pathname), String(data));
    });
    mockLink.mockImplementation(async (source, destination) => {
      const owner = owners.get(String(source));
      if (owner === undefined) throw missing();
      if (owners.has(String(destination)))
        throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      owners.set(String(destination), owner);
    });
    mockRename.mockImplementation(async (source, destination) => {
      const owner = owners.get(String(source));
      if (owner === undefined) throw missing();
      owners.delete(String(source));
      owners.set(String(destination), owner);
    });
    mockLstat.mockImplementation(async (pathname) => {
      if (String(pathname) === admissionOwner) {
        const owner = owners.get(admissionOwner);
        if (owner === undefined) throw missing();
        return {
          dev: 7,
          ino: 101,
          birthtimeMs: 11,
          size: owner.length,
          isFile: () => true,
          isDirectory: () => false,
          isSymbolicLink: () => false,
        } as unknown as Awaited<ReturnType<typeof fs.promises.lstat>>;
      }
      if (String(pathname) === aDirectory) captureAttempts++;
      return {
        dev: 7,
        ino: 201,
        birthtimeMs: 11,
        size: 0,
        isFile: () => false,
        isDirectory: () => true,
        isSymbolicLink: () => false,
      } as unknown as Awaited<ReturnType<typeof fs.promises.lstat>>;
    });
    mockMkdtemp.mockImplementation(async () => {
      // An admission loss after mkdir but before the first pathname lstat
      // makes that lstat untrustworthy. It must not become a rollback token.
      owners.delete(admissionOwner);
      return aDirectory;
    });
    exactGenerationMockOperations().rmdirExactGeneration = async (pathname, identity) => {
      exactRollbacks.push({ pathname: String(pathname), identity });
    };

    await expect(
      allocateAtomicCreateRecoveryDirectory(
        directory,
        `${directory}/.review-create-cleanup-a-`,
        async () => 63
      )
    ).rejects.toThrow('Atomic-create cleanup admission fence was lost');

    expect(captureAttempts).toBe(0);
    expect(exactRollbacks).toEqual([]);
  });

  it('retains A for crash recovery when B owns admission before A can authenticate its generation', async () => {
    const directory = '/proc/self/fd/77/.';
    const admissionOwner = path.join(directory, '.atomic-create-cleanup-admission-owner.json');
    const aDirectory = path.join(directory, '.review-create-cleanup-a-65');
    const bDirectory = path.join(directory, '.review-create-cleanup-b-64');
    const owners = new Map<
      string,
      { raw: string; identity: { dev: number; ino: number; birthtimeMs: number; size: number } }
    >();
    const recoveryDirectories = new Map<
      string,
      { dev: number; ino: number; birthtimeMs: number }
    >();
    let nextInode = 100;
    let releaseA: (() => void) | undefined;
    const aMayCreate = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let aMkdtempEntered: (() => void) | undefined;
    const aAtMkdtemp = new Promise<void>((resolve) => {
      aMkdtempEntered = resolve;
    });
    mockReadFile.mockImplementation(async (pathname) => {
      const owner = owners.get(String(pathname));
      if (owner === undefined) throw missing();
      return owner.raw;
    });
    mockWriteFile.mockImplementation(async (pathname, data) => {
      const name = String(pathname);
      if (owners.has(name)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      const raw = String(data);
      owners.set(name, {
        raw,
        identity: { dev: 7, ino: nextInode++, birthtimeMs: 11, size: raw.length },
      });
    });
    mockUnlink.mockImplementation(async (pathname) => {
      if (String(pathname) === admissionOwner) owners.delete(admissionOwner);
    });
    mockLink.mockImplementation(async (source, destination) => {
      const owner = owners.get(String(source));
      if (!owner) throw missing();
      if (owners.has(String(destination)))
        throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      owners.set(String(destination), owner);
    });
    mockRename.mockImplementation(async (source, destination) => {
      const owner = owners.get(String(source));
      if (!owner) throw missing();
      owners.delete(String(source));
      owners.set(String(destination), owner);
    });
    mockLstat.mockImplementation(async (pathname) => {
      const owner = owners.get(String(pathname));
      if (owner)
        return {
          ...owner.identity,
          isFile: () => true,
          isDirectory: () => false,
          isSymbolicLink: () => false,
        } as unknown as Awaited<ReturnType<typeof fs.promises.lstat>>;
      if (String(pathname) === admissionOwner) throw missing();
      const recoveryDirectory = recoveryDirectories.get(String(pathname));
      if (recoveryDirectory)
        return {
          ...recoveryDirectory,
          size: 0,
          isFile: () => false,
          isDirectory: () => true,
          isSymbolicLink: () => false,
        } as unknown as Awaited<ReturnType<typeof fs.promises.lstat>>;
      return {
        dev: 7,
        ino: 12,
        birthtimeMs: 11,
        size: 0,
        isFile: () => false,
        isDirectory: () => true,
        isSymbolicLink: () => false,
      } as unknown as Awaited<ReturnType<typeof fs.promises.lstat>>;
    });
    exactGenerationMockOperations().unlinkExactGeneration = async (pathname, identity) => {
      const owner = owners.get(String(pathname));
      if (!owner || !hasExactMockIdentity(owner.identity, identity, true)) throw missing();
      owners.delete(String(pathname));
    };
    const releasedDirectories: string[] = [];
    exactGenerationMockOperations().rmdirExactGeneration = async (pathname, identity) => {
      const recoveryDirectory = recoveryDirectories.get(String(pathname));
      if (!recoveryDirectory || !hasExactMockIdentity(recoveryDirectory, identity, false))
        throw missing();
      releasedDirectories.push(String(pathname));
      recoveryDirectories.delete(String(pathname));
    };
    mockMkdtemp.mockImplementation(async (prefix) => {
      if (String(prefix).includes('.review-create-cleanup-a-')) {
        aMkdtempEntered?.();
        await aMayCreate;
        recoveryDirectories.set(aDirectory, { dev: 7, ino: 201, birthtimeMs: 11 });
        return aDirectory;
      }
      recoveryDirectories.set(bDirectory, { dev: 7, ino: 200, birthtimeMs: 11 });
      return bDirectory;
    });
    let countCalls = 0;
    const countExisting = async (): Promise<number> => {
      countCalls++;
      return 63;
    };

    const allocationA = allocateAtomicCreateRecoveryDirectory(
      directory,
      `${directory}/.review-create-cleanup-a-`,
      countExisting
    );
    await aAtMkdtemp;
    // Model the stale-lock takeover that B must never make A's stale callback
    // survive. B really allocates slot 64 while A is paused before its own
    // mkdtemp completion. A cannot authenticate a pathname after its
    // admission has gone, so it must retain that bounded orphan instead of
    // risking a rollback of B's successor.
    const kill = vi.spyOn(process, 'kill').mockImplementation((() => {
      throw Object.assign(new Error('dead'), { code: 'ESRCH' });
    }) as typeof process.kill);
    try {
      await expect(
        allocateAtomicCreateRecoveryDirectory(
          directory,
          `${directory}/.review-create-cleanup-b-`,
          countExisting
        )
      ).resolves.toBe(bDirectory);
    } finally {
      kill.mockRestore();
    }
    releaseA?.();
    await expect(allocationA).rejects.toThrow('Atomic-create cleanup admission fence was lost');
    expect(countCalls).toBe(2);
    expect(mockMkdtemp).toHaveBeenCalledTimes(2);
    expect(releasedDirectories).toEqual([]);
    expect(recoveryDirectories.has(aDirectory)).toBe(true);
    expect(recoveryDirectories.has(bDirectory)).toBe(true);
  });

  it('never re-authorizes a successor that replaces A after A captured its recovery directory', async () => {
    const directory = '/proc/self/fd/77/.';
    const admissionOwner = path.join(directory, '.atomic-create-cleanup-admission-owner.json');
    const aDirectory = path.join(directory, '.review-create-cleanup-a-65');
    const aIdentity = { dev: 7, ino: 201, birthtimeMs: 11 };
    const successorIdentity = { dev: 7, ino: 202, birthtimeMs: 11 };
    const owners = new Map<string, string>();
    const recoveryDirectories = new Map<string, typeof aIdentity>();
    let releaseA: (() => void) | undefined;
    const aMayCreate = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    let aMkdtempEntered: (() => void) | undefined;
    const aAtMkdtemp = new Promise<void>((resolve) => {
      aMkdtempEntered = resolve;
    });
    let replaceDirectoryAtPostMutationFence = false;
    let capturedA = false;
    let ownerReadsAfterCapture = 0;
    const successorOwner = JSON.stringify({
      version: 1,
      fence: 'abcdefab-cdef-cdef-cdef-abcdefabcdef',
      pid: process.pid,
      incarnation: null,
    });
    mockReadFile.mockImplementation(async (pathname) => {
      const pathnameString = String(pathname);
      if (pathnameString === admissionOwner && capturedA && replaceDirectoryAtPostMutationFence) {
        ownerReadsAfterCapture++;
        if (ownerReadsAfterCapture === 2) {
          // The first read after capture authenticates A. The successor wins
          // only at A's later post-mutation fence, so A's immutable identity
          // remains eligible for exact rollback while B stays protected.
          recoveryDirectories.set(aDirectory, successorIdentity);
          owners.set(admissionOwner, successorOwner);
          replaceDirectoryAtPostMutationFence = false;
        }
      }
      const owner = owners.get(pathnameString);
      if (owner === undefined) throw missing();
      return owner;
    });
    mockWriteFile.mockImplementation(async (pathname, data) => {
      const name = String(pathname);
      if (owners.has(name)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      owners.set(name, String(data));
    });
    mockLink.mockImplementation(async (source, destination) => {
      const owner = owners.get(String(source));
      if (owner === undefined) throw missing();
      if (owners.has(String(destination)))
        throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      owners.set(String(destination), owner);
    });
    mockRename.mockImplementation(async (source, destination) => {
      const owner = owners.get(String(source));
      if (owner === undefined) throw missing();
      owners.delete(String(source));
      owners.set(String(destination), owner);
    });
    mockLstat.mockImplementation(async (pathname) => {
      if (String(pathname) === admissionOwner) {
        const owner = owners.get(admissionOwner);
        if (owner === undefined) throw missing();
        return {
          dev: 7,
          ino: owner === successorOwner ? 102 : 101,
          birthtimeMs: 11,
          size: owner.length,
          isFile: () => true,
          isDirectory: () => false,
          isSymbolicLink: () => false,
        } as unknown as Awaited<ReturnType<typeof fs.promises.lstat>>;
      }
      const recoveryDirectory = recoveryDirectories.get(String(pathname));
      if (String(pathname) === aDirectory && recoveryDirectory === aIdentity) capturedA = true;
      if (recoveryDirectory)
        return {
          ...recoveryDirectory,
          size: 0,
          isFile: () => false,
          isDirectory: () => true,
          isSymbolicLink: () => false,
        } as unknown as Awaited<ReturnType<typeof fs.promises.lstat>>;
      return {
        dev: 7,
        ino: 12,
        birthtimeMs: 11,
        size: 0,
        isFile: () => false,
        isDirectory: () => true,
        isSymbolicLink: () => false,
      } as unknown as Awaited<ReturnType<typeof fs.promises.lstat>>;
    });
    mockMkdtemp.mockImplementation(async () => {
      aMkdtempEntered?.();
      await aMayCreate;
      recoveryDirectories.set(aDirectory, aIdentity);
      return aDirectory;
    });
    mockOpen.mockImplementation(
      async (pathname) =>
        ({
          fd: 77,
          sync: vi.fn().mockResolvedValue(undefined),
          close: vi.fn().mockResolvedValue(undefined),
          stat: vi.fn().mockImplementation(async () => {
            if (String(pathname) === aDirectory) capturedA = true;
            const identity = recoveryDirectories.get(String(pathname)) ?? aIdentity;
            return {
              ...identity,
              isDirectory: () => true,
              isFile: () => false,
            } as unknown as fs.Stats;
          }),
        }) as unknown as fs.promises.FileHandle
    );
    const exactAttempts: Array<{ pathname: string; identity: unknown }> = [];
    exactGenerationMockOperations().rmdirExactGeneration = async (pathname, identity) => {
      exactAttempts.push({ pathname: String(pathname), identity });
      const recoveryDirectory = recoveryDirectories.get(String(pathname));
      if (!recoveryDirectory || !hasExactMockIdentity(recoveryDirectory, identity, false))
        throw missing();
      recoveryDirectories.delete(String(pathname));
    };

    const allocation = allocateAtomicCreateRecoveryDirectory(
      directory,
      `${directory}/.review-create-cleanup-a-`,
      async () => 63
    );
    await aAtMkdtemp;
    // The successor wins after A has captured and authenticated its own
    // generation, then replaces that pathname at A's final fence.
    replaceDirectoryAtPostMutationFence = true;
    releaseA?.();

    await expect(allocation).rejects.toThrow('Atomic-create cleanup admission fence was lost');
    // A's immutable identity is still supplied to the exact primitive, which
    // can roll back A when it remains attached (the preceding test). Once the
    // pathname is a successor, the primitive rejects the old identity and
    // leaves that successor intact.
    expect(exactAttempts).toEqual([{ pathname: aDirectory, identity: aIdentity }]);
    expect(recoveryDirectories.get(aDirectory)).toEqual(successorIdentity);
  });

  it('retires an authenticated stale admission owner with an exact capability before admitting', async () => {
    const directory = '/proc/self/fd/77/.';
    const admissionOwner = path.join(directory, '.atomic-create-cleanup-admission-owner.json');
    const staleRaw = JSON.stringify({
      version: 1,
      fence: '12345678-1234-1234-1234-123456789abc',
      pid: 999_999_999,
      incarnation: null,
    });
    const staleIdentity = { dev: 7, ino: 91, birthtimeMs: 11, size: staleRaw.length };
    const owners = new Map<string, { raw: string; identity: typeof staleIdentity }>([
      [admissionOwner, { raw: staleRaw, identity: staleIdentity }],
    ]);
    let nextInode = 100;
    let revalidatedAfterRetirement = false;
    mockReadFile.mockImplementation(async (pathname) => {
      const pathnameString = String(pathname);
      const owner = owners.get(pathnameString);
      if (owner === undefined) {
        if (pathnameString === admissionOwner) revalidatedAfterRetirement = true;
        throw missing();
      }
      return owner.raw;
    });
    mockWriteFile.mockImplementation(async (pathname, data) => {
      const name = String(pathname);
      if (owners.has(name)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      const raw = String(data);
      owners.set(name, {
        raw,
        identity: { dev: 7, ino: nextInode++, birthtimeMs: 11, size: raw.length },
      });
    });
    mockUnlink.mockImplementation(async (pathname) => {
      if (String(pathname) === admissionOwner) owners.delete(admissionOwner);
    });
    mockLink.mockImplementation(async (source, destination) => {
      const owner = owners.get(String(source));
      if (!owner) throw missing();
      if (owners.has(String(destination)))
        throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      owners.set(String(destination), owner);
    });
    mockRename.mockImplementation(async (source, destination) => {
      const owner = owners.get(String(source));
      if (!owner) throw missing();
      owners.delete(String(source));
      owners.set(String(destination), owner);
    });
    mockLstat.mockImplementation(async (pathname) => {
      const owner = owners.get(String(pathname));
      if (owner)
        return {
          ...owner.identity,
          isFile: () => true,
          isDirectory: () => false,
          isSymbolicLink: () => false,
        } as unknown as Awaited<ReturnType<typeof fs.promises.lstat>>;
      if (String(pathname) === admissionOwner) throw missing();
      return {
        dev: 7,
        ino: 12,
        birthtimeMs: 11,
        size: 0,
        isFile: () => false,
        isDirectory: () => true,
        isSymbolicLink: () => false,
      } as unknown as Awaited<ReturnType<typeof fs.promises.lstat>>;
    });
    const exactReleases: Array<{ pathname: string; identity: unknown }> = [];
    exactGenerationMockOperations().unlinkExactGeneration = async (pathname, identity) => {
      const owner = owners.get(String(pathname));
      exactReleases.push({ pathname: String(pathname), identity });
      if (!owner || !hasExactMockIdentity(owner.identity, identity, true)) throw missing();
      owners.delete(String(pathname));
    };
    const result = await allocateAtomicCreateRecoveryDirectory(
      directory,
      path.join(directory, '.review-create-cleanup-a-'),
      async () => 63
    );

    expect(result).toContain('.review-create-cleanup-a-');
    expect(revalidatedAfterRetirement).toBe(true);
    expect(exactReleases[0]).toEqual({ pathname: admissionOwner, identity: staleIdentity });
    expect(exactReleases[1]?.pathname).toMatch(
      /^\/proc\/self\/fd\/77\/\.atomic-create-cleanup-admission-owner\.json\.claim-/
    );
    expect(exactReleases[1]?.identity).toEqual(staleIdentity);
  });

  it('does not let a paused stale reaper delete a successor published after authentication', async () => {
    const directory = '/proc/self/fd/77/.';
    // path.join is intentional: production normalizes the '/.' descriptor
    // alias, so the schedule must use the actual /proc/self/fd/77/... name.
    const admissionOwner = path.join(directory, '.atomic-create-cleanup-admission-owner.json');
    const staleRaw = JSON.stringify({
      version: 1,
      fence: '12345678-1234-1234-1234-123456789abc',
      pid: 999_999_999,
      incarnation: null,
    });
    const successorRaw = JSON.stringify({
      version: 1,
      fence: 'abcdefab-cdef-cdef-cdef-abcdefabcdef',
      pid: 999_999_998,
      incarnation: null,
    });
    const staleIdentity = { dev: 7, ino: 91, birthtimeMs: 11, size: staleRaw.length };
    const successorIdentity = { dev: 7, ino: 92, birthtimeMs: 11, size: successorRaw.length };
    const owners = new Map<string, { raw: string; identity: typeof staleIdentity }>([
      [admissionOwner, { raw: staleRaw, identity: staleIdentity }],
    ]);
    let releaseExact: (() => void) | undefined;
    const exactMayResume = new Promise<void>((resolve) => {
      releaseExact = resolve;
    });
    let exactEntered: (() => void) | undefined;
    const authenticated = new Promise<void>((resolve) => {
      exactEntered = resolve;
    });
    let locks = 0;
    vi.mocked(lockfile.lock).mockImplementation(async () => {
      locks++;
      if (locks > 1) throw new Error('schedule complete');
      return async () => undefined;
    });
    mockReadFile.mockImplementation(async (pathname) => {
      const owner = owners.get(String(pathname));
      if (!owner) throw missing();
      return owner.raw;
    });
    mockLink.mockImplementation(async (source, destination) => {
      const owner = owners.get(String(source));
      if (!owner) throw missing();
      if (owners.has(String(destination)))
        throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      owners.set(String(destination), owner);
    });
    mockLstat.mockImplementation(async (pathname) => {
      const owner = owners.get(String(pathname));
      if (owner)
        return {
          ...owner.identity,
          isFile: () => true,
          isDirectory: () => false,
          isSymbolicLink: () => false,
        } as unknown as Awaited<ReturnType<typeof fs.promises.lstat>>;
      return {
        dev: 7,
        ino: 12,
        birthtimeMs: 11,
        size: 0,
        isFile: () => false,
        isDirectory: () => true,
        isSymbolicLink: () => false,
      } as unknown as Awaited<ReturnType<typeof fs.promises.lstat>>;
    });
    const exactReleases: Array<{ pathname: string; identity: unknown }> = [];
    exactGenerationMockOperations().unlinkExactGeneration = async (pathname, identity) => {
      exactReleases.push({ pathname: String(pathname), identity });
      expect(identity).toEqual(staleIdentity);
      exactEntered?.();
      await exactMayResume;
      const owner = owners.get(String(pathname));
      if (!owner || !hasExactMockIdentity(owner.identity, identity, true)) throw missing();
      owners.delete(String(pathname));
    };

    const allocation = allocateAtomicCreateRecoveryDirectory(
      directory,
      path.join(directory, '.review-create-cleanup-a-'),
      async () => 63
    );
    await authenticated;
    // Another owner publishes after A has authenticated the stale inode and
    // before A's destructive boundary. The exact capability must refuse it.
    owners.set(admissionOwner, { raw: successorRaw, identity: successorIdentity });
    releaseExact?.();

    await expect(allocation).rejects.toThrow('schedule complete');
    expect(owners.get(admissionOwner)).toEqual({ raw: successorRaw, identity: successorIdentity });
    expect(exactReleases).toEqual([{ pathname: admissionOwner, identity: staleIdentity }]);
    expect(mockUnlink).not.toHaveBeenCalledWith(admissionOwner);
  });

  it('keeps a live recorded-incarnation admission owner when its current incarnation is unreadable', async () => {
    const directory = '/proc/self/fd/77/.';
    const admissionOwner = path.join(directory, '.atomic-create-cleanup-admission-owner.json');
    const liveOwner = JSON.stringify({
      version: 1,
      fence: '12345678-1234-1234-1234-123456789abc',
      pid: process.pid,
      incarnation: 'recorded-incarnation',
    });
    const owners = new Map([[admissionOwner, liveOwner]]);
    let lockAttempts = 0;
    mockReadFile.mockImplementation(async (pathname) => {
      const raw = owners.get(String(pathname));
      if (raw === undefined) throw missing(); // /proc/<pid>/stat is temporarily unreadable.
      return raw;
    });
    vi.mocked(lockfile.lock).mockImplementation(async () => {
      lockAttempts++;
      if (lockAttempts > 1) throw new Error('barrier observed');
      return async () => undefined;
    });
    let capacityScans = 0;

    await expect(
      allocateAtomicCreateRecoveryDirectory(
        directory,
        path.join(directory, '.review-create-cleanup-a-'),
        async () => {
          capacityScans++;
          return 63;
        }
      )
    ).rejects.toThrow('barrier observed');

    expect(capacityScans).toBe(0);
    expect(mockLink).not.toHaveBeenCalled();
    expect(mockMkdtemp).not.toHaveBeenCalled();
    expect(owners.get(admissionOwner)).toBe(liveOwner);
  });

  it('fails closed rather than renaming a stale admission owner without an exact capability', async () => {
    const directory = '/proc/self/fd/77/.';
    const ownerPath = path.join(directory, '.atomic-create-cleanup-admission-owner.json');
    const staleOwner = JSON.stringify({
      version: 1,
      fence: '12345678-1234-1234-1234-123456789abc',
      pid: 999_999_999,
      incarnation: null,
    });
    const ownerAliases = new Map<string, string>([[ownerPath, staleOwner]]);
    delete exactGenerationMockOperations().unlinkExactGeneration;
    mockReadFile.mockImplementation(async (pathname) => {
      const value = ownerAliases.get(String(pathname));
      if (value !== undefined) return value;
      throw missing();
    });
    mockWriteFile.mockImplementation(async (pathname, data, options) => {
      const key = String(pathname);
      if (ownerAliases.has(key) && (options as { flag?: string } | undefined)?.flag === 'wx') {
        throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      }
      ownerAliases.set(key, String(data));
    });
    mockLink.mockImplementation(async (source, destination) => {
      const value = ownerAliases.get(String(source));
      if (value === undefined) throw missing();
      if (ownerAliases.has(String(destination))) {
        throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      }
      ownerAliases.set(String(destination), value);
    });
    mockRename.mockImplementation(async (source, destination) => {
      const value = ownerAliases.get(String(source));
      if (value === undefined) throw missing();
      ownerAliases.delete(String(source));
      ownerAliases.set(String(destination), value);
    });
    mockLstat.mockImplementation(async (pathname) => {
      const value = ownerAliases.get(String(pathname));
      if (value === undefined) {
        return {
          dev: 7,
          ino: 12,
          birthtimeMs: 11,
          size: 0,
          mtimeMs: 0,
          isFile: () => false,
          isDirectory: () => true,
          isSymbolicLink: () => false,
        } as unknown as Awaited<ReturnType<typeof fs.promises.lstat>>;
      }
      return {
        dev: 7,
        ino: value === staleOwner ? 91 : 92,
        birthtimeMs: 11,
        size: value.length,
        mtimeMs: 0,
        isFile: () => true,
        isDirectory: () => false,
        isSymbolicLink: () => false,
      } as unknown as Awaited<ReturnType<typeof fs.promises.lstat>>;
    });
    mockOpen.mockImplementation(async (pathname) => {
      const value = ownerAliases.get(String(pathname));
      return {
        sync: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        stat: vi.fn().mockResolvedValue({
          dev: 7,
          ino: value === staleOwner ? 91 : 92,
          birthtimeMs: 11,
          size: value?.length ?? 0,
          isFile: () => true,
        }),
        read: vi.fn(async (buffer: Buffer) => {
          buffer.write(value ?? '', 'utf8');
          return { bytesRead: Buffer.byteLength(value ?? ''), buffer };
        }),
      } as unknown as fs.promises.FileHandle;
    });
    let capacityScans = 0;
    const countExisting = async (): Promise<number> => {
      capacityScans++;
      return 63;
    };

    await expect(
      allocateAtomicCreateRecoveryDirectory(
        directory,
        path.join(directory, '.review-create-cleanup-a-'),
        countExisting
      )
    ).rejects.toThrow('admission owner cannot be retired atomically');
    expect(capacityScans).toBe(0);
    expect(mockRename).not.toHaveBeenCalled();
    expect(mockUnlink).not.toHaveBeenCalledWith(ownerPath);
    expect(ownerAliases.get(ownerPath)).toBe(staleOwner);
  });

  it('fails before mkdtemp when recovery creation cannot return its descriptor atomically', async () => {
    delete exactGenerationMockOperations().mkdtempWithHandle;

    await expect(
      allocateAtomicCreateRecoveryDirectory(
        '/proc/self/fd/77/.',
        '/proc/self/fd/77/.review-create-cleanup-bound-',
        async () => 0
      )
    ).rejects.toThrow('recovery directory creation requires an atomic descriptor primitive');

    expect(mockMkdtemp).not.toHaveBeenCalled();
  });

  it('syncs the attachment directory before record retirement and its parent after rmdir', async () => {
    const guardName = '.review-create.12345678-1234-1234-1234-123456789abc.tmp';
    const ownedStats = {
      dev: 7,
      ino: 9,
      birthtimeMs: 11,
      size: 13,
      nlink: 2,
      isFile: () => true,
      isSymbolicLink: () => false,
    } as unknown as Awaited<ReturnType<typeof fs.promises.lstat>>;
    directoryEntries([], [guardName]);
    mockLstat.mockResolvedValue(ownedStats);
    const operations: string[] = [];
    mockOpen.mockImplementation(
      async (pathname) =>
        ({
          sync: vi.fn(async () => operations.push(`sync:${String(pathname)}`)),
          close: vi.fn().mockResolvedValue(undefined),
          stat: vi
            .fn()
            .mockResolvedValue(
              String(pathname).endsWith('.atomic-create-recovery.json')
                ? { isFile: () => true, size: 0 }
                : { dev: 7, ino: 10, birthtimeMs: 12, isDirectory: () => true }
            ),
          read: vi.fn(async (buffer: Buffer) => ({ bytesRead: 0, buffer })),
        }) as unknown as fs.promises.FileHandle
    );
    mockUnlink.mockImplementation(async (pathname) => {
      operations.push(`unlink:${String(pathname)}`);
    });
    mockRmdir.mockImplementation(async (pathname) => {
      operations.push(`rmdir:${String(pathname)}`);
    });

    await cleanupAtomicCreateTempLinks(TARGET_PATH);

    const cleanupDirectory = `${String(mockMkdtemp.mock.calls[0]?.[0])}cleanup-test`;
    const rmdir = operations.findIndex((entry) => entry.startsWith('rmdir:'));
    expect(operations).toContain(`sync:${cleanupDirectory}`);
    expect(rmdir).toBeGreaterThan(-1);
    expect(operations[rmdir + 1]).toContain('/proc/self/fd/');
  });

  it('deletes only the detached generation when a new guard is published after validation', async () => {
    const guardName = '.review-create.12345678-1234-1234-1234-123456789abc.tmp';
    const guardPath = path.join(TARGET_DIR, guardName);
    const cleanupDirectory = path.join(TARGET_DIR, '.review-create-cleanup-race');
    const ownedStats = {
      dev: 7,
      ino: 9,
      birthtimeMs: 11,
      size: 13,
      nlink: 2,
      isFile: () => true,
      isSymbolicLink: () => false,
    } as unknown as Awaited<ReturnType<typeof fs.promises.lstat>>;
    mockLstat.mockResolvedValue(ownedStats);
    directoryEntries([], [guardName]);
    mockMkdtemp.mockResolvedValue(cleanupDirectory);
    let replacementPublished = false;
    mockRename.mockImplementationOnce(async (source, destination) => {
      expect(String(source)).toMatch(/\/proc\/self\/fd\/.*\.review-create\./);
      expect(String(destination)).toMatch(/\/proc\/self\/fd\/.*\.review-create-cleanup-race\//);
      // A concurrent publisher wins the public guard name immediately after
      // the owned generation has been detached.
      replacementPublished = true;
    });

    await cleanupAtomicCreateTempLinks(TARGET_PATH);

    // The replacement is published at guardPath after rename. Cleanup only
    // touches the detached path, so the public replacement is never removed.
    expect(replacementPublished).toBe(true);
    expect(mockRename).toHaveBeenCalledWith(
      expect.stringContaining('/proc/self/fd/'),
      expect.stringContaining('/proc/self/fd/')
    );
    expect(mockUnlink).toHaveBeenCalledWith(expect.stringContaining('/proc/self/fd/'));
    expect(mockUnlink).not.toHaveBeenCalledWith(guardPath);
  });

  it('retains a foreign generation without granting it recovery deletion authority', async () => {
    const guardName = '.review-create.12345678-1234-1234-1234-123456789abc.tmp';
    const cleanupDirectory = path.join(TARGET_DIR, '.review-create-cleanup-race');
    const ownedStats = {
      dev: 7,
      ino: 9,
      birthtimeMs: 11,
      size: 13,
      nlink: 2,
      isFile: () => true,
      isSymbolicLink: () => false,
    } as unknown as Awaited<ReturnType<typeof fs.promises.lstat>>;
    const foreignStats = {
      dev: 7,
      ino: 10,
      birthtimeMs: 12,
      size: 14,
      nlink: 1,
      isFile: () => true,
      isSymbolicLink: () => false,
    } as unknown as Awaited<ReturnType<typeof fs.promises.lstat>>;
    const cleanupDirectoryStats = {
      dev: 7,
      ino: 10,
      birthtimeMs: 12,
      isDirectory: () => true,
      isSymbolicLink: () => false,
    } as unknown as Awaited<ReturnType<typeof fs.promises.lstat>>;
    mockLstat.mockImplementation(async (pathname) => {
      if (String(pathname).includes('.review-create-cleanup-race')) return cleanupDirectoryStats;
      if (String(pathname).endsWith(guardName) && String(pathname).includes('cleanup-race')) {
        return foreignStats;
      }
      return ownedStats;
    });
    directoryEntries([], [guardName]);
    mockMkdtemp.mockResolvedValue(cleanupDirectory);
    await cleanupAtomicCreateTempLinks(TARGET_PATH);

    // The detached-file matcher rejects the replacement before it can be
    // linked back through the public guard name.
    expect(mockLink).not.toHaveBeenCalledWith(
      expect.stringContaining(guardName),
      expect.any(String)
    );
    expect(mockWriteFile).not.toHaveBeenCalledWith(
      expect.stringContaining('/proc/self/fd/'),
      expect.stringContaining('"ino":10'),
      { encoding: 'utf8', flag: 'wx', mode: 0o600 }
    );
    expect(mockRmdir).not.toHaveBeenCalled();
  });

  it('retains a durable private authority instead of restoring through a mutable guard', async () => {
    const guardName = '.review-create.12345678-1234-1234-1234-123456789abc.tmp';
    const cleanupDirectory = path.join(TARGET_DIR, '.review-create-cleanup-retry');
    const ownedStats = {
      dev: 7,
      ino: 9,
      birthtimeMs: 11,
      size: 13,
      nlink: 2,
      isFile: () => true,
      isSymbolicLink: () => false,
    } as unknown as Awaited<ReturnType<typeof fs.promises.lstat>>;
    mockLstat.mockResolvedValue(ownedStats);
    directoryEntries([], [guardName]);
    mockMkdtemp.mockResolvedValue(cleanupDirectory);

    let detachedUnlinkAttempts = 0;
    mockUnlink.mockImplementation(async (filePath) => {
      if (!String(filePath).includes('.atomic-create-retired-')) return;
      detachedUnlinkAttempts++;
      throw Object.assign(new Error('initial release failure'), { code: 'EIO' });
    });

    await expect(cleanupAtomicCreateTempLinks(TARGET_PATH)).rejects.toMatchObject({
      code: 'EIO',
    });

    expect(detachedUnlinkAttempts).toBeGreaterThan(0);
    expect(mockLink).not.toHaveBeenCalledWith(
      expect.stringContaining('/proc/self/fd/'),
      expect.stringContaining(guardName)
    );
    expect(mockRmdir).not.toHaveBeenCalledWith(
      expect.stringContaining(path.basename(cleanupDirectory))
    );
  });

  it('never republishes a detached guard when a foreign successor occupies its name', async () => {
    const guardName = '.review-create.12345678-1234-1234-1234-123456789abc.tmp';
    const guardPath = path.join(TARGET_DIR, guardName);
    const cleanupDirectory = path.join(TARGET_DIR, '.review-create-cleanup-successor');
    const initialReleaseError = Object.assign(new Error('initial release failure'), {
      code: 'EIO',
    });
    mockLstat.mockResolvedValue({
      dev: 7,
      ino: 9,
      birthtimeMs: 11,
      size: 13,
      nlink: 2,
      isFile: () => true,
      isSymbolicLink: () => false,
    } as unknown as Awaited<ReturnType<typeof fs.promises.lstat>>);
    directoryEntries([], [guardName]);
    mockMkdtemp.mockResolvedValue(cleanupDirectory);
    let releaseAttempted = false;
    mockUnlink.mockImplementation(async (pathname) => {
      if (String(pathname).includes('.atomic-create-retired-') && !releaseAttempted) {
        releaseAttempted = true;
        throw initialReleaseError;
      }
      mockFileContents.delete(String(pathname));
    });

    await expect(cleanupAtomicCreateTempLinks(TARGET_PATH)).rejects.toBe(initialReleaseError);

    expect(mockLink).not.toHaveBeenCalledWith(
      expect.stringContaining('/proc/self/fd/'),
      expect.stringContaining(guardName)
    );
    expect(mockUnlink).not.toHaveBeenCalledWith(guardPath);
    expect(mockRmdir).not.toHaveBeenCalledWith(
      expect.stringContaining(path.basename(cleanupDirectory))
    );
  });

  it('fsyncs the durable record before surfacing a failed release', async () => {
    const guardName = '.review-create.12345678-1234-1234-1234-123456789abc.tmp';
    const cleanupDirectory = path.join(TARGET_DIR, '.review-create-cleanup-crash-sync');
    const initialReleaseError = Object.assign(new Error('initial release failure'), {
      code: 'EIO',
    });
    const parentSyncError = Object.assign(new Error('parent fsync failure'), { code: 'EIO' });
    const ownedStats = {
      dev: 7,
      ino: 9,
      birthtimeMs: 11,
      size: 13,
      nlink: 2,
      isFile: () => true,
      isSymbolicLink: () => false,
    } as unknown as Awaited<ReturnType<typeof fs.promises.lstat>>;
    mockLstat.mockResolvedValue(ownedStats);
    directoryEntries([], [guardName]);
    mockMkdtemp.mockResolvedValue(cleanupDirectory);
    mockUnlink.mockImplementation(async (pathname) => {
      if (String(pathname).includes('.atomic-create-retired-')) {
        throw initialReleaseError;
      }
      mockFileContents.delete(String(pathname));
    });
    let syncCalls = 0;
    mockOpen.mockImplementation(
      async (pathname) =>
        ({
          sync: vi.fn().mockImplementation(async () => {
            syncCalls++;
            // Publication has already synced record/private/parent; the retained
            // authority is synced again before this failed release escapes.
            if (syncCalls === 6) throw parentSyncError;
          }),
          close: vi.fn().mockResolvedValue(undefined),
          stat: vi
            .fn()
            .mockResolvedValue(
              String(pathname).endsWith('.atomic-create-recovery.json')
                ? { isFile: () => true }
                : { dev: 7, ino: 10, birthtimeMs: 12, isDirectory: () => true }
            ),
          readFile: vi.fn().mockResolvedValue(''),
          read: vi.fn(async (buffer: Buffer) => ({ bytesRead: 0, buffer })),
        }) as unknown as fs.promises.FileHandle
    );

    let failure: unknown;
    try {
      await cleanupAtomicCreateTempLinks(TARGET_PATH);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([initialReleaseError, parentSyncError]);
    expect(syncCalls).toBeGreaterThanOrEqual(6);
    expect(mockOpen.mock.calls.map(([pathname]) => String(pathname))).toContainEqual(
      expect.stringContaining('.atomic-create-recovery.json')
    );
  });

  it('rejects a recovery-directory symlink without following or deleting outside it', async () => {
    const cleanupName = '.review-create-cleanup-symlink';
    directoryEntries([cleanupName]);
    mockLstat.mockResolvedValueOnce({
      isDirectory: () => false,
      isSymbolicLink: () => true,
    } as unknown as Awaited<ReturnType<typeof fs.promises.lstat>>);

    await expect(cleanupAtomicCreateTempLinks(TARGET_PATH)).rejects.toThrow('remains pending');

    expect(mockUnlink).not.toHaveBeenCalled();
    expect(mockRmdir).not.toHaveBeenCalled();
    expect(mockOpen).toHaveBeenCalledTimes(1);
  });

  it('recovers an authenticated hidden attachment without touching a replaced target', async () => {
    const nonce = '12345678-1234-1234-1234-123456789abc';
    const cleanupAuthority = '87654321-4321-4321-4321-cba987654321';
    const cleanupName = `.review-create-cleanup-${nonce}-${cleanupAuthority}-replaced-target`;
    const guardName = '.review-create.12345678-1234-1234-1234-123456789abc.tmp';
    const directoryStats = {
      dev: 7,
      ino: 10,
      birthtimeMs: 12,
      isDirectory: () => true,
      isSymbolicLink: () => false,
    } as unknown as Awaited<ReturnType<typeof fs.promises.lstat>>;
    const attachmentStats = {
      dev: 7,
      ino: 9,
      birthtimeMs: 11,
      size: 13,
      nlink: 1,
      isFile: () => true,
      isSymbolicLink: () => false,
    } as unknown as Awaited<ReturnType<typeof fs.promises.lstat>>;
    const successorStats = {
      dev: 7,
      ino: 99,
      birthtimeMs: 99,
      size: 7,
      nlink: 1,
      isFile: () => true,
      isSymbolicLink: () => false,
    } as unknown as Awaited<ReturnType<typeof fs.promises.lstat>>;
    const record = JSON.stringify({
      version: 1,
      nonce,
      cleanupAuthority,
      directoryName: cleanupName,
      directoryIdentity: { dev: 7, ino: 10, birthtimeMs: 12 },
      attachment: { name: guardName, identity: { dev: 7, ino: 9, birthtimeMs: 11, size: 13 } },
    });
    const recoveryRecordStats = {
      dev: 7,
      ino: 11,
      birthtimeMs: 13,
      size: record.length,
      isFile: () => true,
      isSymbolicLink: () => false,
    } as unknown as Awaited<ReturnType<typeof fs.promises.lstat>>;
    let attachmentPresent = true;
    directoryEntries([cleanupName]);
    mockLstat.mockImplementation(async (pathname) => {
      const pathnameString = String(pathname);
      if (pathnameString.includes('.atomic-create-recovery.pending.json')) {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      }
      if (pathnameString.includes('.atomic-create-recovery.json')) return recoveryRecordStats;
      if (pathnameString.includes(guardName)) {
        if (attachmentPresent) return attachmentStats;
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      }
      if (pathnameString.includes(cleanupName)) return directoryStats;
      return successorStats;
    });
    mockUnlink.mockImplementation(async (pathname) => {
      if (String(pathname).includes(guardName)) attachmentPresent = false;
    });
    mockOpen.mockImplementation(
      async (pathname) =>
        ({
          sync: vi.fn().mockResolvedValue(undefined),
          close: vi.fn().mockResolvedValue(undefined),
          stat: vi
            .fn()
            .mockResolvedValue(
              String(pathname).endsWith('.atomic-create-recovery.json')
                ? recoveryRecordStats
                : { dev: 7, ino: 10, birthtimeMs: 12, isDirectory: () => true }
            ),
          readFile: vi.fn().mockResolvedValue(record),
          read: vi.fn(async (buffer: Buffer) => {
            buffer.write(record, 'utf8');
            return { bytesRead: Buffer.byteLength(record), buffer };
          }),
        }) as unknown as fs.promises.FileHandle
    );

    await cleanupAtomicCreateTempLinks(TARGET_PATH);

    expect(mockUnlink).toHaveBeenCalledWith(expect.stringContaining(`/proc/self/fd/`));
    expect(mockUnlink).not.toHaveBeenCalledWith(TARGET_PATH);
    expect(mockRmdir).toHaveBeenCalledWith(
      expect.stringContaining('.review-create-cleanup-retired-')
    );
  });

  it('bounds recovery-record enumeration before inspecting an unbounded directory', async () => {
    directoryEntries(Array.from({ length: 65 }, (_, index) => `.review-create-cleanup-${index}`));

    await expect(cleanupAtomicCreateTempLinks(TARGET_PATH)).rejects.toThrow('retention limit (64)');

    expect(mockLstat).not.toHaveBeenCalled();
    expect(mockOpen).toHaveBeenCalledTimes(1);
  });

  it.each(['darwin', 'win32'] as const)(
    'fails closed before pathname cleanup mutations when descriptor-relative child paths are unavailable (%s)',
    async (platform) => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { configurable: true, value: platform });
      try {
        await expect(cleanupAtomicCreateTempLinks(TARGET_PATH)).rejects.toThrow(
          'requires descriptor-rooted child operations'
        );
        expect(mockOpen).not.toHaveBeenCalled();
        expect(mockLstat).not.toHaveBeenCalled();
      } finally {
        Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform });
      }
    }
  );

  it('retains the actual foreign attachment instead of restoring it through the public guard', async () => {
    const guardName = '.review-create.12345678-1234-1234-1234-123456789abc.tmp';
    const cleanupDirectory = path.join(TARGET_DIR, '.review-create-cleanup-foreign-restore-error');
    const ownedStats = {
      dev: 7,
      ino: 9,
      birthtimeMs: 11,
      size: 13,
      nlink: 2,
      isFile: () => true,
      isSymbolicLink: () => false,
    } as unknown as Awaited<ReturnType<typeof fs.promises.lstat>>;
    const foreignStats = {
      dev: 7,
      ino: 77,
      birthtimeMs: 78,
      size: 79,
      nlink: 1,
      isFile: () => true,
      isSymbolicLink: () => false,
    } as unknown as Awaited<ReturnType<typeof fs.promises.lstat>>;
    mockMkdtemp.mockResolvedValue(cleanupDirectory);
    mockLstat.mockImplementation(async (pathname) => {
      if (String(pathname).endsWith(guardName)) {
        return foreignStats;
      }
      return ownedStats;
    });
    directoryEntries([], [guardName]);

    await cleanupAtomicCreateTempLinks(TARGET_PATH);

    expect(mockWriteFile).not.toHaveBeenCalledWith(
      expect.stringContaining('/proc/self/fd/'),
      expect.stringContaining('"ino":77'),
      { encoding: 'utf8', flag: 'wx', mode: 0o600 }
    );
    expect(mockLink).not.toHaveBeenCalledWith(
      expect.stringContaining(guardName),
      expect.any(String)
    );
  });

  it('reclaims an empty recordless cleanup directory only after rmdir proves it empty', async () => {
    const cleanupName = '.review-create-cleanup-before-record';
    directoryEntries([cleanupName], []);
    mockLstat.mockImplementation(async (pathname) => {
      if (
        String(pathname).includes('.atomic-create-recovery') ||
        String(pathname).includes('directory-retirement')
      ) {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      }
      return {
        dev: 7,
        ino: 10,
        birthtimeMs: 12,
        size: CONTENT.length,
        nlink: 1,
        isDirectory: () => String(pathname).includes(cleanupName),
        isSymbolicLink: () => false,
        isFile: () => !String(pathname).includes(cleanupName),
      } as unknown as Awaited<ReturnType<typeof fs.promises.lstat>>;
    });

    await cleanupAtomicCreateTempLinks(TARGET_PATH);

    expect(mockRmdir).toHaveBeenCalledWith(
      expect.stringContaining('.review-create-cleanup-retired-')
    );
  });

  it('retains a nonempty recordless cleanup directory against future recovery capacity', async () => {
    const cleanupName = '.review-create-cleanup-after-record';
    directoryEntries([cleanupName], []);
    mockLstat.mockImplementation(async (pathname) => {
      if (
        String(pathname).includes('.atomic-create-recovery') ||
        String(pathname).includes('directory-retirement')
      ) {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      }
      return {
        dev: 7,
        ino: 10,
        birthtimeMs: 12,
        size: CONTENT.length,
        nlink: 1,
        isDirectory: () => String(pathname).includes(cleanupName),
        isSymbolicLink: () => false,
        isFile: () => !String(pathname).includes(cleanupName),
      } as unknown as Awaited<ReturnType<typeof fs.promises.lstat>>;
    });

    mockRmdir.mockRejectedValue(Object.assign(new Error('not empty'), { code: 'ENOTEMPTY' }));
    await cleanupAtomicCreateTempLinks(TARGET_PATH);

    expect(mockRmdir).toHaveBeenCalledWith(
      expect.stringContaining('.review-create-cleanup-retired-')
    );
  });

  it('never creates more recovery authorities than the scanner can enumerate', async () => {
    const guards = Array.from(
      { length: 64 },
      (_, index) => `.review-create.12345678-1234-1234-1234-${String(index).padStart(12, '0')}.tmp`
    );
    mockLstat.mockResolvedValue({
      dev: 7,
      ino: 9,
      birthtimeMs: 11,
      size: 13,
      nlink: 65,
      isFile: () => true,
      isSymbolicLink: () => false,
    } as unknown as Awaited<ReturnType<typeof fs.promises.lstat>>);
    directoryEntries([], guards);

    await cleanupAtomicCreateTempLinks(TARGET_PATH);

    expect(mockMkdtemp).toHaveBeenCalledTimes(64);
  });

  it('charges retained nonempty recordless cleanup directories before creating another authority', async () => {
    const retainedCleanupDirectories = Array.from(
      { length: 64 },
      (_, index) => `.review-create-cleanup-retained-${index}`
    );
    const guardName = '.review-create.12345678-1234-1234-1234-123456789abc.tmp';
    const directoryStats = {
      dev: 7,
      ino: 10,
      birthtimeMs: 12,
      isDirectory: () => true,
      isSymbolicLink: () => false,
    } as unknown as Awaited<ReturnType<typeof fs.promises.lstat>>;
    const ownedFileStats = {
      dev: 7,
      ino: 9,
      birthtimeMs: 11,
      size: 13,
      nlink: 2,
      isFile: () => true,
      isSymbolicLink: () => false,
    } as unknown as Awaited<ReturnType<typeof fs.promises.lstat>>;
    mockLstat.mockImplementation(async (pathname) => {
      const pathnameString = String(pathname);
      if (
        pathnameString.includes('.atomic-create-recovery') ||
        pathnameString.includes('directory-retirement')
      ) {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      }
      if (pathnameString.includes('.review-create-cleanup-')) return directoryStats;
      return ownedFileStats;
    });
    // Recordless but nonempty directories cannot be retired; they must count
    // against capacity even though no recovery record can authenticate them.
    mockRmdir.mockRejectedValue(Object.assign(new Error('not empty'), { code: 'ENOTEMPTY' }));
    // Recovery scans the existing namespace first, then admission recounts it
    // under the same lock immediately before it creates a new directory.
    directoryEntries(retainedCleanupDirectories, [guardName], retainedCleanupDirectories);

    await expect(cleanupAtomicCreateTempLinks(TARGET_PATH)).rejects.toThrow(
      'recovery authority capacity (64) exhausted'
    );

    expect(mockMkdtemp).not.toHaveBeenCalled();
  });

  it('rejects a FIFO recovery record before opening it', async () => {
    const cleanupName = '.review-create-cleanup-fifo';
    directoryEntries([cleanupName]);
    mockLstat.mockImplementation(async (pathname) => {
      if (String(pathname).includes('.atomic-create-recovery.json')) {
        return {
          isFile: () => false,
          isSymbolicLink: () => false,
          isFIFO: () => true,
          size: 0,
        } as unknown as Awaited<ReturnType<typeof fs.promises.lstat>>;
      }
      return {
        dev: 7,
        ino: 10,
        birthtimeMs: 12,
        isDirectory: () => true,
        isSymbolicLink: () => false,
      } as unknown as Awaited<ReturnType<typeof fs.promises.lstat>>;
    });

    await expect(cleanupAtomicCreateTempLinks(TARGET_PATH)).rejects.toThrow('remains pending');

    expect(
      mockOpen.mock.calls.filter(([pathname]) =>
        String(pathname).includes('.atomic-create-recovery.json')
      )
    ).toHaveLength(0);
  });

  it('rejects an oversized recovery record before reading it', async () => {
    const cleanupName = '.review-create-cleanup-oversized';
    directoryEntries([cleanupName]);
    mockLstat.mockImplementation(async (pathname) => {
      if (String(pathname).includes('.atomic-create-recovery.json')) {
        return {
          isFile: () => true,
          isSymbolicLink: () => false,
          size: 16 * 1024 + 1,
        } as unknown as Awaited<ReturnType<typeof fs.promises.lstat>>;
      }
      return {
        dev: 7,
        ino: 10,
        birthtimeMs: 12,
        isDirectory: () => true,
        isSymbolicLink: () => false,
      } as unknown as Awaited<ReturnType<typeof fs.promises.lstat>>;
    });

    await expect(cleanupAtomicCreateTempLinks(TARGET_PATH)).rejects.toThrow('remains pending');

    expect(
      mockOpen.mock.calls.filter(([pathname]) =>
        String(pathname).includes('.atomic-create-recovery.json')
      )
    ).toHaveLength(0);
  });

  it('fails closed when the filesystem cannot report a trustworthy inode', async () => {
    mockLstat.mockResolvedValue({
      dev: 7,
      ino: 0,
      birthtimeMs: 11,
      size: 13,
      nlink: 2,
      isFile: () => true,
      isSymbolicLink: () => false,
    } as unknown as Awaited<ReturnType<typeof fs.promises.lstat>>);
    directoryEntries([], ['.review-create.12345678-1234-1234-1234-123456789abc.tmp']);

    await cleanupAtomicCreateTempLinks(TARGET_PATH);

    expect(mockUnlink).not.toHaveBeenCalled();
    expect(mockMkdtemp).not.toHaveBeenCalled();
  });
});
