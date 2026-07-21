import {
  MEMBER_WORK_SYNC_GET_METRICS,
  MEMBER_WORK_SYNC_GET_STATUS,
  MEMBER_WORK_SYNC_REFRESH_STATUS,
  MEMBER_WORK_SYNC_REPORT,
} from '@features/member-work-sync/contracts';
import {
  registerMemberWorkSyncIpc,
  removeMemberWorkSyncIpc,
} from '@features/member-work-sync/main';
import { describe, expect, it, vi } from 'vitest';

import type {
  MemberWorkSyncMetricsRequest,
  MemberWorkSyncReportRequest,
  MemberWorkSyncStatusRequest,
} from '@features/member-work-sync/contracts';
import type { MemberWorkSyncFeatureFacade } from '@features/member-work-sync/main';
import type { IpcMain } from 'electron';

vi.mock('@shared/utils/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  }),
}));

type IpcHandler = (event: unknown, request: unknown) => Promise<unknown>;

function makeIpcMain() {
  const handlers = new Map<string, IpcHandler>();
  const ipcMain = {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      handlers.set(channel, handler);
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel);
    }),
  };

  return { handlers, ipcMain: ipcMain as unknown as IpcMain };
}

function makeFeature(): MemberWorkSyncFeatureFacade {
  return {
    getStatus: vi.fn(async (request) => ({
      teamName: request.teamName,
      memberName: request.memberName,
      state: 'unknown' as const,
      agenda: {
        teamName: request.teamName,
        memberName: request.memberName,
        generatedAt: '2026-04-29T00:00:00.000Z',
        fingerprint: 'agenda:v1:test',
        items: [],
        diagnostics: [],
      },
      evaluatedAt: '2026-04-29T00:00:00.000Z',
      diagnostics: [],
    })),
    refreshStatus: vi.fn(async (request) => ({
      teamName: request.teamName,
      memberName: request.memberName,
      state: 'needs_sync' as const,
      agenda: {
        teamName: request.teamName,
        memberName: request.memberName,
        generatedAt: '2026-04-29T00:00:00.000Z',
        fingerprint: 'agenda:v1:test',
        items: [],
        diagnostics: [],
      },
      evaluatedAt: '2026-04-29T00:00:00.000Z',
      diagnostics: [],
    })),
    getMetrics: vi.fn(async (request) => ({
      teamName: request.teamName,
      generatedAt: '2026-04-29T00:00:00.000Z',
      memberCount: 0,
      stateCounts: {
        blocked: 0,
        caught_up: 0,
        inactive: 0,
        needs_sync: 0,
        still_working: 0,
        unknown: 0,
      },
      actionableItemCount: 0,
      wouldNudgeCount: 0,
      fingerprintChangeCount: 0,
      reportAcceptedCount: 0,
      reportRejectedCount: 0,
      recentEvents: [],
      deliveryReadiness: {
        state: 'collecting_shadow_data' as const,
        reasons: ['insufficient_members' as const],
        thresholds: {
          maxFingerprintChangesPerMemberHour: 4,
          maxReportRejectionRate: 0.2,
          maxWouldNudgesPerMemberHour: 2,
          minObservationHours: 24,
          minObservedMembers: 3,
          minStatusEvents: 20,
        },
        rates: {
          fingerprintChangesPerMemberHour: 0,
          observationHours: 0,
          reportRejectionRate: 0,
          statusEventCount: 0,
          wouldNudgesPerMemberHour: 0,
        },
        diagnostics: [],
      },
    })),
    report: vi.fn(async (request) => ({
      accepted: true,
      code: 'accepted',
      message: 'Report accepted.',
      status: {
        teamName: request.teamName,
        memberName: request.memberName,
        state: request.state,
        agenda: {
          teamName: request.teamName,
          memberName: request.memberName,
          generatedAt: '2026-04-29T00:00:00.000Z',
          fingerprint: request.agendaFingerprint,
          items: [],
          diagnostics: [],
        },
        evaluatedAt: '2026-04-29T00:00:00.000Z',
        diagnostics: [],
      },
    })),
    scheduleProofMissingRecovery: vi.fn(async () => ({
      scheduled: true,
      reason: 'scheduled' as const,
    })),
    noteTeamChange: vi.fn(),
    enqueueStartupScan: vi.fn(),
    replayPendingReports: vi.fn(),
    dispatchDueNudges: vi.fn(),
    buildRuntimeTurnSettledHookSettings: vi.fn(),
    buildRuntimeTurnSettledEnvironment: vi.fn(),
    drainRuntimeTurnSettledEvents: vi.fn(),
    getQueueDiagnostics: vi.fn(),
    dispose: vi.fn(),
  };
}

describe('registerMemberWorkSyncIpc', () => {
  it('registers status, metrics and report handlers that delegate requests unchanged', async () => {
    const { handlers, ipcMain } = makeIpcMain();
    const feature = makeFeature();

    registerMemberWorkSyncIpc(ipcMain, feature);

    expect(ipcMain.handle).toHaveBeenCalledTimes(4);
    expect([...handlers.keys()].sort()).toEqual(
      [
        MEMBER_WORK_SYNC_GET_METRICS,
        MEMBER_WORK_SYNC_GET_STATUS,
        MEMBER_WORK_SYNC_REFRESH_STATUS,
        MEMBER_WORK_SYNC_REPORT,
      ].sort()
    );

    const statusRequest: MemberWorkSyncStatusRequest = { teamName: 'team-a', memberName: 'bob' };
    const metricsRequest: MemberWorkSyncMetricsRequest = { teamName: 'team-a' };
    const reportRequest: MemberWorkSyncReportRequest = {
      teamName: 'team-a',
      memberName: 'bob',
      state: 'still_working',
      agendaFingerprint: 'agenda:v1:test',
    };

    await expect(
      handlers.get(MEMBER_WORK_SYNC_GET_STATUS)?.({}, statusRequest)
    ).resolves.toMatchObject({ teamName: 'team-a', memberName: 'bob' });
    await expect(
      handlers.get(MEMBER_WORK_SYNC_REFRESH_STATUS)?.({}, statusRequest)
    ).resolves.toMatchObject({ teamName: 'team-a', memberName: 'bob', state: 'needs_sync' });
    await expect(
      handlers.get(MEMBER_WORK_SYNC_GET_METRICS)?.({}, metricsRequest)
    ).resolves.toMatchObject({ teamName: 'team-a' });
    await expect(handlers.get(MEMBER_WORK_SYNC_REPORT)?.({}, reportRequest)).resolves.toMatchObject(
      { accepted: true, code: 'accepted' }
    );

    expect(feature.getStatus).toHaveBeenCalledWith(statusRequest);
    expect(feature.refreshStatus).toHaveBeenCalledWith(statusRequest);
    expect(feature.getMetrics).toHaveBeenCalledWith(metricsRequest);
    expect(feature.report).toHaveBeenCalledWith(reportRequest);
  });

  it('propagates feature errors so the renderer receives the real status failure', async () => {
    const { handlers, ipcMain } = makeIpcMain();
    const feature = makeFeature();
    const failure = new Error('status failed');
    vi.mocked(feature.getStatus).mockRejectedValueOnce(failure);

    registerMemberWorkSyncIpc(ipcMain, feature);

    await expect(
      handlers.get(MEMBER_WORK_SYNC_GET_STATUS)?.({}, { teamName: 'team-a', memberName: 'bob' })
    ).rejects.toThrow('status failed');
  });

  it('propagates metrics and report errors without replacing them', async () => {
    const { handlers, ipcMain } = makeIpcMain();
    const feature = makeFeature();
    vi.mocked(feature.getMetrics).mockRejectedValueOnce(new Error('metrics failed'));
    vi.mocked(feature.report).mockRejectedValueOnce(new Error('report failed'));

    registerMemberWorkSyncIpc(ipcMain, feature);

    await expect(
      handlers.get(MEMBER_WORK_SYNC_GET_METRICS)?.({}, { teamName: 'team-a' })
    ).rejects.toThrow('metrics failed');
    await expect(
      handlers.get(MEMBER_WORK_SYNC_REPORT)?.(
        {},
        {
          teamName: 'team-a',
          memberName: 'bob',
          state: 'blocked',
          agendaFingerprint: 'agenda:v1:test',
        }
      )
    ).rejects.toThrow('report failed');
  });

  it('removes exactly the member work sync handlers', () => {
    const { handlers, ipcMain } = makeIpcMain();
    const feature = makeFeature();
    registerMemberWorkSyncIpc(ipcMain, feature);
    handlers.set('unrelated:channel', vi.fn());

    removeMemberWorkSyncIpc(ipcMain);

    expect(ipcMain.removeHandler).toHaveBeenCalledTimes(4);
    expect(ipcMain.removeHandler).toHaveBeenCalledWith(MEMBER_WORK_SYNC_GET_STATUS);
    expect(ipcMain.removeHandler).toHaveBeenCalledWith(MEMBER_WORK_SYNC_REFRESH_STATUS);
    expect(ipcMain.removeHandler).toHaveBeenCalledWith(MEMBER_WORK_SYNC_GET_METRICS);
    expect(ipcMain.removeHandler).toHaveBeenCalledWith(MEMBER_WORK_SYNC_REPORT);
    expect([...handlers.keys()]).toEqual(['unrelated:channel']);
  });
});
