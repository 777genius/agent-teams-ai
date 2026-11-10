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
} from '../contracts';

import type { IpcRenderer } from 'electron';

export interface MemberWorkSyncElectronApi {
  getStatus(request: MemberWorkSyncStatusRequest): Promise<MemberWorkSyncStatus>;
  refreshStatus(request: MemberWorkSyncStatusRequest): Promise<MemberWorkSyncStatus>;
  getMetrics(request: MemberWorkSyncMetricsRequest): Promise<MemberWorkSyncTeamMetrics>;
  report(request: MemberWorkSyncReportRequest): Promise<MemberWorkSyncReportResult>;
  stopAutoResume(
    request: MemberWorkSyncStatusRequest & { reason?: string }
  ): Promise<MemberWorkSyncStatus>;
  resumeAutoResume(request: MemberWorkSyncStatusRequest): Promise<MemberWorkSyncStatus>;
  continueManually(
    request: MemberWorkSyncStatusRequest & { idempotencyKey?: string }
  ): Promise<MemberWorkSyncStatus>;
}

export function createMemberWorkSyncBridge(ipcRenderer: IpcRenderer): MemberWorkSyncElectronApi {
  return {
    getStatus: (request) => ipcRenderer.invoke(MEMBER_WORK_SYNC_GET_STATUS, request),
    refreshStatus: (request) => ipcRenderer.invoke(MEMBER_WORK_SYNC_REFRESH_STATUS, request),
    getMetrics: (request) => ipcRenderer.invoke(MEMBER_WORK_SYNC_GET_METRICS, request),
    report: (request) => ipcRenderer.invoke(MEMBER_WORK_SYNC_REPORT, request),
    stopAutoResume: (request) => ipcRenderer.invoke(MEMBER_WORK_SYNC_STOP, request),
    resumeAutoResume: (request) => ipcRenderer.invoke(MEMBER_WORK_SYNC_RESUME, request),
    continueManually: (request) => ipcRenderer.invoke(MEMBER_WORK_SYNC_CONTINUE, request),
  };
}
