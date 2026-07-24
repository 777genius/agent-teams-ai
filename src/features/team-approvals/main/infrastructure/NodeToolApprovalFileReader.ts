import { promises as fs } from 'node:fs';

import type { ToolApprovalFileReaderPort } from '../../core/application/ports/TeamApprovalsPorts';
import type { ToolApprovalFileContent } from '@shared/types';

/** Maximum payload read for an approval diff preview (2 MiB). */
export const TOOL_APPROVAL_MAX_FILE_SIZE = 2 * 1024 * 1024;
const TOOL_APPROVAL_BINARY_SCAN_SIZE = 8 * 1024;

export class NodeToolApprovalFileReader implements ToolApprovalFileReaderPort {
  async read(filePath: string): Promise<ToolApprovalFileContent> {
    try {
      let stats;
      try {
        stats = await fs.stat(filePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return { content: '', exists: false, truncated: false, isBinary: false };
        }
        throw error;
      }

      if (!stats.isFile()) {
        return {
          content: '',
          exists: true,
          truncated: false,
          isBinary: false,
          error: 'Not a file',
        };
      }

      const truncated = stats.size > TOOL_APPROVAL_MAX_FILE_SIZE;
      const readSize = truncated ? TOOL_APPROVAL_MAX_FILE_SIZE : stats.size;
      const file = await fs.open(filePath, 'r');

      try {
        const buffer = Buffer.alloc(readSize);
        await file.read(buffer, 0, readSize, 0);

        const binaryScanSize = Math.min(readSize, TOOL_APPROVAL_BINARY_SCAN_SIZE);
        for (let index = 0; index < binaryScanSize; index++) {
          if (buffer[index] === 0) {
            return { content: '', exists: true, truncated: false, isBinary: true };
          }
        }

        return {
          content: buffer.toString('utf8'),
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
