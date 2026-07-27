import { constants, promises as fs } from 'node:fs';
import path from 'node:path';

import {
  createToolApprovalFileContent,
  TOOL_APPROVAL_MAX_FILE_SIZE,
} from './ToolApprovalFileContent';
import { WindowsToolApprovalFileReader } from './WindowsToolApprovalFileReader';

import type { ToolApprovalFileReaderPort } from '../../core/application/ports/TeamApprovalsPorts';
import type { ToolApprovalFileContent } from '@shared/types';
import type { Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';

export { TOOL_APPROVAL_MAX_FILE_SIZE } from './ToolApprovalFileContent';
/** Darwin kernel flag that rejects symlinks in every path component. */
const DARWIN_O_NOFOLLOW_ANY = 0x20000000;
/** Linux O_PATH opens a traversal handle without requiring directory read access. */
const LINUX_O_PATH = 0x200000;
const LINUX_DIRECTORY_FLAGS = LINUX_O_PATH | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const LINUX_PROC_SELF_FD = '/proc/self/fd';
const PARENT_PATH_COMPONENT_ERROR =
  'Parent path traversal is not allowed in approval preview paths';
const PATH_GENERATION_CHANGED_ERROR = 'Approval preview path changed while the file was being read';

class LinuxDescriptorTraversalUnavailableError extends Error {
  constructor(cause: unknown) {
    super('Safe approval preview traversal requires accessible /proc/self/fd', { cause });
    this.name = 'LinuxDescriptorTraversalUnavailableError';
  }
}

function linuxDescriptorChildPath(directory: FileHandle, segment: string): string {
  return `${path.join(LINUX_PROC_SELF_FD, String(directory.fd))}${path.sep}${segment}`;
}

/**
 * Win32 treats two leading periods plus trailing ASCII space/period noise as a
 * parent alias. Three or more leading periods remain a legal component name.
 */
function isWindowsParentPathComponent(component: string): boolean {
  if (!component.startsWith('..')) return false;

  let leadingPeriodCount = 0;
  while (component[leadingPeriodCount] === '.') leadingPeriodCount++;
  if (leadingPeriodCount !== 2) return false;

  for (let index = leadingPeriodCount; index < component.length; index++) {
    const character = component[index];
    if (character !== ' ' && character !== '.') return false;
  }
  return true;
}

function hasParentPathComponent(filePath: string): boolean {
  if (process.platform === 'win32') {
    return filePath.split(/[\\/]+/).some(isWindowsParentPathComponent);
  }
  return filePath.split(path.sep).includes('..');
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
  const fileFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
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
    return fs.open(filePath, constants.O_RDONLY | constants.O_NONBLOCK | DARWIN_O_NOFOLLOW_ANY);
  }
  if (process.platform === 'linux') return openLinuxSymlinkSafePath(filePath);
  throw new Error(`Safe approval preview reads are unavailable on ${process.platform}`);
}

async function openSymlinkSafePathWithMissingRetry(filePath: string): Promise<FileHandle | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await openSymlinkSafePath(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return null;
}

function hasSameStableIdentity(openedStats: Stats, currentStats: Stats): boolean {
  return (
    openedStats.ino !== 0 &&
    currentStats.ino !== 0 &&
    openedStats.dev === currentStats.dev &&
    openedStats.ino === currentStats.ino &&
    openedStats.size === currentStats.size &&
    openedStats.mtimeMs === currentStats.mtimeMs &&
    openedStats.ctimeMs === currentStats.ctimeMs &&
    openedStats.nlink === 1 &&
    currentStats.nlink === 1
  );
}

async function assertOpenedFileStillMatchesPath(
  filePath: string,
  openedStats: Stats
): Promise<void> {
  const currentFile = await openSymlinkSafePathWithMissingRetry(filePath);
  if (!currentFile) throw new Error(PATH_GENERATION_CHANGED_ERROR);

  try {
    const currentStats = await currentFile.stat();
    if (!currentStats.isFile() || !hasSameStableIdentity(openedStats, currentStats)) {
      throw new Error(PATH_GENERATION_CHANGED_ERROR);
    }
  } finally {
    await currentFile.close();
  }
}

async function readOpenedFile(file: FileHandle, readSize: number): Promise<Buffer> {
  const buffer = Buffer.alloc(readSize);
  let offset = 0;
  while (offset < readSize) {
    const { bytesRead } = await file.read(buffer, offset, readSize - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return buffer.subarray(0, offset);
}

export class NodeToolApprovalFileReader implements ToolApprovalFileReaderPort {
  constructor(
    private readonly windowsReader: ToolApprovalFileReaderPort = new WindowsToolApprovalFileReader()
  ) {}

  async read(filePath: string): Promise<ToolApprovalFileContent> {
    try {
      if (hasParentPathComponent(filePath)) {
        throw new Error(PARENT_PATH_COMPONENT_ERROR);
      }
      const resolvedPath = path.resolve(filePath);
      if (process.platform === 'win32') return this.windowsReader.read(resolvedPath);
      const file = await openSymlinkSafePathWithMissingRetry(resolvedPath);
      if (!file) return { content: '', exists: false, truncated: false, isBinary: false };

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
        if (openedStats.nlink !== 1) {
          throw new Error('Hard-linked files are not allowed in approval preview paths');
        }

        const readSize = Math.min(openedStats.size, TOOL_APPROVAL_MAX_FILE_SIZE);
        const contentBuffer = await readOpenedFile(file, readSize);
        const finalStats = await file.stat();
        if (!hasSameStableIdentity(openedStats, finalStats)) {
          throw new Error(PATH_GENERATION_CHANGED_ERROR);
        }
        const truncated = finalStats.size > contentBuffer.byteLength;
        await assertOpenedFileStillMatchesPath(resolvedPath, openedStats);

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
