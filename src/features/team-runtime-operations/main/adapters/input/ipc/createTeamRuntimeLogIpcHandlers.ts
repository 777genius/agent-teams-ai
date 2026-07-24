import { validateMemberName, validateTaskId, validateTeamName } from '@main/ipc/guards';

import { executeTeamRuntimeOperation } from './executeTeamRuntimeOperation';

import type { TeamTaskLogQuery } from '../../../../core/application/ports/TeamRuntimeOperationPorts';
import type { TeamRuntimeOperationsFeature } from '../../../composition/createTeamRuntimeOperationsFeature';
import type {
  IpcResult,
  MemberFullStats,
  MemberLogSummary,
  TeamClaudeLogsQuery,
  TeamClaudeLogsResponse,
} from '@shared/types';
import type { IpcMainInvokeEvent } from 'electron';

export interface TeamRuntimeLogIpcHandlers {
  getClaudeLogs(
    event: IpcMainInvokeEvent,
    teamName: unknown,
    query?: unknown
  ): Promise<IpcResult<TeamClaudeLogsResponse>>;
  getMemberLogs(
    event: IpcMainInvokeEvent,
    teamName: unknown,
    memberName: unknown
  ): Promise<IpcResult<MemberLogSummary[]>>;
  getLogsForTask(
    event: IpcMainInvokeEvent,
    teamName: unknown,
    taskId: unknown,
    options?: unknown
  ): Promise<IpcResult<MemberLogSummary[]>>;
  getMemberStats(
    event: IpcMainInvokeEvent,
    teamName: unknown,
    memberName: unknown
  ): Promise<IpcResult<MemberFullStats>>;
}

function normalizeClaudeLogsQuery(query: unknown):
  | { valid: true; value: TeamClaudeLogsQuery | undefined }
  | {
      valid: false;
      error: string;
    } {
  if (query === undefined) return { valid: true, value: undefined };
  if (!query || typeof query !== 'object' || Array.isArray(query)) {
    return { valid: false, error: 'query must be an object' };
  }
  const value = query as Record<string, unknown>;
  for (const field of ['offset', 'limit'] as const) {
    const candidate = value[field];
    if (
      candidate !== undefined &&
      (typeof candidate !== 'number' ||
        !Number.isFinite(candidate) ||
        !Number.isInteger(candidate) ||
        candidate < 0)
    ) {
      return { valid: false, error: `${field} must be a non-negative integer` };
    }
  }
  return {
    valid: true,
    value: {
      offset: typeof value.offset === 'number' ? value.offset : undefined,
      limit: typeof value.limit === 'number' ? value.limit : undefined,
    },
  };
}

function normalizeTaskLogQuery(
  options: unknown
): { valid: true; value: TeamTaskLogQuery | undefined } | { valid: false; error: string } {
  if (options === undefined) return { valid: true, value: undefined };
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    return { valid: false, error: 'options must be an object' };
  }
  const value = options as Record<string, unknown>;
  for (const field of ['owner', 'status', 'since'] as const) {
    if (value[field] !== undefined && typeof value[field] !== 'string') {
      return { valid: false, error: `${field} must be a string` };
    }
  }
  if (value.intervals !== undefined && !Array.isArray(value.intervals)) {
    return { valid: false, error: 'intervals must be an array' };
  }
  if (
    Array.isArray(value.intervals) &&
    value.intervals.some(
      (interval) =>
        !interval ||
        typeof interval !== 'object' ||
        Array.isArray(interval) ||
        typeof (interval as Record<string, unknown>).startedAt !== 'string' ||
        ((interval as Record<string, unknown>).completedAt !== undefined &&
          typeof (interval as Record<string, unknown>).completedAt !== 'string')
    )
  ) {
    return {
      valid: false,
      error: 'each interval must include startedAt and an optional completedAt string',
    };
  }
  return {
    valid: true,
    value: {
      owner: value.owner as string | undefined,
      status: value.status as string | undefined,
      since: value.since as string | undefined,
      intervals: value.intervals as TeamTaskLogQuery['intervals'],
    },
  };
}

export function createTeamRuntimeLogIpcHandlers(
  feature: TeamRuntimeOperationsFeature
): TeamRuntimeLogIpcHandlers {
  return {
    getClaudeLogs: async (_event, teamName, query) => {
      const team = validateTeamName(teamName);
      if (!team.valid) {
        return { success: false, error: team.error ?? 'Invalid teamName' };
      }
      const normalizedQuery = normalizeClaudeLogsQuery(query);
      if (!normalizedQuery.valid) {
        return { success: false, error: normalizedQuery.error };
      }
      return executeTeamRuntimeOperation(feature.logger, 'getClaudeLogs', () =>
        feature.logs.getClaudeLogs(team.value!, normalizedQuery.value)
      );
    },
    getMemberLogs: async (_event, teamName, memberName) => {
      const team = validateTeamName(teamName);
      if (!team.valid) {
        return { success: false, error: team.error ?? 'Invalid teamName' };
      }
      const member = validateMemberName(memberName);
      if (!member.valid) {
        return { success: false, error: member.error ?? 'Invalid memberName' };
      }
      return executeTeamRuntimeOperation(feature.logger, 'getMemberLogs', () =>
        feature.logs.getMemberLogs(team.value!, member.value!)
      );
    },
    getLogsForTask: async (_event, teamName, taskId, options) => {
      const team = validateTeamName(teamName);
      if (!team.valid) {
        return { success: false, error: team.error ?? 'Invalid teamName' };
      }
      const task = validateTaskId(taskId);
      if (!task.valid) {
        return { success: false, error: task.error ?? 'Invalid taskId' };
      }
      const normalizedQuery = normalizeTaskLogQuery(options);
      if (!normalizedQuery.valid) {
        return { success: false, error: normalizedQuery.error };
      }
      return executeTeamRuntimeOperation(feature.logger, 'getLogsForTask', () =>
        feature.logs.getLogsForTask(team.value!, task.value!, normalizedQuery.value)
      );
    },
    getMemberStats: async (_event, teamName, memberName) => {
      const team = validateTeamName(teamName);
      if (!team.valid) {
        return { success: false, error: team.error ?? 'Invalid teamName' };
      }
      const member = validateMemberName(memberName);
      if (!member.valid) {
        return { success: false, error: member.error ?? 'Invalid memberName' };
      }
      return executeTeamRuntimeOperation(feature.logger, 'getMemberStats', () =>
        feature.logs.getMemberStats(team.value!, member.value!)
      );
    },
  };
}
