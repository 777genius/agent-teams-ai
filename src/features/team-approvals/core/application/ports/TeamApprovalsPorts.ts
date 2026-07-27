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

export interface PendingToolApprovalFileTarget {
  /** Opaque generation of the active approval and its workspace binding. */
  authorizationGeneration: string;
  /** Exact path string carried by the authorized tool request. */
  authorizationPath: string;
  /** Absolute path resolved from the owning run's project directory. */
  readPath: string;
}

export interface PendingToolApprovalFileTargetPort {
  getFileTarget(
    teamName: string,
    runId: string,
    requestId: string
  ): PendingToolApprovalFileTarget | null;
}

/** Application capability that authorizes and reads one active approval preview. */
export interface ToolApprovalPreviewReaderPort {
  read(request: ToolApprovalFileReadRequest): Promise<ToolApprovalFileContent | null>;
}
