import { execFile } from 'node:child_process';
import { constants, promises as fs, type Stats } from 'node:fs';
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  NodeToolApprovalFileReader,
  TOOL_APPROVAL_MAX_FILE_SIZE,
} from './NodeToolApprovalFileReader';
import { WindowsToolApprovalFileReader } from './WindowsToolApprovalFileReader';

describe('NodeToolApprovalFileReader', () => {
  const reader = new NodeToolApprovalFileReader();
  let tempDirectory: string;

  beforeEach(async () => {
    tempDirectory = await realpath(
      await mkdtemp(path.join(os.tmpdir(), 'team-approvals-file-reader-'))
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tempDirectory, { recursive: true, force: true });
  });

  function createVirtualStats(size: number, isFile = true): Stats {
    return {
      dev: 7,
      ino: isFile ? 11 : 10,
      isFile: () => isFile,
      isSymbolicLink: () => false,
      size,
    } as Stats;
  }

  function mockFinalFileOpen(fileName: string, handle: object): string {
    const originalOpen = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementation(async (candidate, flags, mode) => {
      if (path.basename(String(candidate)) === fileName) return handle as never;
      return originalOpen(candidate, flags, mode);
    });
    return path.join(tempDirectory, fileName);
  }

  it('distinguishes missing paths, directories, and text files', async () => {
    const missingPath = path.join(tempDirectory, 'missing.txt');
    await expect(reader.read(missingPath)).resolves.toEqual({
      content: '',
      exists: false,
      truncated: false,
      isBinary: false,
    });

    const directoryPath = path.join(tempDirectory, 'directory');
    await mkdir(directoryPath);
    await expect(reader.read(directoryPath)).resolves.toEqual({
      content: '',
      exists: true,
      truncated: false,
      isBinary: false,
      error: 'Not a file',
    });

    const textPath = path.join(tempDirectory, 'text.txt');
    await writeFile(textPath, 'hello approval');
    await expect(reader.read(textPath)).resolves.toEqual({
      content: 'hello approval',
      exists: true,
      truncated: false,
      isBinary: false,
    });
  });

  it('keeps the exact 2 MiB boundary and truncates only larger files', async () => {
    const exactPath = path.join(tempDirectory, 'exact.txt');
    await writeFile(exactPath, Buffer.alloc(TOOL_APPROVAL_MAX_FILE_SIZE, 0x61));
    const exact = await reader.read(exactPath);
    expect(exact).toMatchObject({ exists: true, truncated: false, isBinary: false });
    expect(Buffer.byteLength(exact.content)).toBe(TOOL_APPROVAL_MAX_FILE_SIZE);

    const oversizedPath = path.join(tempDirectory, 'oversized.txt');
    await writeFile(oversizedPath, Buffer.alloc(TOOL_APPROVAL_MAX_FILE_SIZE + 1, 0x62));
    const oversized = await reader.read(oversizedPath);
    expect(oversized).toMatchObject({ exists: true, truncated: true, isBinary: false });
    expect(Buffer.byteLength(oversized.content)).toBe(TOOL_APPROVAL_MAX_FILE_SIZE);
  });

  it('detects null bytes only inside the first 8 KiB', async () => {
    const earlyNullPath = path.join(tempDirectory, 'early-null.bin');
    const earlyNull = Buffer.alloc(9 * 1024, 0x61);
    earlyNull[8 * 1024 - 1] = 0;
    await writeFile(earlyNullPath, earlyNull);
    await expect(reader.read(earlyNullPath)).resolves.toEqual({
      content: '',
      exists: true,
      truncated: false,
      isBinary: true,
    });

    const lateNullPath = path.join(tempDirectory, 'late-null.txt');
    const lateNull = Buffer.alloc(8 * 1024 + 1, 0x61);
    lateNull[8 * 1024] = 0;
    await writeFile(lateNullPath, lateNull);
    const result = await reader.read(lateNullPath);
    expect(result).toMatchObject({ exists: true, truncated: false, isBinary: false });
    expect(result.content.charCodeAt(8 * 1024)).toBe(0);
  });

  it('decodes only bytes actually returned by a short read', async () => {
    const close = vi.fn(async () => undefined);
    const filePath = mockFinalFileOpen('short-read.txt', {
      read: vi.fn(async (buffer: Buffer) => {
        buffer.write('hello');
        return { bytesRead: 5, buffer };
      }),
      stat: vi
        .fn()
        .mockResolvedValueOnce(createVirtualStats(8))
        .mockResolvedValueOnce(createVirtualStats(5)),
      close,
    });

    await expect(reader.read(filePath)).resolves.toEqual({
      content: 'hello',
      exists: true,
      truncated: false,
      isBinary: false,
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it('marks a preview truncated when the open file grows after the initial stat', async () => {
    const filePath = mockFinalFileOpen('growing.txt', {
      read: vi.fn(async (buffer: Buffer) => {
        buffer.write('hello');
        return { bytesRead: 5, buffer };
      }),
      stat: vi
        .fn()
        .mockResolvedValueOnce(createVirtualStats(5))
        .mockResolvedValueOnce(createVirtualStats(16)),
      close: vi.fn(async () => undefined),
    });

    await expect(reader.read(filePath)).resolves.toMatchObject({
      content: 'hello',
      truncated: true,
    });
  });

  it('clears stale truncation when the open file shrinks before the read', async () => {
    const filePath = mockFinalFileOpen('shrinking.txt', {
      read: vi.fn(async (buffer: Buffer) => {
        buffer.write('hello');
        return { bytesRead: 5, buffer };
      }),
      stat: vi
        .fn()
        .mockResolvedValueOnce(createVirtualStats(TOOL_APPROVAL_MAX_FILE_SIZE + 1))
        .mockResolvedValueOnce(createVirtualStats(5)),
      close: vi.fn(async () => undefined),
    });

    await expect(reader.read(filePath)).resolves.toMatchObject({
      content: 'hello',
      truncated: false,
    });
  });

  it('contains filesystem failures in the stable file-preview response', async () => {
    const invalidPath = `${tempDirectory}/invalid\0path`;
    const result = await reader.read(invalidPath);

    expect(result).toMatchObject({
      content: '',
      exists: true,
      truncated: false,
      isBinary: false,
    });
    expect(result.error).toEqual(expect.any(String));
  });

  it('rejects final and parent symbolic links instead of following them', async () => {
    const outsideDirectory = path.join(tempDirectory, 'outside');
    await mkdir(outsideDirectory);
    const outsideFile = path.join(outsideDirectory, 'secret.txt');
    await writeFile(outsideFile, 'unapproved secret');

    const finalLink = path.join(tempDirectory, 'final-link.txt');
    await symlink(outsideFile, finalLink);
    await expect(reader.read(finalLink)).resolves.toMatchObject({
      content: '',
      exists: true,
      error: expect.any(String),
    });

    const parentLink = path.join(tempDirectory, 'parent-link');
    await symlink(outsideDirectory, parentLink);
    await expect(reader.read(path.join(parentLink, 'secret.txt'))).resolves.toMatchObject({
      content: '',
      exists: true,
      error: expect.any(String),
    });
  });

  it('rejects raw parent components without rejecting legal dot-containing names', async () => {
    const legalPath = path.join(tempDirectory, '..cache.txt');
    await writeFile(legalPath, 'legal content');
    await expect(reader.read(legalPath)).resolves.toMatchObject({ content: 'legal content' });

    const rawParentPath = [tempDirectory, 'unused-child', '..', path.basename(legalPath)].join(
      path.sep
    );
    await expect(reader.read(rawParentPath)).resolves.toMatchObject({
      content: '',
      error: expect.stringContaining('Parent path traversal is not allowed'),
    });
  });

  it.runIf(process.platform !== 'win32')(
    'rejects symlink parent traversal before lexical normalization can change the target',
    async () => {
      const workspaceDirectory = path.join(tempDirectory, 'workspace');
      const outsideDirectory = path.join(tempDirectory, 'outside');
      const outsideChildDirectory = path.join(outsideDirectory, 'child');
      await mkdir(workspaceDirectory);
      await mkdir(outsideDirectory);
      await mkdir(outsideChildDirectory);
      await writeFile(path.join(workspaceDirectory, 'target.txt'), 'benign content');
      await writeFile(path.join(outsideDirectory, 'target.txt'), 'unapproved secret');

      const linkedDirectory = path.join(workspaceDirectory, 'linked');
      await symlink(outsideChildDirectory, linkedDirectory);
      const rawApprovedPath = [linkedDirectory, '..', 'target.txt'].join(path.sep);
      await expect(fs.readFile(rawApprovedPath, 'utf8')).resolves.toBe('unapproved secret');
      await expect(reader.read(rawApprovedPath)).resolves.toMatchObject({
        content: '',
        error: expect.stringContaining('Parent path traversal is not allowed'),
      });
    }
  );

  it.runIf(process.platform !== 'win32')(
    'rejects hard-linked files using the opened handle identity',
    async () => {
      const secretPath = path.join(tempDirectory, 'secret.txt');
      const approvedPath = path.join(tempDirectory, 'approved.txt');
      await writeFile(secretPath, 'sensitive content');
      await link(secretPath, approvedPath);

      await expect(reader.read(approvedPath)).resolves.toMatchObject({
        content: '',
        exists: true,
        error: expect.stringContaining('Hard-linked files are not allowed'),
      });
    }
  );

  it.runIf(process.platform !== 'win32')(
    'rejects a FIFO without waiting for a writer',
    async () => {
      const fifoPath = path.join(tempDirectory, 'preview.pipe');
      await promisify(execFile)('mkfifo', [fifoPath]);
      let fallbackWriterWasNeeded = false;
      let fallbackWriter = Promise.resolve();
      const fallbackTimer = setTimeout(() => {
        fallbackWriterWasNeeded = true;
        fallbackWriter = fs
          .open(fifoPath, constants.O_WRONLY | constants.O_NONBLOCK)
          .then((handle) => handle.close());
      }, 500);

      try {
        await expect(reader.read(fifoPath)).resolves.toEqual({
          content: '',
          exists: true,
          truncated: false,
          isBinary: false,
          error: 'Not a file',
        });
      } finally {
        clearTimeout(fallbackTimer);
        await fallbackWriter;
      }
      expect(fallbackWriterWasNeeded).toBe(false);
    }
  );

  it('delegates Windows reads to the native handle reader', async () => {
    const windowsReader = {
      read: vi.fn(async () => ({
        content: 'approved Windows content',
        exists: true,
        truncated: false,
        isBinary: false,
      })),
    };
    const windowsAwareReader = new NodeToolApprovalFileReader(windowsReader);
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const textPath = path.join(tempDirectory, 'windows-preview.txt');

    await expect(windowsAwareReader.read(textPath)).resolves.toEqual({
      content: 'approved Windows content',
      exists: true,
      truncated: false,
      isBinary: false,
    });
    expect(windowsReader.read).toHaveBeenCalledWith(path.resolve(textPath));
  });

  it('rejects Windows parent aliases before native helper delegation', async () => {
    const windowsReader = { read: vi.fn() };
    const windowsAwareReader = new NodeToolApprovalFileReader(windowsReader);
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');

    const blockedPaths = [
      'C:\\approved\\..\\secret.txt',
      'C:\\approved\\.. \\secret.txt',
      'C:\\approved\\..  \\secret.txt',
      'C:\\approved\\.. .\\secret.txt',
      'C:/approved/.. /secret.txt',
      'C:\\approved/.. .\\secret.txt',
    ];
    for (const blockedPath of blockedPaths) {
      await expect(windowsAwareReader.read(blockedPath)).resolves.toMatchObject({
        content: '',
        error: expect.stringContaining('Parent path traversal is not allowed'),
      });
    }
    expect(windowsReader.read).not.toHaveBeenCalled();
  });

  it('delegates legal Windows dot-containing components', async () => {
    const windowsReader = {
      read: vi.fn(async () => ({
        content: '',
        exists: false,
        truncated: false,
        isBinary: false,
      })),
    };
    const windowsAwareReader = new NodeToolApprovalFileReader(windowsReader);
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');

    const legalPaths = [
      'C:\\approved\\..cache.txt',
      'C:\\approved\\. \\preview.txt',
      'C:\\approved\\...\\preview.txt',
      'C:\\approved\\... \\preview.txt',
      'C:\\approved\\.. .cache\\preview.txt',
      'C:\\approved\\folder.\\preview.txt',
      'C:\\approved\\folder \\preview.txt',
      'C:\\approved\\..\u00a0\\preview.txt',
    ];
    for (const legalPath of legalPaths) {
      await windowsAwareReader.read(legalPath);
    }

    expect(windowsReader.read).toHaveBeenCalledTimes(legalPaths.length);
  });

  it('decodes bounded content returned by the Windows handle helper', async () => {
    const windowsReader = new WindowsToolApprovalFileReader({
      read: vi.fn(async () => ({
        exists: true,
        contentBase64: Buffer.from('approved content').toString('base64'),
        truncated: true,
      })),
    });

    await expect(windowsReader.read('C:\\approved\\preview.txt')).resolves.toEqual({
      content: 'approved content',
      exists: true,
      truncated: true,
      isBinary: false,
    });
  });

  it('contains Windows helper failures in the stable preview response', async () => {
    const windowsReader = new WindowsToolApprovalFileReader({
      read: vi.fn(async () => ({
        exists: true,
        error: 'Safe approval preview rejected a Windows reparse-point path',
      })),
    });

    await expect(windowsReader.read('C:\\linked\\secret.txt')).resolves.toMatchObject({
      content: '',
      exists: true,
      error: expect.stringContaining('reparse-point path'),
    });
  });

  it('reports masked procfs traversal as an error instead of a missing target', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    const closeRoot = vi.fn(async () => undefined);
    const rootHandle = { fd: 41, close: closeRoot };
    vi.spyOn(fs, 'open').mockImplementation(async (candidate) => {
      if (String(candidate) === path.parse(tempDirectory).root) return rootHandle as never;
      if (String(candidate) === '/proc/self/fd/41/.') {
        throw Object.assign(new Error('procfs unavailable'), { code: 'ENOENT' });
      }
      throw new Error(`Unexpected open: ${String(candidate)}`);
    });

    await expect(reader.read(path.join(tempDirectory, 'existing.txt'))).resolves.toEqual({
      content: '',
      exists: true,
      truncated: false,
      isBinary: false,
      error: 'Safe approval preview traversal requires accessible /proc/self/fd',
    });
    expect(closeRoot).toHaveBeenCalledOnce();
  });

  it.runIf(process.platform === 'linux')(
    'reads an approved file through an execute-only directory',
    async () => {
      const traversalDirectory = path.join(tempDirectory, 'execute-only');
      const filePath = path.join(traversalDirectory, 'preview.txt');
      await mkdir(traversalDirectory);
      await writeFile(filePath, 'approved content');
      await chmod(traversalDirectory, 0o111);

      try {
        await expect(reader.read(filePath)).resolves.toEqual({
          content: 'approved content',
          exists: true,
          truncated: false,
          isBinary: false,
        });
      } finally {
        await chmod(traversalDirectory, 0o700);
      }
    }
  );

  it('never follows a parent swapped to a symbolic link during safe open', async () => {
    const approvedDirectory = path.join(tempDirectory, 'approved');
    const parkedDirectory = path.join(tempDirectory, 'approved-parked');
    const outsideDirectory = path.join(tempDirectory, 'outside');
    await mkdir(approvedDirectory);
    await mkdir(outsideDirectory);
    const approvedFile = path.join(approvedDirectory, 'preview.txt');
    await writeFile(approvedFile, 'approved content');
    await writeFile(path.join(outsideDirectory, 'preview.txt'), 'unapproved secret');

    const originalOpen = fs.open.bind(fs);
    let swapped = false;
    vi.spyOn(fs, 'open').mockImplementation(async (filePath, flags, mode) => {
      if (!swapped && path.basename(String(filePath)) === 'preview.txt') {
        swapped = true;
        await rename(approvedDirectory, parkedDirectory);
        await symlink(outsideDirectory, approvedDirectory);
      }
      return originalOpen(filePath, flags, mode);
    });

    const result = await reader.read(approvedFile);

    expect(result.content).not.toContain('unapproved secret');
    if (result.content) expect(result.content).toBe('approved content');
  });
});
