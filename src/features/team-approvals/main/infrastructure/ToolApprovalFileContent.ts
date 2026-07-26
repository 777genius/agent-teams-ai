import type { ToolApprovalFileContent } from '@shared/types';

/** Maximum payload read for an approval diff preview (2 MiB). */
export const TOOL_APPROVAL_MAX_FILE_SIZE = 2 * 1024 * 1024;
const TOOL_APPROVAL_BINARY_SCAN_SIZE = 8 * 1024;

export function createToolApprovalFileContent(
  content: Buffer,
  truncated: boolean
): ToolApprovalFileContent {
  const binaryScanSize = Math.min(content.length, TOOL_APPROVAL_BINARY_SCAN_SIZE);
  for (let index = 0; index < binaryScanSize; index++) {
    if (content[index] === 0) {
      return { content: '', exists: true, truncated, isBinary: true };
    }
  }

  return {
    content: content.toString('utf8'),
    exists: true,
    truncated,
    isBinary: false,
  };
}
