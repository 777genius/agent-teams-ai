import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getLocale: vi.fn(() => 'en'), getPath: vi.fn(() => '/tmp'), isPackaged: false },
  Notification: Object.assign(vi.fn(), { isSupported: vi.fn(() => false) }),
  BrowserWindow: { fromWebContents: vi.fn(() => null), getAllWindows: vi.fn(() => []) },
}));

vi.mock('@main/services/team/TeamMembersMetaStore', () => ({
  TeamMembersMetaStore: vi.fn().mockImplementation(() => ({
    getMeta: vi.fn(() => Promise.resolve(null)),
  })),
}));

vi.mock('@main/services/team/TeamDataWorkerClient', () => ({
  getTeamDataWorkerClient: () => ({
    invalidateTeamConfig: vi.fn(),
    invalidateTeamMessageFeed: vi.fn(),
    invalidateMemberRuntimeAdvisory: vi.fn(),
  }),
}));

import {
  createTeamRosterMutationFeature,
  registerTeamRosterMutationIpc,
  removeTeamRosterMutationIpc,
} from '../../../src/features/team-roster-mutations/main';
import {
  createTeamRuntimeOperationsFeature,
  registerTeamRuntimeOperationsIpc,
  removeTeamRuntimeOperationsIpc,
  type TeamRuntimeOperationsHostPorts,
} from '../../../src/features/team-runtime-operations/main';
import {
  initializeTeamHandlers,
  registerTeamHandlers,
  removeTeamHandlers,
} from '../../../src/main/ipc/teams';
import { TeamProvisioningService } from '../../../src/main/services/team/TeamProvisioningService';
import { TEAM_ADD_MEMBER, TEAM_STOP } from '../../../src/preload/constants/ipcChannels';

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

describe('team IPC roster mutation and stop concurrency', () => {
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  const ipcMain = {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
      handlers.set(channel, handler);
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel);
    }),
  };

  afterEach(() => {
    removeTeamHandlers(ipcMain as never);
    removeTeamRosterMutationIpc(ipcMain as never);
    removeTeamRuntimeOperationsIpc(ipcMain as never);
    handlers.clear();
    vi.restoreAllMocks();
  });

  it('keeps an IPC stop behind the complete live roster transaction', async () => {
    const lifecycleService = new TeamProvisioningService();
    const attachStarted = deferred();
    const releaseAttach = deferred();
    const stopFlow = vi.fn(() => Promise.resolve(undefined));
    const lifecycleInternals = lifecycleService as unknown as {
      memberLifecycleController: {
        attachLiveRosterMember(teamName: string, memberName: string): Promise<void>;
      };
      stopFlowBoundaryValue: unknown;
    };
    vi.spyOn(
      lifecycleInternals.memberLifecycleController,
      'attachLiveRosterMember'
    ).mockImplementation(async () => {
      attachStarted.resolve();
      await releaseAttach.promise;
    });
    lifecycleInternals.stopFlowBoundaryValue = {
      stopTeam: stopFlow,
      stopMixedSecondaryRuntimeLanes: vi.fn(() => Promise.resolve(undefined)),
      stopOpenCodeRuntimeAdapterTeam: vi.fn(() => Promise.resolve(undefined)),
    };

    const dataService = {
      getTeamData: vi.fn(() => Promise.resolve({ members: [] })),
      addMember: vi.fn(() => Promise.resolve(undefined)),
      invalidateMessageFeed: vi.fn(),
      invalidateTeamRuntimeAdvisories: vi.fn(),
    };
    const runtime = {
      getAliveTeams: () => ['ipc-lock-team'],
      stopTeam: lifecycleService.stopTeam.bind(lifecycleService),
      isTeamAlive: () => true,
    };
    initializeTeamHandlers(dataService as never, runtime as never);
    registerTeamHandlers(ipcMain as never);
    const runtimeOperationsHostPorts = {
      logs: {
        getClaudeLogs: () => Promise.resolve({ lines: [], total: 0, hasMore: false }),
        getRuntimeLogs: () => Promise.resolve({ lines: [], total: 0, hasMore: false }),
        findMemberLogs: () => Promise.resolve([]),
        findLogsForTask: () => Promise.resolve([]),
        getMemberStats: () =>
          Promise.resolve({
            linesAdded: 0,
            linesRemoved: 0,
            filesTouched: [],
            fileStats: {},
            toolUsage: {},
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            costUsd: 0,
            tasksCompleted: 0,
            messageCount: 0,
            totalDurationMs: 0,
            sessionCount: 0,
            computedAt: '2026-07-28T00:00:00.000Z',
          }),
      },
      runtime: {
        getAliveTeams: () => runtime.getAliveTeams(),
        stopTeam: (teamName) => runtime.stopTeam(teamName),
        isTeamAlive: () => runtime.isTeamAlive(),
      },
      lifecycle: {
        getMemberSpawnStatuses: () => Promise.resolve({ statuses: {}, runId: null, updatedAt: '' }),
        restartMember: () => Promise.resolve(),
        retryFailedRuntimeLanes: () =>
          Promise.resolve({
            attempted: [],
            confirmed: [],
            pending: [],
            failed: [],
            skipped: [],
          }),
        skipMemberForLaunch: () => Promise.resolve(),
      },
      diagnostics: {
        getLeadActivityState: () => ({ state: 'idle' as const, runId: null }),
        getLeadContextUsage: () => ({ usage: null, runId: null }),
        getTeamAgentRuntimeSnapshot: (teamName) =>
          Promise.resolve({ teamName, runId: null, updatedAt: '', members: {} }),
      },
      feed: {
        invalidateMessageFeed: (teamName) => dataService.invalidateMessageFeed(teamName),
      },
      processes: {
        findProcess: () => Promise.resolve(null),
        killProcess: () => Promise.resolve(),
      },
      messaging: {
        sendMessageToTeam: () => Promise.resolve(),
      },
      logger: { error: vi.fn(), warn: vi.fn() },
    } satisfies TeamRuntimeOperationsHostPorts;
    registerTeamRuntimeOperationsIpc(
      ipcMain as never,
      createTeamRuntimeOperationsFeature(runtimeOperationsHostPorts)
    );
    registerTeamRosterMutationIpc(
      ipcMain as never,
      createTeamRosterMutationFeature({
        repository: dataService as never,
        runtime: { isTeamAlive: () => true },
        lifecycle: {
          runLiveRosterMutation: lifecycleService.runLiveRosterMutation.bind(lifecycleService),
          attachLiveRosterMember: lifecycleService.attachLiveRosterMember.bind(lifecycleService),
          detachLiveRosterMember: vi.fn(() => Promise.resolve(undefined)),
        },
        messaging: { sendMessageToTeam: vi.fn(() => Promise.resolve(undefined)) },
        logger: { error: vi.fn(), warn: vi.fn() },
      })
    );

    const add = handlers.get(TEAM_ADD_MEMBER)!({} as never, 'ipc-lock-team', {
      name: 'alice',
      role: 'developer',
    });
    await attachStarted.promise;

    const stop = handlers.get(TEAM_STOP)!({} as never, 'ipc-lock-team');
    await Promise.resolve();
    await Promise.resolve();
    expect(stopFlow).not.toHaveBeenCalled();

    releaseAttach.resolve();
    await expect(add).resolves.toEqual({ success: true, data: undefined });
    await expect(stop).resolves.toEqual({ success: true, data: undefined });
    expect(stopFlow).toHaveBeenCalledOnce();
  });
});
