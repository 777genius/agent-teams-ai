import type { ToolApprovalSettings } from '@shared/types';

export interface TeamToolApprovalRendererTransportPort {
  respond(
    teamName: string,
    runId: string,
    requestId: string,
    allow: boolean,
    message?: string
  ): Promise<void>;
  updateSettings(teamName: string, settings: ToolApprovalSettings): Promise<void>;
}
