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

async function expectAttachToStartBeforeAddCompletes(
  attachStarted: Promise<void>,
  add: Promise<unknown>
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutMs = 2_000;

  try {
    await Promise.race([
      attachStarted,
      add.then(
        (result) => {
          throw new Error(
            `Add-member completed before attachLiveRosterMember started: ${JSON.stringify(result)}`
          );
        },
        (error: unknown) => {
          throw new Error(
            `Add-member rejected before attachLiveRosterMember started: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      ),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(
            new Error(
              `Timed out after ${timeoutMs}ms waiting for add-member to enter attachLiveRosterMember`
            )
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
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
    const stopFlow = vi.fn(async (_teamName: string, onAuthorized?: () => void) => {
      onAuthorized?.();
    });
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
      preflightMetadataMutation: vi.fn(async () => undefined),
      authorizeStopTeam: async (_teamName: string, onAuthorized: () => void) => onAuthorized(),
      stopTeam: vi.fn(async () => undefined),
      stopAuthorizedTeam: stopFlow,
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
      runtimeSelectionProvenance: {
        version: 1,
        providerBackendId: 'inherited',
        model: 'inherited',
        effort: 'inherited',
      },
    });
    await expectAttachToStartBeforeAddCompletes(attachStarted.promise, add);

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
