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
  type MemberWorkSyncStatus,
  type MemberWorkSyncStatusRequest,
  type MemberWorkSyncTeamMetrics,
} from '../../../contracts';

import type { MemberWorkSyncFeatureFacade } from '../../composition/createMemberWorkSyncFeature';
import type { IpcMain } from 'electron';

const logger = createLogger('Feature:MemberWorkSync:IPC');

export function registerMemberWorkSyncIpc(
  ipcMain: IpcMain,
  feature: MemberWorkSyncFeatureFacade
): void {
  ipcMain.handle(
    MEMBER_WORK_SYNC_GET_STATUS,
    async (_event, request: MemberWorkSyncStatusRequest): Promise<MemberWorkSyncStatus> => {
      try {
        return await feature.getStatus(request);
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
        return await feature.getMetrics(request);
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
        return await feature.refreshStatus(request);
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
        return await feature.report(request);
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
        return await feature.stopAutoResume(request);
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
        return await feature.resumeAutoResume(request);
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
        return await feature.continueManually(request);
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
