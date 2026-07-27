import { ReadToolApprovalFilePreview } from '../../core/application/use-cases/ReadToolApprovalFilePreview';
import { NodeToolApprovalFileReader } from '../infrastructure/NodeToolApprovalFileReader';

import type {
  TeamApprovalsCommandPort,
  ToolApprovalFileReaderPort,
  ToolApprovalPreviewReaderPort,
} from '../../core/application/ports/TeamApprovalsPorts';
import type { ToolApprovalSettings } from '@shared/types';

export interface TeamToolApprovalCompatibilityApi {
  respondToToolApproval(
    teamName: string,
    runId: string,
    requestId: string,
    allow: boolean,
    message?: string
  ): Promise<void>;
  updateToolApprovalSettings(teamName: string, settings: ToolApprovalSettings): void;
  getPendingToolApprovalFileTarget(
    teamName: string,
    runId: string,
    requestId: string
  ): { authorizationGeneration: string; authorizationPath: string; readPath: string } | null;
}

export interface TeamApprovalsFeature {
  commands: TeamApprovalsCommandPort;
  previewReader: ToolApprovalPreviewReaderPort;
}

export function createTeamApprovalsFeature(dependencies: {
  toolApprovalApi: TeamToolApprovalCompatibilityApi;
  fileReader?: ToolApprovalFileReaderPort;
}): TeamApprovalsFeature {
  const fileReader = dependencies.fileReader ?? new NodeToolApprovalFileReader();

  return {
    commands: {
      respond: ({ teamName, runId, requestId, allow, message }) =>
        dependencies.toolApprovalApi.respondToToolApproval(
          teamName,
          runId,
          requestId,
          allow,
          message
        ),
      updateSettings: ({ teamName, settings }) =>
        dependencies.toolApprovalApi.updateToolApprovalSettings(teamName, settings),
    },
    previewReader: new ReadToolApprovalFilePreview({
      pendingApprovals: {
        getFileTarget: (teamName, runId, requestId) =>
          dependencies.toolApprovalApi.getPendingToolApprovalFileTarget(teamName, runId, requestId),
      },
      files: fileReader,
    }),
  };
}
