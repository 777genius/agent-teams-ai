import type { ToolApprovalFileContent } from '../models/TeamApprovalsModels';
import type {
  PendingToolApprovalFileTargetPort,
  ToolApprovalFileReaderPort,
  ToolApprovalPreviewReaderPort,
} from '../ports/TeamApprovalsPorts';
import type { ToolApprovalFileReadRequest } from '@features/team-approvals/contracts';

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

    const content = await this.dependencies.files.read(target.readPath);
    const currentTarget = this.dependencies.pendingApprovals.getFileTarget(
      request.teamName,
      request.runId,
      request.requestId
    );
    if (
      currentTarget?.authorizationGeneration !== target.authorizationGeneration ||
      currentTarget.authorizationPath !== target.authorizationPath ||
      currentTarget.readPath !== target.readPath
    ) {
      return null;
    }

    return content;
  }
}
