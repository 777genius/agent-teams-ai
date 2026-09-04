import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    invalidateMemberRuntimeAdvisory: vi.fn(),
  }),
}));

const stopFlowMocks = vi.hoisted(() => ({
  stopTeamWithEscalation: vi.fn(() =>
    Promise.resolve({
      stopOutcome: 'stopped' as const,
      killedRuntimePids: [],
      clearedPendingDeliveries: 0,
      diagnostics: [],
    })
  ),
  runTeamForceStopFlow: vi.fn(() =>
    Promise.resolve({
      stopOutcome: 'stopped' as const,
      killedRuntimePids: [],
      clearedPendingDeliveries: 0,
      diagnostics: [],
    })
  ),
  killRetainedOpenCodeRuntimeProcessesForTeam: vi.fn(() =>
    Promise.resolve({ killedPids: [], diagnostics: [] })
  ),
  clearPendingOpenCodePromptDeliveriesForTeam: vi.fn(() =>
    Promise.resolve({ cleared: 0, diagnostics: [] })
  ),
  readOwnedOpenCodeRuntimeRunIdsForTeam: vi.fn(() => Promise.resolve(['run-observed'])),
  readOpenCodeRuntimeLaneIdsForTeam: vi.fn(() => Promise.resolve(['primary'])),
  countLiveRecordedRuntimeHostsForTeam: vi.fn(() => Promise.resolve(0)),
  STOP_ESCALATION_TIMEOUT_MS: 90_000,
}));

vi.mock('@main/services/team/lifecycle/teamForceStopFlow', () => stopFlowMocks);

const launchStateMocks = vi.hoisted(() => ({
  markStopped: vi.fn(() => Promise.resolve()),
}));

vi.mock('@main/services/team/TeamLaunchStateStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@main/services/team/TeamLaunchStateStore')>()),
  TeamLaunchStateStore: vi.fn(() => ({ markStopped: launchStateMocks.markStopped })),
}));

import { registerTeamRoutes } from '@main/http/teams';
import Fastify from 'fastify';

import {
  initializeTeamHandlers,
  registerTeamHandlers,
  removeTeamHandlers,
} from '../../../../src/main/ipc/teams';
import { TEAM_STOP } from '../../../../src/preload/constants/ipcChannels';

import type { HttpServices } from '@main/http';
import type { TeamForceStopFlowPorts } from '@main/services/team/lifecycle/teamForceStopFlow';

/**
 * The escalated Stop has the same two entry points force stop has - the in-app
 * IPC handler and the HTTP route - and reaches the same cleanup. That cleanup
 * is fenced to the run being torn down, so a relaunch of the same team started
 * inside the stop budget keeps its own pending deliveries. Both entry points
 * have to build that fence; an entry point that leaves `observeOwnedRuntimeRunIds`
 * out, or calls the delivery cleanup without the fence, silently cancels the
 * successor's work. Nothing else covers that wiring, so this does.
 */
describe('the escalated stop shares one fenced flow between the IPC handler and the HTTP route', () => {
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  const ipcMain = {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
      handlers.set(channel, handler);
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel);
    }),
  };

  const stopTeam = vi.fn(() => Promise.resolve(undefined));
  const getAliveTeams = vi.fn(() => ['fixteam', 'other-team']);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    removeTeamHandlers(ipcMain as never);
    handlers.clear();
  });

  async function callThroughIpc(): Promise<void> {
    initializeTeamHandlers(
      { getTeamData: vi.fn(() => Promise.resolve({ members: [] })) } as never,
      { runtime: { stopTeam, getAliveTeams, isTeamAlive: () => true } } as never
    );
    registerTeamHandlers(ipcMain as never);
    await expect(handlers.get(TEAM_STOP)!({} as never, 'fixteam')).resolves.toMatchObject({
      success: true,
    });
  }

  async function callThroughHttp(): Promise<void> {
    const app = Fastify();
    const services = {
      teamApis: {
        runtime: {
          stopTeam,
          getAliveTeams,
          getRuntimeState: vi.fn(() => Promise.resolve({ state: 'stopped' })),
        },
      },
    } as unknown as HttpServices;
    registerTeamRoutes(app, services);
    await app.ready();
    const response = await app.inject({ method: 'POST', url: '/api/teams/fixteam/stop' });
    expect(response.statusCode).toBe(200);
    await app.close();
  }

  it('fences the escalated cleanup to the observed run ids from both entry points', async () => {
    await callThroughIpc();
    await callThroughHttp();

    expect(stopFlowMocks.stopTeamWithEscalation).toHaveBeenCalledTimes(2);
    const [ipcCall, httpCall] = stopFlowMocks.stopTeamWithEscalation.mock.calls as unknown as [
      [string, TeamForceStopFlowPorts],
      [string, TeamForceStopFlowPorts],
    ];
    expect(ipcCall[0]).toBe('fixteam');
    expect(httpCall[0]).toBe('fixteam');

    for (const [, ports] of [ipcCall, httpCall]) {
      // Every entry point must supply the run-id observation the fence is
      // built from: the port is required, not optional, precisely so a caller
      // cannot opt its cleanup out of the fence.
      await expect(ports.observeOwnedRuntimeRunIds('fixteam')).resolves.toEqual(['run-observed']);
      // The lane scope is read before the stop for the same reason: the stop
      // can remove the lane index, and a cleanup that has to re-read it then
      // finds nothing to cancel.
      await expect(ports.observeOwnedRuntimeLaneIds?.('fixteam')).resolves.toEqual(['primary']);
      await ports.clearPendingPromptDeliveries('fixteam', {
        requestedAtMs: 1_700_000_000_000,
        ownedRunIds: ['run-observed'],
        ownedLaneIds: ['primary'],
      });
      // Both ports below are optional on the flow, so nothing but a check here
      // catches an entry point that dropped one. Without markTeamStopped the
      // stop is not recorded as final and reconciliation re-derives the run
      // that was just stopped; without countLiveRuntimeHosts the stop cannot
      // finish when the hosts are gone and spends the whole budget instead.
      expect(ports.markTeamStopped).toBeTypeOf('function');
      await ports.markTeamStopped?.('fixteam');
      expect(ports.countLiveRuntimeHosts).toBeTypeOf('function');
      await expect(ports.countLiveRuntimeHosts?.('fixteam')).resolves.toBe(0);
      expect(ports.stopTimeoutMs).toBe(90_000);
    }

    // Both reach the real collaborators, scoped to the team being stopped.
    expect(launchStateMocks.markStopped.mock.calls).toEqual([['fixteam'], ['fixteam']]);
    expect(stopFlowMocks.countLiveRecordedRuntimeHostsForTeam.mock.calls).toEqual([
      [{ teamName: 'fixteam' }],
      [{ teamName: 'fixteam' }],
    ]);

    expect(stopFlowMocks.readOwnedOpenCodeRuntimeRunIdsForTeam.mock.calls).toEqual([
      [{ teamName: 'fixteam' }],
      [{ teamName: 'fixteam' }],
    ]);
    // The fence reaches the ledger unchanged from both entry points. A caller
    // that dropped it would show up here as a call without the run ids.
    expect(stopFlowMocks.clearPendingOpenCodePromptDeliveriesForTeam.mock.calls).toEqual([
      [
        {
          teamName: 'fixteam',
          requestedAtMs: 1_700_000_000_000,
          ownedRunIds: ['run-observed'],
          ownedLaneIds: ['primary'],
        },
      ],
      [
        {
          teamName: 'fixteam',
          requestedAtMs: 1_700_000_000_000,
          ownedRunIds: ['run-observed'],
          ownedLaneIds: ['primary'],
        },
      ],
    ]);
  });
});
