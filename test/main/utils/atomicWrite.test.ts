/**
 * Tests for atomicWriteAsync — tmp + fsync + rename atomic write pattern.
 */

import * as fs from 'fs';
import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('fs', () => ({
  promises: {
    mkdir: vi.fn(),
    writeFile: vi.fn(),
    open: vi.fn(),
    rename: vi.fn(),
    copyFile: vi.fn(),
    unlink: vi.fn(),
  },
}));

import { atomicWriteAsync } from '../../../src/main/utils/atomicWrite';

// =============================================================================
// Setup
// =============================================================================

const mockMkdir = vi.mocked(fs.promises.mkdir);
const mockWriteFile = vi.mocked(fs.promises.writeFile);
const mockOpen = vi.mocked(fs.promises.open);
const mockRename = vi.mocked(fs.promises.rename);
const mockCopyFile = vi.mocked(fs.promises.copyFile);
const mockUnlink = vi.mocked(fs.promises.unlink);

const TARGET_PATH = path.resolve('/Users/test/project/src/index.ts');
const TARGET_DIR = path.dirname(TARGET_PATH);
const CONTENT = 'export const hello = "world";';

/** Extract the tmp path from writeFile calls */
function getTmpPath(): string {
  const call = mockWriteFile.mock.calls[0];
  return String(call[0]);
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

    expect(mockWriteFile).toHaveBeenCalledWith(expect.any(String), CONTENT, 'utf8');
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

  it('falls back to copyFile + unlink on EXDEV error', async () => {
    const exdevError = Object.assign(new Error('Cross-device link'), { code: 'EXDEV' });
    mockRename.mockRejectedValue(exdevError);

    await atomicWriteAsync(TARGET_PATH, CONTENT);

    const tmpPath = getTmpPath();
    expect(mockCopyFile).toHaveBeenCalledWith(tmpPath, TARGET_PATH);
    expect(mockUnlink).toHaveBeenCalledWith(tmpPath);
  });

  it('still succeeds EXDEV fallback even if tmp cleanup fails', async () => {
    const exdevError = Object.assign(new Error('Cross-device link'), { code: 'EXDEV' });
    mockRename.mockRejectedValue(exdevError);
    mockUnlink.mockRejectedValue(new Error('permission denied'));

    // Should not throw
    await atomicWriteAsync(TARGET_PATH, CONTENT);

    expect(mockCopyFile).toHaveBeenCalled();
  });

  it('re-throws non-EXDEV rename errors and cleans tmp', async () => {
    const permError = Object.assign(new Error('Permission denied'), { code: 'EACCES' });
    mockRename.mockRejectedValue(permError);

    await expect(atomicWriteAsync(TARGET_PATH, CONTENT)).rejects.toThrow('Permission denied');
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
