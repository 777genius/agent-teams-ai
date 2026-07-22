import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getLocale: vi.fn(() => 'en'), getPath: vi.fn(() => '/tmp'), isPackaged: false },
  Notification: Object.assign(vi.fn(), { isSupported: vi.fn(() => false) }),
  BrowserWindow: { fromWebContents: vi.fn(() => null), getAllWindows: vi.fn(() => []) },
}));

vi.mock('@main/services/team/TeamMembersMetaStore', () => ({
  TeamMembersMetaStore: vi.fn().mockImplementation(() => ({
    getMeta: vi.fn(async () => null),
  })),
}));

vi.mock('@main/services/team/TeamDataWorkerClient', () => ({
  getTeamDataWorkerClient: () => ({
    invalidateTeamConfig: vi.fn(),
    invalidateMemberRuntimeAdvisory: vi.fn(),
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
