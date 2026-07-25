import type { ToolApprovalFileReadRequest } from '@features/team-approvals/contracts';
import type { ToolApprovalFileContent, ToolApprovalSettings } from '@shared/types';

export interface RespondToToolApprovalCommand {
  teamName: string;
  runId: string;
  requestId: string;
  allow: boolean;
  message?: string;
}

export interface UpdateToolApprovalSettingsCommand {
  teamName: string;
  settings: ToolApprovalSettings;
}

/** Commands consumed by the team approvals feature. */
export interface TeamApprovalsCommandPort {
  respond(command: RespondToToolApprovalCommand): Promise<void>;
  updateSettings(command: UpdateToolApprovalSettingsCommand): void;
}

/** Read-only filesystem capability used by the approval diff preview. */
export interface ToolApprovalFileReaderPort {
  read(filePath: string): Promise<ToolApprovalFileContent>;
}

export interface PendingToolApprovalFilePathPort {
  getFilePath(teamName: string, runId: string, requestId: string): string | null;
}

/** Application capability that authorizes and reads one active approval preview. */
export interface ToolApprovalPreviewReaderPort {
  read(request: ToolApprovalFileReadRequest): Promise<ToolApprovalFileContent | null>;
}
