import path from 'node:path';

import { NodeToolApprovalFileReader } from '../infrastructure/NodeToolApprovalFileReader';

import type {
  TeamApprovalsCommandPort,
  ToolApprovalFileReaderPort,
  ToolApprovalPreviewAccessPort,
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
  getPendingToolApprovalFilePath(teamName: string, runId: string, requestId: string): string | null;
}

export interface TeamApprovalsFeature {
  commands: TeamApprovalsCommandPort;
  fileReader: ToolApprovalFileReaderPort;
  previewAccess: ToolApprovalPreviewAccessPort;
}

export function createTeamApprovalsFeature(dependencies: {
  toolApprovalApi: TeamToolApprovalCompatibilityApi;
}): TeamApprovalsFeature {
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
    fileReader: new NodeToolApprovalFileReader(),
    previewAccess: {
      canRead: ({ teamName, runId, requestId, filePath }) => {
        const approvedPath = dependencies.toolApprovalApi.getPendingToolApprovalFilePath(
          teamName,
          runId,
          requestId
        );
        return approvedPath !== null && path.resolve(approvedPath) === path.resolve(filePath);
      },
    },
  };
}
