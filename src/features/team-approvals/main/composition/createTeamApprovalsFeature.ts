import { ReadToolApprovalFilePreview } from '../../core/application/use-cases/ReadToolApprovalFilePreview';

import type { TeamApprovalsFeature } from './TeamApprovalsIpcBoundary';
import type { ToolApprovalFileContent, ToolApprovalSettings } from '@shared/types';

export interface TeamApprovalsFileReader {
  read(filePath: string): Promise<ToolApprovalFileContent>;
}

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

export type { TeamApprovalsFeature } from './TeamApprovalsIpcBoundary';

export interface TeamApprovalsFeatureDependencies {
  toolApprovalApi: TeamToolApprovalCompatibilityApi;
  fileReader: TeamApprovalsFileReader;
  withWriterAdmission?: <T>(teamName: string, operation: () => Promise<T>) => Promise<T>;
  withWriterWorkflow?: <T>(teamName: string, operation: () => Promise<T>) => Promise<T>;
}

export function createTeamApprovalsFeature(
  dependencies: TeamApprovalsFeatureDependencies
): TeamApprovalsFeature {
  const admitted = <T>(teamName: string, operation: () => Promise<T>): Promise<T> =>
    dependencies.withWriterAdmission?.(teamName, operation) ?? operation();
  const workflow = <T>(teamName: string, operation: () => Promise<T>): Promise<T> =>
    dependencies.withWriterWorkflow?.(teamName, operation) ?? operation();
  const previewReader = new ReadToolApprovalFilePreview({
    pendingApprovals: {
      getFileTarget: (teamName, runId, requestId) =>
        dependencies.toolApprovalApi.getPendingToolApprovalFileTarget(teamName, runId, requestId),
    },
    files: dependencies.fileReader,
  });

  return {
    commands: {
      respond: ({ teamName, runId, requestId, allow, message }) =>
        workflow(teamName, async () => {
          await admitted(teamName, async () => undefined);
          await dependencies.toolApprovalApi.respondToToolApproval(
            teamName,
            runId,
            requestId,
            allow,
            message
          );
        }),
      updateSettings: ({ teamName, settings }) =>
        admitted(teamName, async () => {
          dependencies.toolApprovalApi.updateToolApprovalSettings(teamName, settings);
        }),
    },
    previewReader: {
      read: (request) => previewReader.read(request),
    },
  };
}
