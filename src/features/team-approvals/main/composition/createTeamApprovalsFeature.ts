import { NodeToolApprovalFileReader } from '../infrastructure/NodeToolApprovalFileReader';

import type {
  TeamApprovalsCommandPort,
  ToolApprovalFileReaderPort,
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
}

export interface TeamApprovalsFeature {
  commands: TeamApprovalsCommandPort;
  fileReader: ToolApprovalFileReaderPort;
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
  };
}
