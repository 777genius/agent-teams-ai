import { afterEach, describe, expect, it, vi } from 'vitest';

import * as stopFlows from '../../../src/main/services/team/lifecycle/teamForceStopFlow';
import { projectOpenCodeStateChangingFailure } from '../../../src/main/services/team/opencode/bridge/OpenCodeStateChangingBridgeCommandService';
import { OpenCodeRuntimeStopUnconfirmedError } from '../../../src/main/services/team/provisioning/TeamProvisioningOpenCodeRuntimeStopOutcome';

vi.mock('electron', () => ({
  app: { getLocale: () => 'en', getPath: () => '/tmp', isPackaged: false },
  Notification: Object.assign(class {}, { isSupported: () => false }),
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
}));

// Plain class stubs survive vi.restoreAllMocks() in afterEach; vi.fn-based
// factories lose their implementation and hang the roster mutation path.
vi.mock('@main/services/team/TeamMembersMetaStore', () => ({
  TeamMembersMetaStore: class {
    getMeta(): Promise<null> {
      return Promise.resolve(null);
    }
  },
}));

vi.mock('@main/services/team/TeamDataWorkerClient', () => ({
  getTeamDataWorkerClient: () => ({
    invalidateTeamConfig: () => undefined,
    invalidateMemberRuntimeAdvisory: () => undefined,
  }),
}));

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
    handlers.clear();
    vi.restoreAllMocks();
  });

  it('returns the original finite stop cause through the real stop handler without a false acknowledgement', async () => {
    const causalFailure = projectOpenCodeStateChangingFailure(
      Object.assign(new Error('TEST-private never-publish'), { code: 'EPERM' })
    );
    const originalStop = stopFlows.stopTeamWithEscalation;
    vi.spyOn(stopFlows, 'stopTeamWithEscalation').mockImplementation((name, ports) =>
      originalStop(name, {
        ...ports,
        observeOwnedRuntimeRunIds: async () => [],
        observeOwnedRuntimeLaneIds: async () => [],
        killRetainedRuntimeProcesses: async () => ({ killedPids: [], diagnostics: [] }),
        clearPendingPromptDeliveries: async () => ({ cleared: 0, diagnostics: [] }),
        reapOwnedLeadProcessTrees: undefined,
        releaseSharedRuntimeResources: undefined,
        markTeamStopped: undefined,
      })
    );
    initializeTeamHandlers(
      { invalidateMessageFeed: vi.fn(), invalidateTeamRuntimeAdvisories: vi.fn() } as never,
      {
        runtime: {
          stopTeam: async () => {
            throw new OpenCodeRuntimeStopUnconfirmedError(
              'Stop unconfirmed',
              ['error:internal_error:fixed'],
              causalFailure
            );
          },
          isTeamAlive: () => false,
          getAliveTeams: () => [],
        },
      } as never
    );
    registerTeamHandlers(ipcMain as never);
    const result = await handlers.get(TEAM_STOP)!({} as never, 'test-stop-cause');
    expect(result).toMatchObject({ success: false });
    const messageOnly = new Error((result as { error: string }).error);
    const [prefix, suffix] = messageOnly.message.split('\nOPENCODE_STOP_CAUSE_V1=');
    expect(prefix).toBe('team_stop_unconfirmed:stop_failed:internal_error');
    expect(JSON.parse(suffix)).toMatchObject({ phase: 'unclassified', errno: 'EPERM' });
    expect(messageOnly).not.toHaveProperty('details');
    expect(JSON.stringify(result)).not.toMatch(/TEST-private|never-publish/);
  });

  it('keeps an IPC stop behind the complete live roster transaction', async () => {
    const lifecycleService = new TeamProvisioningService();
    const attachStarted = deferred();
    const releaseAttach = deferred();
    const stopFlow = vi.fn(async () => undefined);
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
      stopMixedSecondaryRuntimeLanes: vi.fn(async () => undefined),
      stopOpenCodeRuntimeAdapterTeam: vi.fn(async () => undefined),
    };

    const dataService = {
      getTeamData: vi.fn(async () => ({ members: [] })),
      addMember: vi.fn(async () => undefined),
      invalidateMessageFeed: vi.fn(),
      invalidateTeamRuntimeAdvisories: vi.fn(),
    };
    initializeTeamHandlers(
      dataService as never,
      {
        runtime: {
          stopTeam: lifecycleService.stopTeam.bind(lifecycleService),
          isTeamAlive: () => true,
          getAliveTeams: () => [],
        },
        memberLifecycle: {
          runLiveRosterMutation: lifecycleService.runLiveRosterMutation.bind(lifecycleService),
          attachLiveRosterMember: lifecycleService.attachLiveRosterMember.bind(lifecycleService),
        },
      } as never
    );
    registerTeamHandlers(ipcMain as never);

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
