import { constants, promises as fs } from 'node:fs';
import path from 'node:path';

import type { ToolApprovalFileReaderPort } from '../../core/application/ports/TeamApprovalsPorts';
import type { ToolApprovalFileContent } from '@shared/types';
import type { FileHandle } from 'node:fs/promises';

/** Maximum payload read for an approval diff preview (2 MiB). */
export const TOOL_APPROVAL_MAX_FILE_SIZE = 2 * 1024 * 1024;
const TOOL_APPROVAL_BINARY_SCAN_SIZE = 8 * 1024;
/** Darwin kernel flag that rejects symlinks in every path component. */
const DARWIN_O_NOFOLLOW_ANY = 0x20000000;

async function openLinuxSymlinkSafePath(filePath: string): Promise<FileHandle> {
  const parsedPath = path.parse(filePath);
  const segments = filePath.slice(parsedPath.root.length).split(path.sep).filter(Boolean);
  const fileFlags = constants.O_RDONLY | constants.O_NOFOLLOW;
  if (segments.length === 0) return fs.open(parsedPath.root, fileFlags);

  const directoryFlags = fileFlags | constants.O_DIRECTORY;
  let directory = await fs.open(parsedPath.root, directoryFlags);
  let openedFile: FileHandle | null = null;
  try {
    for (const segment of segments.slice(0, -1)) {
      const nextDirectory = await fs.open(
        path.join('/proc/self/fd', String(directory.fd), segment),
        directoryFlags
      );
      const previousDirectory = directory;
      directory = nextDirectory;
      await previousDirectory.close();
    }
    openedFile = await fs.open(
      path.join('/proc/self/fd', String(directory.fd), segments.at(-1) ?? ''),
      fileFlags
    );
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
  async read(filePath: string): Promise<ToolApprovalFileContent> {
    try {
      const resolvedPath = path.resolve(filePath);
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

        const binaryScanSize = Math.min(contentBuffer.length, TOOL_APPROVAL_BINARY_SCAN_SIZE);
        for (let index = 0; index < binaryScanSize; index++) {
          if (contentBuffer[index] === 0) {
            return { content: '', exists: true, truncated, isBinary: true };
          }
        }

        return {
          content: contentBuffer.toString('utf8'),
          exists: true,
          truncated,
          isBinary: false,
        };
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
