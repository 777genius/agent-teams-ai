import { FatalTeamTaskLogWorkerFailure } from '../errors/FatalTeamTaskLogWorkerFailure';

import type {
  TeamRuntimeLoggerPort,
  TeamRuntimeLogsPort,
  TeamTaskLogQuery,
  TeamTaskLogWorkerPort,
} from '../ports/TeamRuntimeOperationPorts';
import type {
  MemberFullStats,
  MemberLogSummary,
  TeamClaudeLogsQuery,
  TeamClaudeLogsResponse,
} from '@shared/types';

export class ReadTeamRuntimeLogs {
  constructor(
    private readonly logs: TeamRuntimeLogsPort,
    private readonly worker: TeamTaskLogWorkerPort,
    private readonly logger: TeamRuntimeLoggerPort
  ) {}

  async getClaudeLogs(
    teamName: string,
    query?: TeamClaudeLogsQuery
  ): Promise<TeamClaudeLogsResponse> {
    const data = await this.logs.getClaudeLogs(teamName, query);
    return {
      lines: data.lines,
      total: data.total,
      hasMore: data.hasMore,
      updatedAt: data.updatedAt,
    };
  }

  getMemberLogs(teamName: string, memberName: string): Promise<MemberLogSummary[]> {
    return this.logs.findMemberLogs(teamName, memberName);
  }

  async getLogsForTask(
    teamName: string,
    taskId: string,
    options?: TeamTaskLogQuery
  ): Promise<MemberLogSummary[]> {
    if (this.worker.isAvailable()) {
      try {
        return await this.worker.findLogsForTask(teamName, taskId, options);
      } catch (error) {
        const fatalMessage = this.worker.fatalFailureMessage(error);
        if (fatalMessage) {
          throw new FatalTeamTaskLogWorkerFailure(fatalMessage);
        }
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`[teams:getLogsForTask] worker failed, falling back: ${message}`);
      }
    }
    return this.logs.findLogsForTask(teamName, taskId, options);
  }

  getMemberStats(teamName: string, memberName: string): Promise<MemberFullStats> {
    return this.logs.getMemberStats(teamName, memberName);
  }
}
