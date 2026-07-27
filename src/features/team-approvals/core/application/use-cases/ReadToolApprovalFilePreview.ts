import type {
  PendingToolApprovalFileTargetPort,
  ToolApprovalFileReaderPort,
  ToolApprovalPreviewReaderPort,
} from '../ports/TeamApprovalsPorts';
import type { ToolApprovalFileReadRequest } from '@features/team-approvals/contracts';
import type { ToolApprovalFileContent } from '@shared/types';

export interface ReadToolApprovalFilePreviewDependencies {
  pendingApprovals: PendingToolApprovalFileTargetPort;
  files: ToolApprovalFileReaderPort;
}

export class ReadToolApprovalFilePreview implements ToolApprovalPreviewReaderPort {
  constructor(private readonly dependencies: ReadToolApprovalFilePreviewDependencies) {}

  async read(request: ToolApprovalFileReadRequest): Promise<ToolApprovalFileContent | null> {
    const target = this.dependencies.pendingApprovals.getFileTarget(
      request.teamName,
      request.runId,
      request.requestId
    );
    if (request.filePath !== target?.authorizationPath) {
      return null;
    }

    return this.dependencies.files.read(target.readPath);
  }
}
