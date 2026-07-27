import type {
  ToolApprovalEvent,
  ToolApprovalFileContent,
  ToolApprovalSettings,
} from '@shared/types/team';

export interface ToolApprovalFileReadRequest {
  teamName: string;
  runId: string;
  requestId: string;
  filePath: string;
}

export interface TeamApprovalsElectronApi {
  respondToToolApproval(
    teamName: string,
    runId: string,
    requestId: string,
    allow: boolean,
    message?: string
  ): Promise<void>;
  onToolApprovalEvent(callback: (event: unknown, data: ToolApprovalEvent) => void): () => void;
  updateToolApprovalSettings(teamName: string, settings: ToolApprovalSettings): Promise<void>;
  readFileForToolApproval(request: ToolApprovalFileReadRequest): Promise<ToolApprovalFileContent>;
}
