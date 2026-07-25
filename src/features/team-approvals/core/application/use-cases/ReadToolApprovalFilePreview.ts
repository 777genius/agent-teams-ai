import type {
  PendingToolApprovalFilePathPort,
  ToolApprovalFileReaderPort,
  ToolApprovalPreviewReaderPort,
} from '../ports/TeamApprovalsPorts';
import type { ToolApprovalFileReadRequest } from '@features/team-approvals/contracts';
import type { ToolApprovalFileContent } from '@shared/types';

export interface ReadToolApprovalFilePreviewDependencies {
  pendingApprovals: PendingToolApprovalFilePathPort;
  files: ToolApprovalFileReaderPort;
}

export class ReadToolApprovalFilePreview implements ToolApprovalPreviewReaderPort {
  constructor(private readonly dependencies: ReadToolApprovalFilePreviewDependencies) {}

  async read(request: ToolApprovalFileReadRequest): Promise<ToolApprovalFileContent | null> {
    const approvedPath = this.dependencies.pendingApprovals.getFilePath(
      request.teamName,
      request.runId,
      request.requestId
    );
    if (approvedPath === null || request.filePath !== approvedPath) {
      return null;
    }

    return this.dependencies.files.read(approvedPath);
  }
}
