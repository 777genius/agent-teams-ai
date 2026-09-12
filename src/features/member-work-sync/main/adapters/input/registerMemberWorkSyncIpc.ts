import { validateMemberName, validateTeamName } from '@main/services/team/TeamIdentifierValidation';
import { createLogger } from '@shared/utils/logger';

import {
  MEMBER_WORK_SYNC_CONTINUE,
  MEMBER_WORK_SYNC_GET_METRICS,
  MEMBER_WORK_SYNC_GET_STATUS,
  MEMBER_WORK_SYNC_REFRESH_STATUS,
  MEMBER_WORK_SYNC_REPORT,
  MEMBER_WORK_SYNC_RESUME,
  MEMBER_WORK_SYNC_STOP,
  type MemberWorkSyncMetricsRequest,
  type MemberWorkSyncReportRequest,
  type MemberWorkSyncReportResult,
  type MemberWorkSyncReportState,
  type MemberWorkSyncStatus,
  type MemberWorkSyncStatusRequest,
  type MemberWorkSyncTeamMetrics,
} from '../../../contracts';

import type { MemberWorkSyncFeatureFacade } from '../../composition/createMemberWorkSyncFeature';
import type { IpcMain } from 'electron';

const logger = createLogger('Feature:MemberWorkSync:IPC');

function requireTeamName(teamName: unknown): string {
  const result = validateTeamName(teamName);
  if (!result.valid || result.value === undefined) {
    throw new Error(result.error ?? 'Invalid teamName');
  }
  return result.value;
}

function requireMemberName(memberName: unknown): string {
  const result = validateMemberName(memberName);
  if (!result.valid || result.value === undefined) {
    throw new Error(result.error ?? 'Invalid memberName');
  }
  return result.value;
}

function requireStatusIdentity(request: MemberWorkSyncStatusRequest): MemberWorkSyncStatusRequest {
  return {
    teamName: requireTeamName(request?.teamName),
    memberName: requireMemberName(request?.memberName),
  };
}

function isMemberWorkSyncReportState(value: string): value is MemberWorkSyncReportState {
  return value === 'still_working' || value === 'blocked' || value === 'caught_up';
}

function requireOptionalString(value: unknown, fieldName: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a string`);
  }
  return value;
}

function requireReportRequest(request: MemberWorkSyncReportRequest): MemberWorkSyncReportRequest {
  const identity = requireStatusIdentity(request);
  const state = typeof request?.state === 'string' ? request.state.trim() : '';
  const agendaFingerprint =
    typeof request?.agendaFingerprint === 'string' ? request.agendaFingerprint.trim() : '';
  if (!state || !agendaFingerprint) {
    throw new Error('state and agendaFingerprint are required');
  }
  if (!isMemberWorkSyncReportState(state)) {
    throw new Error('state must be still_working, blocked, or caught_up');
  }
  if (request?.taskIds !== undefined) {
    if (
      !Array.isArray(request.taskIds) ||
      request.taskIds.some((taskId) => typeof taskId !== 'string')
    ) {
      throw new Error('taskIds must be an array of strings');
    }
  }
  const taskIds = Array.isArray(request?.taskIds)
    ? [...new Set(request.taskIds.map((taskId) => taskId.trim()).filter(Boolean))]
    : undefined;
  const source = request?.source;
  if (source !== undefined && source !== 'mcp' && source !== 'app' && source !== 'test') {
    throw new Error('source must be mcp, app, or test');
  }
  const note = requireOptionalString(request?.note, 'note');
  const reportToken = requireOptionalString(request?.reportToken, 'reportToken');
  const reportedAt = requireOptionalString(request?.reportedAt, 'reportedAt');
  const leaseTtlMs = request?.leaseTtlMs;
  if (leaseTtlMs !== undefined && typeof leaseTtlMs !== 'number') {
    throw new Error('leaseTtlMs must be a number');
  }
  return {
    ...identity,
    state,
    agendaFingerprint,
    ...(reportToken !== undefined ? { reportToken } : {}),
    ...(taskIds?.length ? { taskIds } : {}),
    ...(note !== undefined ? { note } : {}),
    ...(reportedAt !== undefined ? { reportedAt } : {}),
    ...(typeof leaseTtlMs === 'number' ? { leaseTtlMs } : {}),
    ...(source ? { source } : {}),
  };
}

export function registerMemberWorkSyncIpc(
  ipcMain: IpcMain,
  feature: MemberWorkSyncFeatureFacade
): void {
  ipcMain.handle(
    MEMBER_WORK_SYNC_GET_STATUS,
    async (_event, request: MemberWorkSyncStatusRequest): Promise<MemberWorkSyncStatus> => {
      try {
        return await feature.getStatus(requireStatusIdentity(request));
      } catch (error) {
        logger.error('Failed to get member work sync status', error);
        throw error;
      }
    }
  );

  ipcMain.handle(
    MEMBER_WORK_SYNC_GET_METRICS,
    async (_event, request: MemberWorkSyncMetricsRequest): Promise<MemberWorkSyncTeamMetrics> => {
      try {
        return await feature.getMetrics({ teamName: requireTeamName(request?.teamName) });
      } catch (error) {
        logger.error('Failed to get member work sync metrics', error);
        throw error;
      }
    }
  );

  ipcMain.handle(
    MEMBER_WORK_SYNC_REFRESH_STATUS,
    async (_event, request: MemberWorkSyncStatusRequest): Promise<MemberWorkSyncStatus> => {
      try {
        return await feature.refreshStatus(requireStatusIdentity(request));
      } catch (error) {
        logger.error('Failed to refresh member work sync status', error);
        throw error;
      }
    }
  );

  ipcMain.handle(
    MEMBER_WORK_SYNC_REPORT,
    async (_event, request: MemberWorkSyncReportRequest): Promise<MemberWorkSyncReportResult> => {
      try {
        return await feature.report(requireReportRequest(request));
      } catch (error) {
        logger.error('Failed to submit member work sync report', error);
        throw error;
      }
    }
  );

  ipcMain.handle(
    MEMBER_WORK_SYNC_STOP,
    async (
      _event,
      request: MemberWorkSyncStatusRequest & { reason?: string }
    ): Promise<MemberWorkSyncStatus> => {
      try {
        const identity = requireStatusIdentity(request);
        return await feature.stopAutoResume({
          ...identity,
          ...(request.reason ? { reason: request.reason } : {}),
        });
      } catch (error) {
        logger.error('Failed to stop member work sync auto-resume', error);
        throw error;
      }
    }
  );

  ipcMain.handle(
    MEMBER_WORK_SYNC_RESUME,
    async (_event, request: MemberWorkSyncStatusRequest): Promise<MemberWorkSyncStatus> => {
      try {
        return await feature.resumeAutoResume(requireStatusIdentity(request));
      } catch (error) {
        logger.error('Failed to resume member work sync auto-resume', error);
        throw error;
      }
    }
  );

  ipcMain.handle(
    MEMBER_WORK_SYNC_CONTINUE,
    async (
      _event,
      request: MemberWorkSyncStatusRequest & { idempotencyKey?: string }
    ): Promise<MemberWorkSyncStatus> => {
      try {
        const identity = requireStatusIdentity(request);
        return await feature.continueManually({
          ...identity,
          ...(request.idempotencyKey ? { idempotencyKey: request.idempotencyKey } : {}),
        });
      } catch (error) {
        logger.error('Failed to continue member work sync', error);
        throw error;
      }
    }
  );
}

export function removeMemberWorkSyncIpc(ipcMain: IpcMain): void {
  ipcMain.removeHandler(MEMBER_WORK_SYNC_GET_STATUS);
  ipcMain.removeHandler(MEMBER_WORK_SYNC_REFRESH_STATUS);
  ipcMain.removeHandler(MEMBER_WORK_SYNC_GET_METRICS);
  ipcMain.removeHandler(MEMBER_WORK_SYNC_REPORT);
  ipcMain.removeHandler(MEMBER_WORK_SYNC_STOP);
  ipcMain.removeHandler(MEMBER_WORK_SYNC_RESUME);
  ipcMain.removeHandler(MEMBER_WORK_SYNC_CONTINUE);
}
