import {
  getTeamDataWorkerClient,
  isTeamDataWorkerFatalError,
} from '@main/services/team/TeamDataWorkerClient';

import type {
  TeamTaskLogQuery,
  TeamTaskLogWorkerPort,
} from '../../../core/application/ports/TeamRuntimeOperationPorts';
import type { MemberLogSummary } from '@shared/types';

export class MainTeamTaskLogWorker implements TeamTaskLogWorkerPort {
  isAvailable(): boolean {
    return getTeamDataWorkerClient().isAvailable();
  }

  findLogsForTask(
    teamName: string,
    taskId: string,
    options?: TeamTaskLogQuery
  ): Promise<MemberLogSummary[]> {
    return getTeamDataWorkerClient().findLogsForTask(teamName, taskId, options);
  }

  fatalFailureMessage(error: unknown): string | null {
    if (!isTeamDataWorkerFatalError(error)) {
      return null;
    }
    const message = error instanceof Error ? error.message : String(error);
    return `TEAM_DATA_WORKER_FAILED: ${message}`;
  }
}
