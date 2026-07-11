import { createRuntimeCoreProviderJsonParsingServices } from '@features/runtime-core/main';
import { registerHttpRoutes } from '@main/http';
import {
  attachStandaloneTeamHttpServices,
  buildStandaloneTeamHttpServiceSlice,
  buildStandaloneTeamServices,
} from '@main/standaloneTeamServices';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import type { MemberWorkSyncFeatureFacade } from '@features/member-work-sync/main';
import type { RuntimeCoreFeatureFacade } from '@features/runtime-core/main';
import type { HttpServices } from '@main/http';
import type {
  OpenCodeRuntimeControlAck,
  TeamHttpDataApi,
} from '@main/services/team/contracts/TeamProvisioningApis';
import type { TeamDataService } from '@main/services/team/TeamDataService';
import type { TeamProvisioningService } from '@main/services/team/TeamProvisioningService';
import type { StandaloneTeamProvisioningHttpApi } from '@main/standaloneTeamServices';
import type {
  TeamCreateConfigRequest,
  TeamCreateRequest,
  TeamCreateResponse,
  TeamLaunchRequest,
  TeamLaunchResponse,
  TeamProvisioningProgress,
  TeamRuntimeState,
} from '@shared/types/team';

function createBaseServices(overrides: Partial<HttpServices> = {}): HttpServices {
  return {
    projectScanner: {} as HttpServices['projectScanner'],
    sessionParser: {} as HttpServices['sessionParser'],
    subagentResolver: {} as HttpServices['subagentResolver'],
    chunkBuilder: {} as HttpServices['chunkBuilder'],
    dataCache: {} as HttpServices['dataCache'],
    updaterService: {} as HttpServices['updaterService'],
    sshConnectionManager: {} as HttpServices['sshConnectionManager'],
    ...overrides,
  };
}

function createMemberWorkSyncFeature(): MemberWorkSyncFeatureFacade {
  return {
    getStatus: vi.fn(),
    refreshStatus: vi.fn(),
    getMetrics: vi.fn(async () => ({
      teamName: 'demo-team',
      generatedAt: '2026-07-10T00:00:00.000Z',
      members: [],
      totals: {
        caughtUp: 0,
        needsSync: 0,
        stillWorking: 0,
        blocked: 0,
        unknown: 0,
      },
    })),
    report: vi.fn(),
    scheduleProofMissingRecovery: vi.fn(),
    noteTeamChange: vi.fn(),
    enqueueStartupScan: vi.fn(),
    replayPendingReports: vi.fn(),
    dispatchDueNudges: vi.fn(),
    buildRuntimeTurnSettledHookSettings: vi.fn(),
    buildRuntimeTurnSettledEnvironment: vi.fn(),
    drainRuntimeTurnSettledEvents: vi.fn(),
    getQueueDiagnostics: vi.fn(() => ({
      queued: 0,
      processing: 0,
      delayed: 0,
    })),
    dispose: vi.fn(),
  } as unknown as MemberWorkSyncFeatureFacade;
}

function createTeamDataApi(): TeamHttpDataApi {
  return {
    listTeams: vi.fn(async () => [
      {
        teamName: 'demo-team',
        displayName: 'Demo Team',
        description: 'Demo',
        memberCount: 1,
        taskCount: 0,
        lastActivity: null,
      },
    ]),
    getTeamData: vi.fn(),
    getSavedRequest: vi.fn(async () => null),
    createTeamConfig: vi.fn(async (_request: TeamCreateConfigRequest) => undefined),
  } as unknown as TeamHttpDataApi;
}

function createTeamProvisioningService(): StandaloneTeamProvisioningHttpApi {
  const progress: TeamProvisioningProgress = {
    runId: 'run-demo',
    teamName: 'demo-team',
    state: 'ready',
    message: 'ready',
    startedAt: '2026-07-10T00:00:00.000Z',
    updatedAt: '2026-07-10T00:00:00.000Z',
  };
  const ack = async (): Promise<OpenCodeRuntimeControlAck> => ({
    ok: true,
    providerId: 'opencode',
    teamName: 'demo-team',
    runId: 'run-demo',
    state: 'recorded',
    diagnostics: [],
    observedAt: '2026-07-10T00:00:00.000Z',
  });

  return {
    createTeam: vi.fn(
      async (
        _request: TeamCreateRequest,
        _onProgress: (progress: TeamProvisioningProgress) => void
      ): Promise<TeamCreateResponse> => ({ runId: 'run-demo' })
    ),
    launchTeam: vi.fn(
      async (
        _request: TeamLaunchRequest,
        _onProgress: (progress: TeamProvisioningProgress) => void
      ): Promise<TeamLaunchResponse> => ({ runId: 'run-demo' })
    ),
    getProvisioningStatus: vi.fn(async () => progress),
    repairStaleTaskActivityIntervalsBeforeSnapshot: vi.fn(async () => undefined),
    getRuntimeState: vi.fn(
      async (): Promise<TeamRuntimeState> => ({
        teamName: 'demo-team',
        isAlive: true,
        runId: 'run-demo',
        progress,
      })
    ),
    stopTeam: vi.fn(async () => undefined),
    getAliveTeams: vi.fn(() => ['demo-team']),
    recordOpenCodeRuntimeBootstrapCheckin: vi.fn(ack),
    deliverOpenCodeRuntimeMessage: vi.fn(ack),
    recordOpenCodeRuntimeTaskEvent: vi.fn(ack),
    recordOpenCodeRuntimeHeartbeat: vi.fn(ack),
    answerOpenCodeRuntimePermission: vi.fn(ack),
  } satisfies StandaloneTeamProvisioningHttpApi;
}

describe('standalone team HTTP route registration', () => {
  it('registers member-work-sync team routes when that is the only team support present', async () => {
    const app = Fastify();
    const memberWorkSyncFeature = createMemberWorkSyncFeature();
    registerHttpRoutes(app, createBaseServices({ memberWorkSyncFeature }), async () => undefined);
    await app.ready();

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/teams/demo-team/member-work-sync/metrics',
      });

      expect(response.statusCode).toBe(200);
      expect(memberWorkSyncFeature.getMetrics).toHaveBeenCalledWith({ teamName: 'demo-team' });
    } finally {
      await app.close();
    }
  });

  it('attaches standalone team data, runtime, and member-work-sync services', async () => {
    const app = Fastify();
    const memberWorkSyncFeature = createMemberWorkSyncFeature();
    const standaloneServices = {
      httpServices: buildStandaloneTeamHttpServiceSlice({
        teamDataService: createTeamDataApi(),
        teamProvisioningService: createTeamProvisioningService(),
        memberWorkSyncFeature,
      }),
    };
    const services = attachStandaloneTeamHttpServices(createBaseServices(), standaloneServices);
    registerHttpRoutes(app, services, async () => undefined);
    await app.ready();

    try {
      const teamsResponse = await app.inject({ method: 'GET', url: '/api/teams' });
      expect(teamsResponse.statusCode).toBe(200);
      expect(teamsResponse.json()).toEqual(
        expect.arrayContaining([expect.objectContaining({ teamName: 'demo-team' })])
      );

      const runtimeResponse = await app.inject({
        method: 'GET',
        url: '/api/teams/demo-team/runtime',
      });
      expect(runtimeResponse.statusCode).toBe(200);
      expect(runtimeResponse.json()).toMatchObject({
        teamName: 'demo-team',
        isAlive: true,
      });

      const metricsResponse = await app.inject({
        method: 'GET',
        url: '/api/teams/demo-team/member-work-sync/metrics',
      });
      expect(metricsResponse.statusCode).toBe(200);
      expect(memberWorkSyncFeature.getMetrics).toHaveBeenCalledWith({ teamName: 'demo-team' });
    } finally {
      await app.close();
    }
  });

  it('wires standalone control URL resolver and stops teams before member-work-sync disposal', async () => {
    const order: string[] = [];
    const controlApiBaseUrlResolver = vi.fn(async () => 'http://127.0.0.1:43123');
    const teamProvisioningService = {
      ...createTeamProvisioningService(),
      setControlApiBaseUrlResolver: vi.fn(),
      stopAllTeams: vi.fn(async () => {
        order.push('stopAllTeams');
      }),
    };
    const memberWorkSyncFeature = {
      ...createMemberWorkSyncFeature(),
      dispose: vi.fn(async () => {
        order.push('memberWorkSync.dispose');
      }),
    };

    const services = buildStandaloneTeamServices({
      teamDataService: createTeamDataApi() as unknown as TeamDataService,
      teamProvisioningService: teamProvisioningService as unknown as TeamProvisioningService,
      memberWorkSyncFeature,
      controlApiBaseUrlResolver,
    });

    expect(teamProvisioningService.setControlApiBaseUrlResolver).toHaveBeenCalledWith(
      controlApiBaseUrlResolver
    );
    await expect(
      teamProvisioningService.setControlApiBaseUrlResolver.mock.calls[0]?.[0]?.()
    ).resolves.toBe('http://127.0.0.1:43123');

    await services.dispose();

    expect(teamProvisioningService.stopAllTeams).toHaveBeenCalledOnce();
    expect(memberWorkSyncFeature.dispose).toHaveBeenCalledOnce();
    expect(order).toEqual(['stopAllTeams', 'memberWorkSync.dispose']);
  });

  it('registers team routes from runtimeCore team use cases without legacy team service fields', async () => {
    const app = Fastify();
    const memberWorkSyncFeature = createMemberWorkSyncFeature();
    const httpServices = buildStandaloneTeamHttpServiceSlice({
      teamDataService: createTeamDataApi(),
      teamProvisioningService: createTeamProvisioningService(),
      memberWorkSyncFeature,
    });
    const baseServices = createBaseServices();
    const runtimeCore = {
      providerJsonParsing: createRuntimeCoreProviderJsonParsingServices(baseServices),
      teams: {
        data: httpServices.teamDataApi,
        http: httpServices.teamApis,
        ipc: {} as never,
      },
    } satisfies RuntimeCoreFeatureFacade;

    registerHttpRoutes(
      app,
      createBaseServices({
        memberWorkSyncFeature,
        runtimeCore,
      }),
      async () => undefined
    );
    await app.ready();

    try {
      const teamsResponse = await app.inject({ method: 'GET', url: '/api/teams' });
      const runtimeResponse = await app.inject({
        method: 'GET',
        url: '/api/teams/demo-team/runtime',
      });

      expect(teamsResponse.statusCode).toBe(200);
      expect(runtimeResponse.statusCode).toBe(200);
      expect(runtimeResponse.json()).toMatchObject({ teamName: 'demo-team', isAlive: true });
    } finally {
      await app.close();
    }
  });
});
