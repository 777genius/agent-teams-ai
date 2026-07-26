import { constants, promises as fs } from 'node:fs';
import path from 'node:path';

import {
  createToolApprovalFileContent,
  TOOL_APPROVAL_MAX_FILE_SIZE,
} from './ToolApprovalFileContent';
import { WindowsToolApprovalFileReader } from './WindowsToolApprovalFileReader';

import type { ToolApprovalFileReaderPort } from '../../core/application/ports/TeamApprovalsPorts';
import type { ToolApprovalFileContent } from '@shared/types';
import type { FileHandle } from 'node:fs/promises';

export { TOOL_APPROVAL_MAX_FILE_SIZE } from './ToolApprovalFileContent';
/** Darwin kernel flag that rejects symlinks in every path component. */
const DARWIN_O_NOFOLLOW_ANY = 0x20000000;
/** Linux O_PATH opens a traversal handle without requiring directory read access. */
const LINUX_O_PATH = 0x200000;
const LINUX_DIRECTORY_FLAGS = LINUX_O_PATH | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const LINUX_PROC_SELF_FD = '/proc/self/fd';

class LinuxDescriptorTraversalUnavailableError extends Error {
  constructor(cause: unknown) {
    super('Safe approval preview traversal requires accessible /proc/self/fd', { cause });
    this.name = 'LinuxDescriptorTraversalUnavailableError';
  }
}

function linuxDescriptorChildPath(directory: FileHandle, segment: string): string {
  return `${path.join(LINUX_PROC_SELF_FD, String(directory.fd))}${path.sep}${segment}`;
}

async function assertLinuxDescriptorTraversalAvailable(
  directory: FileHandle,
  directoryFlags: number
): Promise<void> {
  let probe: FileHandle | null = null;
  try {
    probe = await fs.open(linuxDescriptorChildPath(directory, '.'), directoryFlags);
    const [directoryStats, probeStats] = await Promise.all([directory.stat(), probe.stat()]);
    if (directoryStats.dev !== probeStats.dev || directoryStats.ino !== probeStats.ino) {
      throw new Error('Descriptor traversal resolved to a different directory');
    }
  } catch (error) {
    throw new LinuxDescriptorTraversalUnavailableError(error);
  } finally {
    await probe?.close().catch(() => undefined);
  }
}

async function openLinuxDescriptorChild(
  directory: FileHandle,
  segment: string,
  flags: number
): Promise<FileHandle> {
  try {
    return await fs.open(linuxDescriptorChildPath(directory, segment), flags);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      await assertLinuxDescriptorTraversalAvailable(directory, LINUX_DIRECTORY_FLAGS);
    }
    throw error;
  }
}

async function openLinuxSymlinkSafePath(filePath: string): Promise<FileHandle> {
  const parsedPath = path.parse(filePath);
  const segments = filePath.slice(parsedPath.root.length).split(path.sep).filter(Boolean);
  const fileFlags = constants.O_RDONLY | constants.O_NOFOLLOW;
  if (segments.length === 0) return fs.open(parsedPath.root, fileFlags);

  let directory = await fs.open(parsedPath.root, LINUX_DIRECTORY_FLAGS);
  let openedFile: FileHandle | null = null;
  try {
    await assertLinuxDescriptorTraversalAvailable(directory, LINUX_DIRECTORY_FLAGS);
    for (const segment of segments.slice(0, -1)) {
      const nextDirectory = await openLinuxDescriptorChild(
        directory,
        segment,
        LINUX_DIRECTORY_FLAGS
      );
      const previousDirectory = directory;
      directory = nextDirectory;
      await previousDirectory.close();
    }
    openedFile = await openLinuxDescriptorChild(directory, segments.at(-1) ?? '', fileFlags);
    await directory.close();
    return openedFile;
  } catch (error) {
    await directory.close().catch(() => undefined);
    await openedFile?.close().catch(() => undefined);
    throw error;
  }
}

function openSymlinkSafePath(filePath: string): Promise<FileHandle> {
  if (process.platform === 'darwin') {
    return fs.open(filePath, constants.O_RDONLY | DARWIN_O_NOFOLLOW_ANY);
  }
  if (process.platform === 'linux') return openLinuxSymlinkSafePath(filePath);
  throw new Error(`Safe approval preview reads are unavailable on ${process.platform}`);
}

export class NodeToolApprovalFileReader implements ToolApprovalFileReaderPort {
  constructor(
    private readonly windowsReader: ToolApprovalFileReaderPort = new WindowsToolApprovalFileReader()
  ) {}

  async read(filePath: string): Promise<ToolApprovalFileContent> {
    try {
      const resolvedPath = path.resolve(filePath);
      if (process.platform === 'win32') return this.windowsReader.read(resolvedPath);
      let file: FileHandle;
      try {
        file = await openSymlinkSafePath(resolvedPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return { content: '', exists: false, truncated: false, isBinary: false };
        }
        throw error;
      }

      try {
        const openedStats = await file.stat();
        if (!openedStats.isFile()) {
          return {
            content: '',
            exists: true,
            truncated: false,
            isBinary: false,
            error: 'Not a file',
          };
        }

        const readSize = Math.min(openedStats.size, TOOL_APPROVAL_MAX_FILE_SIZE);
        const buffer = Buffer.alloc(readSize);
        const { bytesRead } = await file.read(buffer, 0, readSize, 0);
        const contentBuffer = buffer.subarray(0, bytesRead);
        const finalStats = await file.stat();
        const truncated = finalStats.size > bytesRead;

        return createToolApprovalFileContent(contentBuffer, truncated);
      } finally {
        await file.close();
      }
    } catch (error) {
      return {
        content: '',
        exists: true,
        truncated: false,
        isBinary: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
