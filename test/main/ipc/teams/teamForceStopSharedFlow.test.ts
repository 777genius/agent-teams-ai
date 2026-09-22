import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

const forceStopFlowMocks = vi.hoisted(() => ({
  runTeamForceStopFlow: vi.fn(async () => ({
    stopOutcome: 'stopped' as const,
    cleanupOutcome: 'completed' as const,
    killedRuntimePids: [],
    clearedPendingDeliveries: 0,
    diagnostics: [],
  })),
  killRetainedOpenCodeRuntimeProcessesForTeam: vi.fn(async () => ({
    killedPids: [],
    diagnostics: [],
  })),
  clearPendingOpenCodePromptDeliveriesForTeam: vi.fn(async () => ({
    cleared: 0,
    diagnostics: [],
  })),
  readOpenCodeRuntimeLaneIdsForTeam: vi.fn(async () => ['primary']),
  readOwnedOpenCodeRuntimeRunIdsForTeam: vi.fn(() => Promise.resolve(['run-observed'])),
}));

vi.mock('@main/services/team/lifecycle/teamForceStopFlow', () => forceStopFlowMocks);

import {
  createTeamRuntimeOperationsFeature,
  registerTeamRuntimeOperationsIpc,
  removeTeamRuntimeOperationsIpc,
  type TeamRuntimeOperationsHostPorts,
} from '@features/team-runtime-operations/main';
import { TeamApplicationHost } from '@main/composition/team/TeamApplicationHost';
import { registerTeamRoutes } from '@main/http/teams';
import Fastify from 'fastify';

import {
  initializeTeamHandlers,
  registerTeamHandlers,
  removeTeamHandlers,
} from '../../../../src/main/ipc/teams';
import { TEAM_FORCE_STOP } from '../../../../src/preload/constants/ipcChannels';
import { MainTeamRuntimeStop } from '../../../../src/main/ipc/teams/MainTeamRuntimeStop';

import type { HttpServices } from '@main/http';
import type { TeamForceStopFlowPorts } from '@main/services/team/lifecycle/teamForceStopFlow';

/**
 * Force stop has two entry points - the in-app IPC handler and the HTTP route -
 * and they must be two callers of one flow, not two implementations of the
 * same idea. This asserts that: both reach `runTeamForceStopFlow` once, with
 * the same team name, and with ports that delegate to the same places.
 */
describe('force stop shares one flow between the IPC handler and the HTTP route', () => {
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  const ipcMain = {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
      handlers.set(channel, handler);
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel);
    }),
  };

  const stopTeam = vi.fn(async () => undefined);
  const getAliveTeams = vi.fn(() => ['fixteam', 'other-team']);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    removeTeamHandlers(ipcMain as never);
    removeTeamRuntimeOperationsIpc(ipcMain as never);
    handlers.clear();
  });

  function registerRuntimeOperations(): void {
    const runtimeStop = new MainTeamRuntimeStop(
      { stopTeam, getAliveTeams },
      { info: vi.fn(), warn: vi.fn() }
    );
    const ports = {
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
            computedAt: '2026-01-01T00:00:00.000Z',
          }),
      },
      runtime: {
        getAliveTeams,
        stopTeam,
        forceStopTeam: (teamName: string) => runtimeStop.forceStopTeam(teamName),
        isTeamAlive: () => true,
      },
      lifecycle: {
        getMemberSpawnStatuses: () => Promise.resolve({ statuses: {}, runId: null, updatedAt: '' }),
        restartMember: () => Promise.resolve(),
        retryFailedRuntimeLanes: () =>
          Promise.resolve({ attempted: [], confirmed: [], pending: [], failed: [], skipped: [] }),
        skipMemberForLaunch: () => Promise.resolve(),
      },
      diagnostics: {
        getLeadActivityState: () => ({ state: 'idle' as const, runId: null }),
        getLeadContextUsage: () => ({ usage: null, runId: null }),
        getTeamAgentRuntimeSnapshot: (teamName: string) =>
          Promise.resolve({ teamName, runId: null, updatedAt: '', members: {} }),
      },
      feed: { invalidateMessageFeed: () => undefined },
      processes: { findProcess: () => Promise.resolve(null), killProcess: () => Promise.resolve() },
      messaging: { sendMessageToTeam: () => Promise.resolve() },
      logger: { error: vi.fn(), warn: vi.fn() },
    } satisfies TeamRuntimeOperationsHostPorts;
    registerTeamRuntimeOperationsIpc(ipcMain as never, createTeamRuntimeOperationsFeature(ports));
  }

  async function callThroughIpc(): Promise<void> {
    initializeTeamHandlers(
      { getTeamData: vi.fn(async () => ({ members: [] })) } as never,
      { runtime: { stopTeam, getAliveTeams, isTeamAlive: () => true } } as never
    );
    registerTeamHandlers(ipcMain as never);
    registerRuntimeOperations();
    await expect(handlers.get(TEAM_FORCE_STOP)!({} as never, 'fixteam')).resolves.toMatchObject({
      success: true,
    });
  }

  async function callThroughHttp(): Promise<void> {
    const app = Fastify();
    const services = {
      teamApis: { runtime: { stopTeam, getAliveTeams, getRuntimeState: vi.fn() } },
      teamApplicationHost: new TeamApplicationHost({
        configPresence: { hasConfig: () => Promise.resolve(true) },
        listInvalidation: { invalidate: () => undefined },
        runtime: { stopTeam, getAliveTeams, getRuntimeState: vi.fn() },
      }),
    } as unknown as HttpServices;
    registerTeamRoutes(app, services);
    await app.ready();
    const response = await app.inject({ method: 'POST', url: '/api/teams/fixteam/force-stop' });
    expect(response.statusCode).toBe(200);
    await app.close();
  }

  it('calls the shared flow exactly once from each entry point, with the same arguments', async () => {
    await callThroughIpc();
    await callThroughHttp();

    expect(forceStopFlowMocks.runTeamForceStopFlow).toHaveBeenCalledTimes(2);
    const [ipcCall, httpCall] = forceStopFlowMocks.runTeamForceStopFlow.mock.calls as unknown as [
      [string, TeamForceStopFlowPorts],
      [string, TeamForceStopFlowPorts],
    ];
    expect(ipcCall[0]).toBe('fixteam');
    expect(httpCall[0]).toBe('fixteam');

    for (const [, ports] of [ipcCall, httpCall]) {
      await ports.stopTeam('fixteam');
      await ports.observeOwnedRuntimeRunIds('fixteam');
      await ports.killRetainedRuntimeProcesses('fixteam', {
        requestedAtMs: 1_700_000_000_000,
      });
      await ports.clearPendingPromptDeliveries('fixteam', {
        requestedAtMs: 1_700_000_000_000,
        ownedRunIds: ['run-observed'],
      });
    }

    expect(stopTeam).toHaveBeenCalledTimes(2);
    expect(stopTeam).toHaveBeenNthCalledWith(1, 'fixteam');
    expect(stopTeam).toHaveBeenNthCalledWith(2, 'fixteam');
    // The team being stopped is never one of its own "other alive teams".
    expect(forceStopFlowMocks.killRetainedOpenCodeRuntimeProcessesForTeam.mock.calls).toEqual([
      [
        {
          teamName: 'fixteam',
          requestedAtMs: 1_700_000_000_000,
          otherAliveTeams: ['other-team'],
        },
      ],
      [
        {
          teamName: 'fixteam',
          requestedAtMs: 1_700_000_000_000,
          otherAliveTeams: ['other-team'],
        },
      ],
    ]);
    // Both entry points read the run ids the cleanup is fenced to, and both
    // hand the flow's fence straight through to it.
    expect(forceStopFlowMocks.readOwnedOpenCodeRuntimeRunIdsForTeam.mock.calls).toEqual([
      [{ teamName: 'fixteam' }],
      [{ teamName: 'fixteam' }],
    ]);
    expect(forceStopFlowMocks.clearPendingOpenCodePromptDeliveriesForTeam.mock.calls).toEqual([
      [
        {
          teamName: 'fixteam',
          requestedAtMs: 1_700_000_000_000,
          ownedRunIds: ['run-observed'],
          ownedLaneIds: undefined,
        },
      ],
      [
        {
          teamName: 'fixteam',
          requestedAtMs: 1_700_000_000_000,
          ownedRunIds: ['run-observed'],
          ownedLaneIds: undefined,
        },
      ],
    ]);
  });
});
