import { describe, expect, it, vi } from 'vitest';

import {
  MEMBER_WORK_SYNC_CONTINUE,
  MEMBER_WORK_SYNC_GET_METRICS,
  MEMBER_WORK_SYNC_GET_STATUS,
  MEMBER_WORK_SYNC_REFRESH_STATUS,
  MEMBER_WORK_SYNC_REPORT,
  MEMBER_WORK_SYNC_RESUME,
  MEMBER_WORK_SYNC_STOP,
} from '@features/member-work-sync/contracts';
import { createMemberWorkSyncBridge } from '@features/member-work-sync/preload';

import type {
  MemberWorkSyncMetricsRequest,
  MemberWorkSyncReportRequest,
  MemberWorkSyncStatusRequest,
} from '@features/member-work-sync/contracts';
import type { IpcRenderer } from 'electron';

describe('createMemberWorkSyncBridge', () => {
  it('invokes the status channel without changing the request payload', async () => {
    const request: MemberWorkSyncStatusRequest = { teamName: 'team-a', memberName: 'bob' };
    const response = { ok: true };
    const ipcRenderer = {
      invoke: vi.fn(async () => response),
    } as unknown as IpcRenderer;
    const bridge = createMemberWorkSyncBridge(ipcRenderer);

    await expect(bridge.getStatus(request)).resolves.toBe(response);

    expect(ipcRenderer.invoke).toHaveBeenCalledWith(MEMBER_WORK_SYNC_GET_STATUS, request);
  });

  it('invokes the metrics channel without changing the request payload', async () => {
    const request: MemberWorkSyncMetricsRequest = { teamName: 'team-a' };
    const response = { ok: true };
    const ipcRenderer = {
      invoke: vi.fn(async () => response),
    } as unknown as IpcRenderer;
    const bridge = createMemberWorkSyncBridge(ipcRenderer);

    await expect(bridge.getMetrics(request)).resolves.toBe(response);

    expect(ipcRenderer.invoke).toHaveBeenCalledWith(MEMBER_WORK_SYNC_GET_METRICS, request);
  });

  it('invokes the refresh status channel without changing the request payload', async () => {
    const request: MemberWorkSyncStatusRequest = { teamName: 'team-a', memberName: 'bob' };
    const response = { ok: true };
    const ipcRenderer = {
      invoke: vi.fn(async () => response),
    } as unknown as IpcRenderer;
    const bridge = createMemberWorkSyncBridge(ipcRenderer);

    await expect(bridge.refreshStatus(request)).resolves.toBe(response);

    expect(ipcRenderer.invoke).toHaveBeenCalledWith(MEMBER_WORK_SYNC_REFRESH_STATUS, request);
  });

  it('invokes the report channel without changing the request payload', async () => {
    const request: MemberWorkSyncReportRequest = {
      teamName: 'team-a',
      memberName: 'bob',
      state: 'blocked',
      agendaFingerprint: 'agenda:v1:test',
      taskIds: ['task-1'],
      note: 'waiting on reviewer',
      source: 'app',
    };
    const response = { accepted: true };
    const ipcRenderer = {
      invoke: vi.fn(async () => response),
    } as unknown as IpcRenderer;
    const bridge = createMemberWorkSyncBridge(ipcRenderer);

    await expect(bridge.report(request)).resolves.toBe(response);

    expect(ipcRenderer.invoke).toHaveBeenCalledWith(MEMBER_WORK_SYNC_REPORT, request);
  });

  it('invokes stop, resume, and continue channels without changing the request payload', async () => {
    const request = { teamName: 'team-a', memberName: 'bob' };
    const response = { ok: true };
    const ipcRenderer = {
      invoke: vi.fn(async () => response),
    } as unknown as IpcRenderer;
    const bridge = createMemberWorkSyncBridge(ipcRenderer);

    await expect(bridge.stopAutoResume({ ...request, reason: 'user_stop' })).resolves.toBe(response);
    await expect(bridge.resumeAutoResume(request)).resolves.toBe(response);
    await expect(bridge.continueManually({ ...request, idempotencyKey: 'k1' })).resolves.toBe(
      response
    );

    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(1, MEMBER_WORK_SYNC_STOP, {
      ...request,
      reason: 'user_stop',
    });
    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(2, MEMBER_WORK_SYNC_RESUME, request);
    expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(3, MEMBER_WORK_SYNC_CONTINUE, {
      ...request,
      idempotencyKey: 'k1',
    });
  });

  it('propagates IPC rejections to the renderer caller', async () => {
    const failure = new Error('ipc failed');
    const ipcRenderer = {
      invoke: vi.fn(async () => {
        throw failure;
      }),
    } as unknown as IpcRenderer;
    const bridge = createMemberWorkSyncBridge(ipcRenderer);

    await expect(bridge.getStatus({ teamName: 'team-a', memberName: 'bob' })).rejects.toBe(failure);
  });
});
