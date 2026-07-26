import { constants, promises as fs, type Stats } from 'node:fs';
import path from 'node:path';

import type { ToolApprovalFileReaderPort } from '../../core/application/ports/TeamApprovalsPorts';
import type { ToolApprovalFileContent } from '@shared/types';

/** Maximum payload read for an approval diff preview (2 MiB). */
export const TOOL_APPROVAL_MAX_FILE_SIZE = 2 * 1024 * 1024;
const TOOL_APPROVAL_BINARY_SCAN_SIZE = 8 * 1024;

function sameFileIdentity(
  left: Pick<Stats, 'dev' | 'ino'>,
  right: Pick<Stats, 'dev' | 'ino'>
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function lstatSymlinkFreePath(filePath: string): Promise<Stats> {
  const resolvedPath = path.resolve(filePath);
  const parsedPath = path.parse(resolvedPath);
  const segments = resolvedPath.slice(parsedPath.root.length).split(path.sep).filter(Boolean);
  let currentPath = parsedPath.root;
  let currentStats = await fs.lstat(currentPath);

  for (const segment of segments) {
    currentPath = path.join(currentPath, segment);
    currentStats = await fs.lstat(currentPath);
    if (currentStats.isSymbolicLink()) {
      throw new Error('Symbolic links are not allowed in approval preview paths');
    }
  }

  return currentStats;
}

export class NodeToolApprovalFileReader implements ToolApprovalFileReaderPort {
  async read(filePath: string): Promise<ToolApprovalFileContent> {
    try {
      const resolvedPath = path.resolve(filePath);
      let initialStats;
      try {
        initialStats = await lstatSymlinkFreePath(resolvedPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return { content: '', exists: false, truncated: false, isBinary: false };
        }
        throw error;
      }

      if (!initialStats.isFile()) {
        return {
          content: '',
          exists: true,
          truncated: false,
          isBinary: false,
          error: 'Not a file',
        };
      }

      const readSize = Math.min(initialStats.size, TOOL_APPROVAL_MAX_FILE_SIZE);
      const file = await fs.open(resolvedPath, constants.O_RDONLY | constants.O_NOFOLLOW);

      try {
        const openedStats = await file.stat();
        if (!openedStats.isFile() || !sameFileIdentity(initialStats, openedStats)) {
          throw new Error('Approval preview file changed before it could be opened safely');
        }

        const buffer = Buffer.alloc(readSize);
        const { bytesRead } = await file.read(buffer, 0, readSize, 0);
        const contentBuffer = buffer.subarray(0, bytesRead);
        const finalStats = await file.stat();
        const currentPathStats = await lstatSymlinkFreePath(resolvedPath);
        if (!sameFileIdentity(openedStats, currentPathStats)) {
          throw new Error('Approval preview file changed while it was being read');
        }
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
