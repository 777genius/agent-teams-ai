import { registerTeamRoutes } from '@main/http/teams';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import type { HttpServices } from '@main/http';
import type {
  OpenCodeRuntimeControlAck,
  TeamHttpDataApi,
  TeamHttpHandlerApis,
  TeamHttpMemberDiagnosticsApi,
  TeamHttpRuntimeApi,
  TeamProvisioningStartApi,
  TeamProvisioningStatusApi,
  TeamRuntimeControlCompatibilityApi,
  TeamTaskActivityRepairApi,
} from '@main/services/team/contracts/TeamProvisioningApis';
import type {
  MemberSpawnStatusesSnapshot,
  TeamAgentRuntimeSnapshot,
  TeamCreateConfigRequest,
  TeamCreateRequest,
  TeamCreateResponse,
  TeamGetDataOptions,
  TeamLaunchRequest,
  TeamLaunchResponse,
  TeamProvisioningProgress,
  TeamRuntimeState,
  TeamSummary,
  TeamViewSnapshot,
} from '@shared/types/team';

describe('HTTP team runtime routes', () => {
  function createServicesMock() {
    const launchTeam =
      vi.fn<
        (
          request: TeamLaunchRequest,
          onProgress: (progress: TeamProvisioningProgress) => void
        ) => Promise<TeamLaunchResponse>
      >();
    const getRuntimeState = vi.fn<(teamName: string) => Promise<TeamRuntimeState>>();
    const getProvisioningStatus = vi.fn<(runId: string) => Promise<TeamProvisioningProgress>>();
    const repairStaleTaskActivityIntervalsBeforeSnapshot = vi.fn<
      (teamName: string) => Promise<void>
    >(() => Promise.resolve());
    const stopTeam = vi.fn<(teamName: string) => Promise<void>>(() => Promise.resolve());
    const getAliveTeams = vi.fn<() => string[]>();
    const recordOpenCodeRuntimeBootstrapCheckin =
      vi.fn<(raw: unknown) => Promise<OpenCodeRuntimeControlAck>>();
    const deliverOpenCodeRuntimeMessage =
      vi.fn<(raw: unknown) => Promise<OpenCodeRuntimeControlAck>>();
    const recordOpenCodeRuntimeTaskEvent =
      vi.fn<(raw: unknown) => Promise<OpenCodeRuntimeControlAck>>();
    const recordOpenCodeRuntimeHeartbeat =
      vi.fn<(raw: unknown) => Promise<OpenCodeRuntimeControlAck>>();
    const answerOpenCodeRuntimePermission =
      vi.fn<(raw: unknown) => Promise<OpenCodeRuntimeControlAck>>();
    const createTeam =
      vi.fn<
        (
          request: TeamCreateRequest,
          onProgress: (progress: TeamProvisioningProgress) => void
        ) => Promise<TeamCreateResponse>
      >();
    const listTeams = vi.fn<() => Promise<TeamSummary[]>>();
    const getTeamData =
      vi.fn<(teamName: string, options?: TeamGetDataOptions) => Promise<TeamViewSnapshot>>();
    const getSavedRequest = vi.fn<(teamName: string) => Promise<TeamCreateRequest | null>>();
    const createTeamConfig = vi.fn<(request: TeamCreateConfigRequest) => Promise<void>>(() =>
      Promise.resolve()
    );
    const renameDraftTeam = vi.fn<(oldTeamName: string, newTeamName: string) => Promise<void>>(() =>
      Promise.resolve()
    );
    const resumeTeam = vi.fn<(teamName: string) => void>();
    const getMemberSpawnStatuses =
      vi.fn<(teamName: string) => Promise<MemberSpawnStatusesSnapshot>>();
    const getTeamAgentRuntimeSnapshot =
      vi.fn<(teamName: string) => Promise<TeamAgentRuntimeSnapshot>>();
    // The route is write-free by contract, so it may only reach the `...ReadOnly`
    // members. The mutating names are here purely as tripwires.
    const getMemberSpawnStatusesWriting = vi.fn<(teamName: string) => Promise<never>>();
    const getTeamAgentRuntimeSnapshotWriting = vi.fn<(teamName: string) => Promise<never>>();
    const teamMemberDiagnosticsApi = {
      getMemberSpawnStatusesReadOnly: getMemberSpawnStatuses,
      getTeamAgentRuntimeSnapshotReadOnly: getTeamAgentRuntimeSnapshot,
      getMemberSpawnStatuses: getMemberSpawnStatusesWriting,
      getTeamAgentRuntimeSnapshot: getTeamAgentRuntimeSnapshotWriting,
    } as TeamHttpMemberDiagnosticsApi;
    const teamProvisioningStartApi = {
      createTeam,
      launchTeam,
    } satisfies TeamProvisioningStartApi;
    const teamProvisioningStatusApi = {
      getProvisioningStatus,
    } satisfies TeamProvisioningStatusApi;
    const teamTaskActivityRepairApi = {
      repairStaleTaskActivityIntervalsBeforeSnapshot,
    } satisfies TeamTaskActivityRepairApi;
    const teamRuntimeApi = {
      getRuntimeState,
      stopTeam,
      getAliveTeams,
    } satisfies TeamHttpRuntimeApi;
    const teamRuntimeControlApi = {
      recordOpenCodeRuntimeBootstrapCheckin,
      deliverOpenCodeRuntimeMessage,
      recordOpenCodeRuntimeTaskEvent,
      recordOpenCodeRuntimeHeartbeat,
      answerOpenCodeRuntimePermission,
    } satisfies TeamRuntimeControlCompatibilityApi;
    const teamDataApi = {
      listTeams,
      getTeamData,
      getSavedRequest,
      createTeamConfig,
      renameDraftTeam,
    } as Pick<
      TeamHttpDataApi,
      'listTeams' | 'getTeamData' | 'getSavedRequest' | 'createTeamConfig' | 'renameDraftTeam'
    > as HttpServices['teamDataApi'];
    const teamApis = {
      provisioningStart: teamProvisioningStartApi,
      provisioningStatus: teamProvisioningStatusApi,
      taskActivity: teamTaskActivityRepairApi,
      runtime: teamRuntimeApi,
      runtimeControl: teamRuntimeControlApi,
      memberDiagnostics: teamMemberDiagnosticsApi,
    } satisfies TeamHttpHandlerApis;

    const services = {
      projectScanner: {} as HttpServices['projectScanner'],
      sessionParser: {} as HttpServices['sessionParser'],
      subagentResolver: {} as HttpServices['subagentResolver'],
      chunkBuilder: {} as HttpServices['chunkBuilder'],
      dataCache: {} as HttpServices['dataCache'],
      updaterService: {} as HttpServices['updaterService'],
      sshConnectionManager: {} as HttpServices['sshConnectionManager'],
      teamDataApi,
      teamApis,
      memberWorkSyncFeature: {
        resumeTeam,
      } as unknown as HttpServices['memberWorkSyncFeature'],
    } satisfies HttpServices;

    return {
      services,
      launchTeam,
      getRuntimeState,
      getProvisioningStatus,
      repairStaleTaskActivityIntervalsBeforeSnapshot,
      stopTeam,
      getAliveTeams,
      recordOpenCodeRuntimeBootstrapCheckin,
      deliverOpenCodeRuntimeMessage,
      recordOpenCodeRuntimeTaskEvent,
      recordOpenCodeRuntimeHeartbeat,
      answerOpenCodeRuntimePermission,
      createTeam,
      listTeams,
      getTeamData,
      getSavedRequest,
      createTeamConfig,
      renameDraftTeam,
      resumeTeam,
      getMemberSpawnStatuses,
      getTeamAgentRuntimeSnapshot,
      getMemberSpawnStatusesWriting,
      getTeamAgentRuntimeSnapshotWriting,
    };
  }

  async function createApp() {
    const app = Fastify();
    const mocks = createServicesMock();
    registerTeamRoutes(app, mocks.services);
    await app.ready();
    return { app, ...mocks };
  }

  it('lists, gets, and creates draft teams through team data service', async () => {
    const { app, listTeams, getTeamData, createTeamConfig, resumeTeam } = await createApp();
    listTeams.mockResolvedValue([
      {
        teamName: 'demo-team',
        displayName: 'Demo Team',
        description: 'Demo',
        memberCount: 1,
        taskCount: 0,
        lastActivity: null,
        pendingCreate: true,
      },
    ]);
    getTeamData.mockResolvedValue({
      teamName: 'demo-team',
      config: null,
      tasks: [],
      messages: [],
      processes: [],
      kanban: null,
    } as unknown as TeamViewSnapshot);

    try {
      const listResponse = await app.inject({
        method: 'GET',
        url: '/api/teams',
      });
      expect(listResponse.statusCode).toBe(200);
      expect(listResponse.json()[0]).toMatchObject({
        teamName: 'demo-team',
        pendingCreate: true,
      });

      const getResponse = await app.inject({
        method: 'GET',
        url: '/api/teams/demo-team',
      });
      expect(getResponse.statusCode).toBe(200);
      expect(getTeamData).toHaveBeenCalledWith('demo-team');

      const createResponse = await app.inject({
        method: 'POST',
        url: '/api/teams',
        payload: {
          teamName: 'new-team',
          displayName: 'New Team',
          members: [
            {
              name: 'builder',
              role: 'Engineer',
              providerId: 'codex',
              mcpPolicy: {
                mode: 'strictAllowlist',
                scopes: { project: true, user: false },
                serverNames: ['agent-teams'],
              },
            },
          ],
          cwd: '/Users/test/project',
          providerId: 'codex',
          model: 'gpt-5.2',
          effort: 'high',
          fastMode: 'on',
          limitContext: true,
        },
      });
      expect(createResponse.statusCode).toBe(201);
      expect(createResponse.json()).toEqual({ teamName: 'new-team' });
      expect(createTeamConfig).toHaveBeenCalledWith({
        teamName: 'new-team',
        displayName: 'New Team',
        members: [
          {
            name: 'builder',
            role: 'Engineer',
            providerId: 'codex',
            providerBackendId: 'codex-native',
            mcpPolicy: {
              mode: 'strictAllowlist',
              scopes: { project: true, user: false },
              serverNames: ['agent-teams'],
            },
          },
        ],
        cwd: '/Users/test/project',
        providerId: 'codex',
        providerBackendId: 'codex-native',
        model: 'gpt-5.2',
        effort: 'high',
        fastMode: 'on',
        limitContext: true,
      });
      expect(resumeTeam).toHaveBeenCalledWith('new-team');
    } finally {
      await app.close();
    }
  });

  it('repairs stale task activity before reading a team snapshot', async () => {
    const { app, getTeamData, repairStaleTaskActivityIntervalsBeforeSnapshot } = await createApp();
    getTeamData.mockResolvedValue({
      teamName: 'demo-team',
      config: null,
      tasks: [],
      members: [],
      messages: [],
      processes: [],
      kanban: null,
    } as unknown as TeamViewSnapshot);

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/teams/demo-team',
      });

      expect(response.statusCode).toBe(200);
      expect(repairStaleTaskActivityIntervalsBeforeSnapshot).toHaveBeenCalledWith('demo-team');
      expect(
        repairStaleTaskActivityIntervalsBeforeSnapshot.mock.invocationCallOrder[0]
      ).toBeLessThan(getTeamData.mock.invocationCallOrder[0]);
    } finally {
      await app.close();
    }
  });

  it('overlays team get snapshots with live runtime state', async () => {
    const { app, getTeamData, getRuntimeState } = await createApp();
    getTeamData.mockResolvedValue({
      teamName: 'demo-team',
      config: null,
      tasks: [],
      members: [],
      messages: [],
      processes: [],
      kanban: null,
      isAlive: false,
    } as unknown as TeamViewSnapshot);
    getRuntimeState.mockResolvedValue({
      teamName: 'demo-team',
      isAlive: true,
      runId: 'run-opencode',
      progress: {
        runId: 'run-opencode',
        teamName: 'demo-team',
        state: 'ready',
        message: 'Ready',
        startedAt: '2026-03-12T00:00:00.000Z',
        updatedAt: '2026-03-12T00:00:01.000Z',
      },
    });

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/teams/demo-team',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        teamName: 'demo-team',
        isAlive: true,
      });
      expect(getTeamData).toHaveBeenCalledWith('demo-team');
      expect(getRuntimeState).toHaveBeenCalledWith('demo-team');
    } finally {
      await app.close();
    }
  });

  it('launches a team with validated request payload', async () => {
    const { app, launchTeam } = await createApp();
    launchTeam.mockResolvedValue({ runId: 'run-1' });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/teams/demo-team/launch',
        payload: {
          cwd: '/Users/test/project',
          prompt: 'Resume work',
          skipPermissions: false,
          clearContext: true,
          limitContext: true,
          allowExperimentalLocalModels: true,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ runId: 'run-1' });
      expect(launchTeam).toHaveBeenCalledWith(
        {
          teamName: 'demo-team',
          cwd: '/Users/test/project',
          prompt: 'Resume work',
          providerId: 'anthropic',
          skipPermissions: false,
          clearContext: true,
          limitContext: true,
          allowExperimentalLocalModels: true,
        },
        expect.any(Function)
      );
    } finally {
      await app.close();
    }
  });

  it('maps provisioning not-found errors with an embedded team name to 404', async () => {
    const { app, launchTeam } = await createApp();
    launchTeam.mockRejectedValue(
      new Error('Team "demo-team" not found — config.json does not exist')
    );

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/teams/demo-team/launch',
        payload: {
          cwd: '/Users/test/project',
        },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({
        error: 'Team "demo-team" not found — config.json does not exist',
      });
    } finally {
      await app.close();
    }
  });

  it('does not expose unexpected launch service errors in HTTP responses', async () => {
    const { app, launchTeam } = await createApp();
    launchTeam.mockRejectedValue(new Error('private provider runtime diagnostic'));

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/teams/demo-team/launch',
        payload: {
          cwd: '/Users/test/project',
        },
      });

      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({ error: 'Internal server error' });
      expect(response.body).not.toContain('private provider runtime diagnostic');
      expect(console.error).toHaveBeenCalled();
      vi.mocked(console.error).mockClear();
    } finally {
      await app.close();
    }
  });

  it('returns 501 for launch without the optional team HTTP aggregate', async () => {
    const app = Fastify();
    const mocks = createServicesMock();
    registerTeamRoutes(app, {
      ...mocks.services,
      teamApis: undefined,
    });
    await app.ready();

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/teams/demo-team/launch',
        payload: {
          cwd: '/Users/test/project',
        },
      });

      expect(response.statusCode).toBe(501);
      expect(response.json()).toEqual({
        error: 'Team launch control is not available in this mode',
      });
      expect(mocks.launchTeam).not.toHaveBeenCalled();
      expect(mocks.createTeam).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('launches through the grouped HTTP facade exposed to the app shell', async () => {
    const app = Fastify();
    const mocks = createServicesMock();
    mocks.launchTeam.mockResolvedValue({ runId: 'run-grouped-http' });
    expect('teamProvisioningStartApi' in mocks.services).toBe(false);
    expect('teamRuntimeApi' in mocks.services).toBe(false);
    registerTeamRoutes(app, mocks.services);
    await app.ready();

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/teams/demo-team/launch',
        payload: {
          cwd: '/Users/test/project',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ runId: 'run-grouped-http' });
      expect(mocks.launchTeam).toHaveBeenCalledWith(
        {
          teamName: 'demo-team',
          cwd: '/Users/test/project',
          providerId: 'anthropic',
        },
        expect.any(Function)
      );
    } finally {
      await app.close();
    }
  });

  it('validates top-level create effort against the default Anthropic provider over HTTP', async () => {
    const { app, createTeamConfig } = await createApp();

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/teams',
        payload: {
          teamName: 'default-anthropic-effort-team',
          members: [{ name: 'builder' }],
          cwd: '/Users/test/project',
          effort: 'max',
        },
      });

      expect(response.statusCode).toBe(201);
      expect(createTeamConfig).toHaveBeenCalledWith({
        teamName: 'default-anthropic-effort-team',
        members: [{ name: 'builder' }],
        cwd: '/Users/test/project',
        effort: 'max',
      });
    } finally {
      await app.close();
    }
  });

  it('validates teammate runtime fields against the inherited top-level provider over HTTP create', async () => {
    const { app, createTeamConfig } = await createApp();

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/teams',
        payload: {
          teamName: 'inherited-backend-team',
          members: [{ name: 'builder', providerBackendId: 'codex-native', effort: 'xhigh' }],
          cwd: '/Users/test/project',
          providerId: 'codex',
          providerBackendId: 'codex-native',
        },
      });

      expect(response.statusCode).toBe(201);
      expect(createTeamConfig).toHaveBeenCalledWith({
        teamName: 'inherited-backend-team',
        members: [{ name: 'builder', providerBackendId: 'codex-native', effort: 'xhigh' }],
        cwd: '/Users/test/project',
        providerId: 'codex',
        providerBackendId: 'codex-native',
      });
    } finally {
      await app.close();
    }
  });

  it('drops a stale known backend when launching with a different provider over HTTP', async () => {
    const { app, launchTeam } = await createApp();
    launchTeam.mockResolvedValue({ runId: 'run-2' });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/teams/demo-team/launch',
        payload: {
          cwd: '/Users/test/project',
          providerId: 'anthropic',
          providerBackendId: 'codex-native',
          model: 'sonnet',
          effort: 'low',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(launchTeam).toHaveBeenCalledWith(
        {
          teamName: 'demo-team',
          cwd: '/Users/test/project',
          providerId: 'anthropic',
          model: 'sonnet',
          effort: 'low',
        },
        expect.any(Function)
      );
    } finally {
      await app.close();
    }
  });

  it('still rejects unknown provider backends over HTTP launch', async () => {
    const { app, launchTeam } = await createApp();

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/teams/demo-team/launch',
        payload: {
          cwd: '/Users/test/project',
          providerId: 'anthropic',
          providerBackendId: 'unknown-backend',
          model: 'sonnet',
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toContain('providerBackendId must be valid');
      expect(launchTeam).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('routes draft team launch through createTeam with saved metadata', async () => {
    const { app, createTeam, getSavedRequest, launchTeam, resumeTeam } = await createApp();
    getSavedRequest.mockResolvedValue({
      teamName: 'draft-team',
      displayName: 'Draft Team',
      description: 'Saved draft',
      color: '#3366ff',
      cwd: '/Users/test/saved-project',
      prompt: 'Saved prompt',
      providerId: 'codex',
      providerBackendId: 'codex-native',
      model: 'gpt-5.2',
      effort: 'medium',
      fastMode: 'on',
      limitContext: true,
      members: [{ name: 'builder', role: 'Engineer', providerId: 'codex' }],
    });
    createTeam.mockResolvedValue({ runId: 'run-draft' });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/teams/draft-team/launch',
        payload: {
          cwd: '/Users/test/project',
          effort: 'high',
          allowExperimentalLocalModels: true,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ runId: 'run-draft' });
      expect(launchTeam).not.toHaveBeenCalled();
      expect(resumeTeam).toHaveBeenCalledWith('draft-team');
      expect(createTeam).toHaveBeenCalledWith(
        {
          teamName: 'draft-team',
          displayName: 'Draft Team',
          description: 'Saved draft',
          color: '#3366ff',
          members: [{ name: 'builder', role: 'Engineer', providerId: 'codex' }],
          cwd: '/Users/test/project',
          prompt: 'Saved prompt',
          providerId: 'codex',
          providerBackendId: 'codex-native',
          model: 'gpt-5.2',
          effort: 'high',
          fastMode: 'on',
          limitContext: true,
          allowExperimentalLocalModels: true,
        },
        expect.any(Function)
      );
    } finally {
      await app.close();
    }
  });

  it('renames the draft directory before create when launch carries the final team name', async () => {
    const { app, createTeam, getSavedRequest, renameDraftTeam, resumeTeam } = await createApp();
    getSavedRequest.mockResolvedValue({
      teamName: 'signal-ops',
      cwd: '/Users/test/saved-project',
      members: [{ name: 'builder' }],
    });
    createTeam.mockResolvedValue({ runId: 'run-renamed' });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/teams/signal-ops/launch',
        payload: {
          teamName: 'fixteam-test',
          cwd: '/Users/test/project',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ runId: 'run-renamed' });
      expect(renameDraftTeam).toHaveBeenCalledWith('signal-ops', 'fixteam-test');
      expect(createTeam).toHaveBeenCalledWith(
        expect.objectContaining({ teamName: 'fixteam-test', cwd: '/Users/test/project' }),
        expect.any(Function)
      );
      expect(resumeTeam).toHaveBeenCalledWith('fixteam-test');
      const renameOrder = renameDraftTeam.mock.invocationCallOrder[0];
      const createOrder = createTeam.mock.invocationCallOrder[0];
      expect(renameOrder).toBeLessThan(createOrder);
    } finally {
      await app.close();
    }
  });

  it('does not rename the draft directory when the launch body team name matches', async () => {
    const { app, createTeam, getSavedRequest, renameDraftTeam } = await createApp();
    getSavedRequest.mockResolvedValue({
      teamName: 'signal-ops',
      cwd: '/Users/test/saved-project',
      members: [{ name: 'builder' }],
    });
    createTeam.mockResolvedValue({ runId: 'run-same-name' });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/teams/signal-ops/launch',
        payload: {
          teamName: 'signal-ops',
          cwd: '/Users/test/project',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(renameDraftTeam).not.toHaveBeenCalled();
      expect(createTeam).toHaveBeenCalledWith(
        expect.objectContaining({ teamName: 'signal-ops' }),
        expect.any(Function)
      );
    } finally {
      await app.close();
    }
  });

  it('fails the draft launch when the draft directory rename fails', async () => {
    const { app, createTeam, getSavedRequest, renameDraftTeam } = await createApp();
    getSavedRequest.mockResolvedValue({
      teamName: 'signal-ops',
      cwd: '/Users/test/saved-project',
      members: [{ name: 'builder' }],
    });
    renameDraftTeam.mockRejectedValue(new Error('Team already exists: fixteam-test'));

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/teams/signal-ops/launch',
        payload: {
          teamName: 'fixteam-test',
          cwd: '/Users/test/project',
        },
      });

      expect(response.statusCode).toBe(409);
      expect(createTeam).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('drops stale saved draft backend when draft launch switches provider over HTTP', async () => {
    const { app, createTeam, getSavedRequest } = await createApp();
    getSavedRequest.mockResolvedValue({
      teamName: 'draft-team',
      displayName: 'Draft Team',
      cwd: '/Users/test/saved-project',
      providerId: 'codex',
      providerBackendId: 'codex-native',
      model: 'gpt-5.2',
      effort: 'medium',
      limitContext: false,
      members: [{ name: 'builder', role: 'Engineer', providerId: 'codex' }],
    });
    createTeam.mockResolvedValue({ runId: 'run-draft-anthropic' });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/teams/draft-team/launch',
        payload: {
          cwd: '/Users/test/project',
          providerId: 'anthropic',
          model: 'sonnet',
          effort: 'low',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(createTeam).toHaveBeenCalledWith(
        expect.not.objectContaining({ providerBackendId: expect.any(String) }),
        expect.any(Function)
      );
      expect(createTeam).toHaveBeenCalledWith(
        expect.objectContaining({
          teamName: 'draft-team',
          cwd: '/Users/test/project',
          providerId: 'anthropic',
          model: 'sonnet',
          effort: 'low',
        }),
        expect.any(Function)
      );
    } finally {
      await app.close();
    }
  });

  it('does not reuse saved draft model defaults when draft launch switches provider over HTTP', async () => {
    const { app, createTeam, getSavedRequest } = await createApp();
    getSavedRequest.mockResolvedValue({
      teamName: 'draft-team',
      displayName: 'Draft Team',
      cwd: '/Users/test/saved-project',
      providerId: 'codex',
      providerBackendId: 'unknown-stale-backend' as never,
      model: 'gpt-5.2',
      effort: 'medium',
      fastMode: 'on',
      limitContext: true,
      members: [{ name: 'builder', role: 'Engineer', providerId: 'codex' }],
    });
    createTeam.mockResolvedValue({ runId: 'run-draft-anthropic-default' });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/teams/draft-team/launch',
        payload: {
          cwd: '/Users/test/project',
          providerId: 'anthropic',
        },
      });

      expect(response.statusCode).toBe(200);
      const [request] = createTeam.mock.calls.at(-1)!;
      expect(request).toMatchObject({
        teamName: 'draft-team',
        cwd: '/Users/test/project',
        providerId: 'anthropic',
      });
      expect(request.providerBackendId).toBeUndefined();
      expect(request.model).toBeUndefined();
      expect(request.effort).toBeUndefined();
      expect(request.fastMode).toBeUndefined();
      expect(request.limitContext).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('clears saved draft model when same-provider draft launch requests default over HTTP', async () => {
    const { app, createTeam, getSavedRequest } = await createApp();
    getSavedRequest.mockResolvedValue({
      teamName: 'draft-team',
      displayName: 'Draft Team',
      cwd: '/Users/test/saved-project',
      providerId: 'codex',
      providerBackendId: 'codex-native',
      model: 'gpt-5.2',
      effort: 'medium',
      limitContext: false,
      members: [{ name: 'builder', role: 'Engineer', providerId: 'codex' }],
    });
    createTeam.mockResolvedValue({ runId: 'run-draft-codex-default' });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/teams/draft-team/launch',
        payload: {
          cwd: '/Users/test/project',
          providerId: 'codex',
          providerBackendId: 'codex-native',
          model: null,
          effort: 'low',
        },
      });

      expect(response.statusCode).toBe(200);
      const [request] = createTeam.mock.calls.at(-1)!;
      expect(request).toMatchObject({
        teamName: 'draft-team',
        cwd: '/Users/test/project',
        providerId: 'codex',
        providerBackendId: 'codex-native',
        effort: 'low',
      });
      expect(request.model).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('returns saved metadata for draft team get without requiring config.json', async () => {
    const { app, getSavedRequest, getTeamData } = await createApp();
    getSavedRequest.mockResolvedValue({
      teamName: 'draft-team',
      displayName: 'Draft Team',
      cwd: '/Users/test/project',
      providerId: 'codex',
      providerBackendId: 'codex-native',
      members: [{ name: 'builder', role: 'Engineer', providerId: 'codex' }],
    });

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/teams/draft-team',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        teamName: 'draft-team',
        pendingCreate: true,
        savedRequest: {
          teamName: 'draft-team',
          displayName: 'Draft Team',
          cwd: '/Users/test/project',
          providerId: 'codex',
          providerBackendId: 'codex-native',
          members: [{ name: 'builder', role: 'Engineer', providerId: 'codex' }],
        },
      });
      expect(getTeamData).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('rejects launch requests with non-absolute cwd', async () => {
    const { app, launchTeam } = await createApp();

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/teams/demo-team/launch',
        payload: {
          cwd: 'relative/path',
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: 'cwd must be an absolute path' });
      expect(launchTeam).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('returns runtime state, provisioning status, and stop results', async () => {
    const { app, getRuntimeState, getProvisioningStatus, stopTeam, getAliveTeams } =
      await createApp();
    getRuntimeState
      .mockResolvedValueOnce({
        teamName: 'demo-team',
        isAlive: true,
        runId: 'run-2',
        progress: {
          runId: 'run-2',
          teamName: 'demo-team',
          state: 'ready',
          message: 'Ready',
          startedAt: '2026-03-12T00:00:00.000Z',
          updatedAt: '2026-03-12T00:00:01.000Z',
        },
      })
      .mockResolvedValueOnce({
        teamName: 'demo-team',
        isAlive: false,
        runId: null,
        progress: null,
      })
      .mockResolvedValueOnce({
        teamName: 'demo-team',
        isAlive: true,
        runId: 'run-2',
        progress: {
          runId: 'run-2',
          teamName: 'demo-team',
          state: 'ready',
          message: 'Ready',
          startedAt: '2026-03-12T00:00:00.000Z',
          updatedAt: '2026-03-12T00:00:01.000Z',
        },
      });
    getProvisioningStatus.mockResolvedValue({
      runId: 'run-2',
      teamName: 'demo-team',
      state: 'ready',
      message: 'Ready',
      startedAt: '2026-03-12T00:00:00.000Z',
      updatedAt: '2026-03-12T00:00:01.000Z',
    });
    getAliveTeams.mockReturnValue(['demo-team']);

    try {
      const runtimeResponse = await app.inject({
        method: 'GET',
        url: '/api/teams/demo-team/runtime',
      });
      expect(runtimeResponse.statusCode).toBe(200);
      expect(runtimeResponse.json().isAlive).toBe(true);

      const provisioningResponse = await app.inject({
        method: 'GET',
        url: '/api/teams/provisioning/run-2',
      });
      expect(provisioningResponse.statusCode).toBe(200);
      expect(provisioningResponse.json().runId).toBe('run-2');

      const stopResponse = await app.inject({
        method: 'POST',
        url: '/api/teams/demo-team/stop',
      });
      expect(stopResponse.statusCode).toBe(200);
      expect(stopResponse.json()).toEqual({
        teamName: 'demo-team',
        isAlive: false,
        runId: null,
        progress: null,
      });
      expect(stopTeam).toHaveBeenCalledWith('demo-team');

      const aliveResponse = await app.inject({
        method: 'GET',
        url: '/api/teams/runtime/alive',
      });
      expect(aliveResponse.statusCode).toBe(200);
      expect(aliveResponse.json()).toEqual([
        {
          teamName: 'demo-team',
          isAlive: true,
          runId: 'run-2',
          progress: {
            runId: 'run-2',
            teamName: 'demo-team',
            state: 'ready',
            message: 'Ready',
            startedAt: '2026-03-12T00:00:00.000Z',
            updatedAt: '2026-03-12T00:00:01.000Z',
          },
        },
      ]);
    } finally {
      await app.close();
    }
  });

  it('routes OpenCode runtime callbacks through the runtime API facade', async () => {
    const {
      app,
      recordOpenCodeRuntimeBootstrapCheckin,
      deliverOpenCodeRuntimeMessage,
      recordOpenCodeRuntimeTaskEvent,
      recordOpenCodeRuntimeHeartbeat,
    } = await createApp();
    const callbackPayload = {
      runId: 'run-opencode',
      idempotencyKey: 'callback-1',
      observedAt: '2026-03-12T00:00:02.000Z',
      location: { line: 12 },
    };
    const callbackCases = [
      {
        url: '/api/teams/demo-team/opencode/runtime/bootstrap-checkin',
        handler: recordOpenCodeRuntimeBootstrapCheckin,
        state: 'accepted',
      },
      {
        url: '/api/teams/demo-team/opencode/runtime/deliver-message',
        handler: deliverOpenCodeRuntimeMessage,
        state: 'delivered',
      },
      {
        url: '/api/teams/demo-team/opencode/runtime/task-event',
        handler: recordOpenCodeRuntimeTaskEvent,
        state: 'recorded',
      },
      {
        url: '/api/teams/demo-team/opencode/runtime/heartbeat',
        handler: recordOpenCodeRuntimeHeartbeat,
        state: 'recorded',
      },
    ] as const;

    try {
      for (const callbackCase of callbackCases) {
        const ack: OpenCodeRuntimeControlAck = {
          ok: true,
          providerId: 'opencode',
          teamName: 'demo-team',
          runId: 'run-opencode',
          state: callbackCase.state,
          idempotencyKey: 'callback-1',
          diagnostics: [],
          observedAt: '2026-03-12T00:00:02.000Z',
        };
        callbackCase.handler.mockResolvedValueOnce(ack);

        const response = await app.inject({
          method: 'POST',
          url: callbackCase.url,
          payload: callbackPayload,
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual(ack);
        expect(callbackCase.handler).toHaveBeenCalledWith({
          ...callbackPayload,
          teamName: 'demo-team',
        });
      }
    } finally {
      await app.close();
    }
  });

  it('maps OpenCode runtime callback payload validation failures to 400', async () => {
    const { app, recordOpenCodeRuntimeHeartbeat } = await createApp();
    recordOpenCodeRuntimeHeartbeat.mockRejectedValueOnce(
      new Error('OpenCode runtime payload missing runId')
    );

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/teams/demo-team/opencode/runtime/heartbeat',
        payload: {
          teamName: 'demo-team',
          observedAt: '2026-03-12T00:00:02.000Z',
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: 'OpenCode runtime payload missing runId',
      });
    } finally {
      await app.close();
    }
  });

  it('accepts heartbeats without observedAt for service-side normalization', async () => {
    const { app, recordOpenCodeRuntimeHeartbeat } = await createApp();
    const ack: OpenCodeRuntimeControlAck = {
      ok: true,
      providerId: 'opencode',
      teamName: 'demo-team',
      runId: 'run-opencode',
      state: 'recorded',
      memberName: 'builder',
      runtimeSessionId: 'session-1',
      diagnostics: [],
      observedAt: '2026-03-12T00:00:02.000Z',
    };
    recordOpenCodeRuntimeHeartbeat.mockResolvedValueOnce(ack);

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/teams/demo-team/opencode/runtime/heartbeat',
        payload: {
          runId: 'run-opencode',
          memberName: 'builder',
          runtimeSessionId: 'session-1',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(ack);
      expect(recordOpenCodeRuntimeHeartbeat).toHaveBeenCalledWith({
        teamName: 'demo-team',
        runId: 'run-opencode',
        memberName: 'builder',
        runtimeSessionId: 'session-1',
      });
    } finally {
      await app.close();
    }
  });

  it('rejects provided invalid or non-string heartbeat observedAt before delegation', async () => {
    const { app, recordOpenCodeRuntimeHeartbeat } = await createApp();

    try {
      for (const observedAt of ['not-a-date', 42]) {
        const response = await app.inject({
          method: 'POST',
          url: '/api/teams/demo-team/opencode/runtime/heartbeat',
          payload: {
            runId: 'run-opencode',
            memberName: 'builder',
            runtimeSessionId: 'session-1',
            observedAt,
          },
        });

        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({
          error: 'OpenCode runtime payload invalid observedAt',
        });
      }
      expect(recordOpenCodeRuntimeHeartbeat).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('does not expose runtime permission answers over HTTP', async () => {
    const { app, answerOpenCodeRuntimePermission } = await createApp();

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/teams/demo-team/opencode/runtime/permission-answer',
        payload: {
          runId: 'run-opencode',
          memberName: 'builder',
          requestId: 'provider-request-1',
          decision: 'allow',
          cwd: '/repo',
          expectedMembers: [],
        },
      });

      expect(response.statusCode).toBe(404);
      expect(answerOpenCodeRuntimePermission).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('returns 501 for provisioning status without the optional team HTTP aggregate', async () => {
    const app = Fastify();
    const mocks = createServicesMock();
    registerTeamRoutes(app, {
      ...mocks.services,
      teamApis: undefined,
    });
    await app.ready();

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/teams/provisioning/run-2',
      });

      expect(response.statusCode).toBe(501);
      expect(response.json()).toEqual({
        error: 'Team provisioning status is not available in this mode',
      });
      expect(mocks.getProvisioningStatus).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('rejects OpenCode runtime callback bodies for a different team', async () => {
    const { app, recordOpenCodeRuntimeHeartbeat } = await createApp();

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/teams/demo-team/opencode/runtime/heartbeat',
        payload: {
          teamName: 'other-team',
          runId: 'run-opencode',
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: 'runtime body teamName must match route teamName',
      });
      expect(recordOpenCodeRuntimeHeartbeat).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('rejects malformed OpenCode runtime callback bodies before delegation', async () => {
    const { app, recordOpenCodeRuntimeHeartbeat } = await createApp();

    try {
      for (const payload of ['null', '[]']) {
        const response = await app.inject({
          method: 'POST',
          url: '/api/teams/demo-team/opencode/runtime/heartbeat',
          headers: { 'content-type': 'application/json' },
          payload,
        });

        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({
          error: 'runtime body must be an object',
        });
      }
      expect(recordOpenCodeRuntimeHeartbeat).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('returns 501 for OpenCode runtime callbacks without the optional team HTTP aggregate', async () => {
    const app = Fastify();
    const mocks = createServicesMock();
    registerTeamRoutes(app, {
      ...mocks.services,
      teamApis: undefined,
    });
    await app.ready();

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/teams/demo-team/opencode/runtime/heartbeat',
        payload: {
          teamName: 'demo-team',
          runId: 'run-opencode',
        },
      });

      expect(response.statusCode).toBe(501);
      expect(response.json()).toEqual({
        error: 'Team runtime callbacks are not available in this mode',
      });
      expect(mocks.recordOpenCodeRuntimeHeartbeat).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('returns 501 when team runtime routes are registered without a runtime service', async () => {
    const app = Fastify();
    registerTeamRoutes(app, {
      projectScanner: {} as HttpServices['projectScanner'],
      sessionParser: {} as HttpServices['sessionParser'],
      subagentResolver: {} as HttpServices['subagentResolver'],
      chunkBuilder: {} as HttpServices['chunkBuilder'],
      dataCache: {} as HttpServices['dataCache'],
      updaterService: {} as HttpServices['updaterService'],
      sshConnectionManager: {} as HttpServices['sshConnectionManager'],
    } satisfies HttpServices);
    await app.ready();

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/teams/runtime/alive',
      });

      expect(response.statusCode).toBe(501);
      expect(response.json()).toEqual({
        error: 'Team runtime control is not available in this mode',
      });
    } finally {
      await app.close();
    }
  });

  // mixrun42 live run: the Olla lane raised runtimeAdvisory api_error/backend_error while the
  // team stayed alive, and that advisory was visible only in the in-memory member diagnostics.
  function createMixrun42Diagnostics() {
    const memberSnapshot = {
      teamName: 'mixrun42',
      config: null,
      tasks: [],
      kanbanState: null,
      processes: [],
      members: [
        { name: 'team-lead', agentType: 'team-lead', providerId: 'anthropic', model: 'grok-4.6' },
        {
          name: 'Olla',
          agentType: 'reviewer',
          providerId: 'opencode',
          model: 'ollama/qwen3-8b-32k',
          runtimeAdvisory: {
            kind: 'api_error',
            reasonCode: 'backend_error',
            observedAt: '2026-08-27T14:48:33.000Z',
            message: 'OpenCode API error',
          },
        },
        { name: 'Qwen', agentType: 'developer', providerId: 'opencode', model: 'qwen3.8-27b' },
      ],
    } as unknown as TeamViewSnapshot;
    const spawnSnapshot = {
      runId: 'run-mixrun42',
      source: 'live',
      teamLaunchState: 'clean_success',
      launchPhase: 'active',
      updatedAt: '2026-08-27T14:48:41.000Z',
      expectedMembers: ['team-lead', 'Olla', 'Qwen'],
      statuses: {
        'team-lead': {
          status: 'online',
          launchState: 'confirmed_alive',
          runtimeAlive: true,
          bootstrapConfirmed: true,
          livenessSource: 'heartbeat',
          livenessKind: 'confirmed_bootstrap',
          updatedAt: '2026-08-27T14:42:41.000Z',
        },
        Olla: {
          status: 'online',
          launchState: 'confirmed_alive',
          runtimeAlive: true,
          bootstrapConfirmed: true,
          agentToolAccepted: true,
          livenessSource: 'heartbeat',
          livenessKind: 'runtime_process',
          firstSpawnAcceptedAt: '2026-08-27T14:42:31.000Z',
          lastHeartbeatAt: '2026-08-27T14:48:41.000Z',
          livenessLastCheckedAt: '2026-08-27T14:49:37.000Z',
          updatedAt: '2026-08-27T14:48:41.000Z',
        },
        Qwen: {
          status: 'online',
          launchState: 'confirmed_alive',
          runtimeAlive: true,
          bootstrapConfirmed: true,
          updatedAt: '2026-08-27T14:44:02.000Z',
        },
      },
    } as unknown as MemberSpawnStatusesSnapshot;
    const runtimeSnapshot = {
      teamName: 'mixrun42',
      updatedAt: '2026-08-27T14:49:37.000Z',
      runId: 'run-mixrun42',
      members: {
        'team-lead': {
          memberName: 'team-lead',
          alive: true,
          restartable: false,
          pid: 4242,
          rssBytes: 570_949_632,
          cpuPercent: 3.5,
          updatedAt: '2026-08-27T14:49:37.000Z',
        },
        Olla: {
          memberName: 'Olla',
          alive: true,
          restartable: true,
          providerId: 'opencode',
          laneId: 'secondary-olla',
          laneKind: 'secondary',
          pid: 5150,
          runtimePid: 5151,
          runtimeSessionId: 'ses_olla_mixrun42',
          processCommand: 'opencode serve --port 41231',
          rssBytes: 268_435_456,
          cpuPercent: 11.25,
          runtimeLoadScope: 'shared-host',
          livenessKind: 'runtime_process',
          runtimeLastSeenAt: '2026-08-27T14:49:31.000Z',
          diagnostics: ['lane bootstrap confirmed'],
          updatedAt: '2026-08-27T14:49:37.000Z',
        },
        Qwen: {
          memberName: 'Qwen',
          alive: true,
          restartable: true,
          providerId: 'opencode',
          updatedAt: '2026-08-27T14:49:37.000Z',
        },
      },
    } as unknown as TeamAgentRuntimeSnapshot;
    return { memberSnapshot, spawnSnapshot, runtimeSnapshot };
  }

  it('serves the full per-member spawn and runtime diagnostics projection', async () => {
    const {
      app,
      getTeamData,
      getMemberSpawnStatuses,
      getTeamAgentRuntimeSnapshot,
      getMemberSpawnStatusesWriting,
      getTeamAgentRuntimeSnapshotWriting,
    } = await createApp();
    const { memberSnapshot, spawnSnapshot, runtimeSnapshot } = createMixrun42Diagnostics();
    getTeamData.mockResolvedValue(memberSnapshot);
    getMemberSpawnStatuses.mockResolvedValue(spawnSnapshot);
    getTeamAgentRuntimeSnapshot.mockResolvedValue(runtimeSnapshot);

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/teams/mixrun42/members/diagnostics',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(getMemberSpawnStatuses).toHaveBeenCalledWith('mixrun42');
      expect(getTeamAgentRuntimeSnapshot).toHaveBeenCalledWith('mixrun42');
      expect(getMemberSpawnStatusesWriting).not.toHaveBeenCalled();
      expect(getTeamAgentRuntimeSnapshotWriting).not.toHaveBeenCalled();
      expect(body).toMatchObject({
        teamName: 'mixrun42',
        runId: 'run-mixrun42',
        spawnSource: 'live',
        teamLaunchState: 'clean_success',
        launchPhase: 'active',
        spawnUpdatedAt: '2026-08-27T14:48:41.000Z',
        runtimeUpdatedAt: '2026-08-27T14:49:37.000Z',
      });
      expect(typeof body.generatedAt).toBe('string');
      expect(body.members.map((member: { memberName: string }) => member.memberName)).toEqual([
        'team-lead',
        'Olla',
        'Qwen',
      ]);
      expect(body.members[0]).toMatchObject({
        memberName: 'team-lead',
        isLead: true,
        rssBytes: 570_949_632,
        cpuPercent: 3.5,
      });
      expect(body.members[1]).toMatchObject({
        memberName: 'Olla',
        isLead: false,
        providerId: 'opencode',
        laneId: 'secondary-olla',
        laneKind: 'secondary',
        memberCardError: 'OpenCode API error',
        runtimeAdvisoryKind: 'api_error',
        runtimeAdvisoryReasonCode: 'backend_error',
        runtimeAdvisoryObservedAt: '2026-08-27T14:48:33.000Z',
        runtimeAdvisoryMessage: 'OpenCode API error',
        diagnostics: ['OpenCode API error', 'lane bootstrap confirmed'],
        spawnStatus: 'online',
        launchState: 'confirmed_alive',
        livenessKind: 'runtime_process',
        livenessSource: 'heartbeat',
        alive: true,
        runtimeAlive: true,
        bootstrapConfirmed: true,
        rssBytes: 268_435_456,
        cpuPercent: 11.25,
        // Lets an external monitor tell a per-member sample from a shared one.
        runtimeLoadScope: 'shared-host',
        runtimePid: 5151,
        runtimeSessionId: 'ses_olla_mixrun42',
        processCommand: 'opencode serve --port 41231',
        firstSpawnAcceptedAt: '2026-08-27T14:42:31.000Z',
        lastHeartbeatAt: '2026-08-27T14:48:41.000Z',
        livenessLastCheckedAt: '2026-08-27T14:49:37.000Z',
        runtimeLastSeenAt: '2026-08-27T14:49:31.000Z',
        spawnUpdatedAt: '2026-08-27T14:48:41.000Z',
        runtimeUpdatedAt: '2026-08-27T14:49:37.000Z',
      });
      expect(body.members[2]).toMatchObject({ memberName: 'Qwen', diagnostics: [] });
      expect(body.members[2].memberCardError).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('prefers spawn failure evidence over the runtime advisory for the member card error', async () => {
    const { app, getTeamData, getMemberSpawnStatuses, getTeamAgentRuntimeSnapshot } =
      await createApp();
    getTeamData.mockResolvedValue({
      teamName: 'mixrun42',
      members: [
        {
          name: 'Olla',
          runtimeAdvisory: {
            kind: 'api_error',
            reasonCode: 'backend_error',
            observedAt: '2026-08-27T14:48:33.000Z',
            message: 'OpenCode API error',
          },
        },
      ],
    } as unknown as TeamViewSnapshot);
    getMemberSpawnStatuses.mockResolvedValue({
      runId: null,
      statuses: {
        Olla: {
          status: 'error',
          launchState: 'failed_to_start',
          error: 'OpenCode lane never confirmed bootstrap',
          hardFailure: true,
          hardFailureReason: 'bootstrap_timeout',
          runtimeDiagnostic: 'no runtime session recorded',
          runtimeDiagnosticSeverity: 'error',
          updatedAt: '2026-08-27T14:48:41.000Z',
        },
      },
    } as unknown as MemberSpawnStatusesSnapshot);
    getTeamAgentRuntimeSnapshot.mockResolvedValue({
      teamName: 'mixrun42',
      updatedAt: '2026-08-27T14:49:37.000Z',
      runId: null,
      members: {},
    } as unknown as TeamAgentRuntimeSnapshot);

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/teams/mixrun42/members/diagnostics',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().members[0]).toMatchObject({
        memberName: 'Olla',
        memberCardError: 'OpenCode lane never confirmed bootstrap',
        hardFailure: true,
        hardFailureReason: 'bootstrap_timeout',
        spawnStatus: 'error',
        launchState: 'failed_to_start',
        runtimeAdvisoryKind: 'api_error',
        diagnostics: [
          'OpenCode lane never confirmed bootstrap',
          'no runtime session recorded',
          'OpenCode API error',
          'bootstrap_timeout',
        ],
      });
    } finally {
      await app.close();
    }
  });

  it('still serves member diagnostics when the team view snapshot is unavailable', async () => {
    const { app, getTeamData, getMemberSpawnStatuses, getTeamAgentRuntimeSnapshot } =
      await createApp();
    getTeamData.mockRejectedValue(new Error('team data worker unavailable'));
    getMemberSpawnStatuses.mockResolvedValue({
      runId: 'run-mixrun42',
      statuses: {
        Olla: {
          status: 'online',
          launchState: 'confirmed_alive',
          updatedAt: '2026-08-27T14:48:41.000Z',
        },
      },
    } as unknown as MemberSpawnStatusesSnapshot);
    getTeamAgentRuntimeSnapshot.mockResolvedValue({
      teamName: 'mixrun42',
      updatedAt: '2026-08-27T14:49:37.000Z',
      runId: 'run-mixrun42',
      members: {
        Olla: {
          memberName: 'Olla',
          alive: true,
          restartable: true,
          updatedAt: '2026-08-27T14:49:37.000Z',
        },
      },
    } as unknown as TeamAgentRuntimeSnapshot);

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/teams/mixrun42/members/diagnostics',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.members).toHaveLength(1);
      expect(body.members[0]).toMatchObject({ memberName: 'Olla', alive: true, isLead: false });
      expect(body.members[0].runtimeAdvisoryKind).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('rejects member diagnostics for an invalid team name before touching the facades', async () => {
    const { app, getMemberSpawnStatuses, getTeamAgentRuntimeSnapshot } = await createApp();

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/teams/..%2Fescape/members/diagnostics',
      });

      expect(response.statusCode).toBe(400);
      expect(getMemberSpawnStatuses).not.toHaveBeenCalled();
      expect(getTeamAgentRuntimeSnapshot).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('returns 501 for member diagnostics when the team apis are not bound in this mode', async () => {
    const app = Fastify();
    const mocks = createServicesMock();
    registerTeamRoutes(app, {
      ...mocks.services,
      teamApis: undefined,
    });
    await app.ready();

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/teams/mixrun42/members/diagnostics',
      });

      expect(response.statusCode).toBe(501);
      expect(response.json()).toEqual({
        error: 'Team member diagnostics are not available in this mode',
      });
      expect(mocks.getMemberSpawnStatuses).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('does not expose unexpected member diagnostics failures over HTTP', async () => {
    const { app, getMemberSpawnStatuses, getTeamAgentRuntimeSnapshot } = await createApp();
    getMemberSpawnStatuses.mockRejectedValue(new Error('spawn snapshot store corrupted'));
    getTeamAgentRuntimeSnapshot.mockResolvedValue({
      teamName: 'mixrun42',
      updatedAt: '2026-08-27T14:49:37.000Z',
      runId: null,
      members: {},
    } as unknown as TeamAgentRuntimeSnapshot);

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/teams/mixrun42/members/diagnostics',
      });

      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({ error: 'Internal server error' });
      expect(response.body).not.toContain('spawn snapshot store corrupted');
      expect(console.error).toHaveBeenCalled();
      vi.mocked(console.error).mockClear();
    } finally {
      await app.close();
    }
  });

  it('redacts secrets and bounds every diagnostics string before it leaves the HTTP port', async () => {
    const { app, getTeamData, getMemberSpawnStatuses, getTeamAgentRuntimeSnapshot } =
      await createApp();
    const secret = 'sk-abc123def456ghi789';
    getTeamData.mockResolvedValue({
      teamName: 'mixrun42',
      members: [
        {
          name: 'Olla',
          providerId: 'opencode',
          runtimeAdvisory: {
            kind: 'api_error',
            reasonCode: 'auth_error',
            observedAt: '2026-08-27T14:48:33.000Z',
            message: `OpenCode API error for OPENCODE_API_KEY=${secret}`,
          },
        },
      ],
    } as unknown as TeamViewSnapshot);
    getMemberSpawnStatuses.mockResolvedValue({
      runId: 'run-mixrun42',
      statuses: {
        Olla: {
          status: 'error',
          launchState: 'failed_to_start',
          error: `spawn failed for ANTHROPIC_AUTH_TOKEN=${secret} opencode serve`,
          hardFailureReason: `wrapper --api-key ${secret} exited`,
          updatedAt: '2026-08-27T14:48:41.000Z',
        },
      },
    } as unknown as MemberSpawnStatusesSnapshot);
    getTeamAgentRuntimeSnapshot.mockResolvedValue({
      teamName: 'mixrun42',
      updatedAt: '2026-08-27T14:49:37.000Z',
      runId: 'run-mixrun42',
      members: {
        Olla: {
          memberName: 'Olla',
          alive: true,
          providerId: 'opencode',
          processCommand: `API_KEY=${secret} opencode serve --port 41231`,
          diagnostics: [`lane env carried API_KEY=${secret}`, 'x'.repeat(600)],
          updatedAt: '2026-08-27T14:49:37.000Z',
        },
      },
    } as unknown as TeamAgentRuntimeSnapshot);

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/teams/mixrun42/members/diagnostics',
      });

      expect(response.statusCode).toBe(200);
      expect(getTeamData).toHaveBeenCalledWith('mixrun42', { includeMemberBranches: false });
      expect(response.body).not.toContain(secret);
      const member = response.json().members[0];
      expect(member).toMatchObject({
        memberName: 'Olla',
        processCommand: '[redacted] opencode serve --port 41231',
        error: 'spawn failed for [redacted] opencode serve',
        hardFailureReason: 'wrapper --api-key [redacted] exited',
        memberCardError: 'spawn failed for [redacted] opencode serve',
        runtimeAdvisoryMessage: 'OpenCode API error for [redacted]',
      });
      expect(member.diagnostics).toContain('lane env carried [redacted]');
      expect(member.diagnostics).toContain(`${'x'.repeat(497)}...`);
      expect(member.diagnostics.every((diagnostic: string) => diagnostic.length <= 500)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('does not report advisories the member card deliberately keeps clean', async () => {
    const { app, getTeamData, getMemberSpawnStatuses, getTeamAgentRuntimeSnapshot } =
      await createApp();
    getTeamData.mockResolvedValue({
      teamName: 'mixrun42',
      members: [
        {
          name: 'Olla',
          providerId: 'opencode',
          runtimeAdvisory: {
            kind: 'api_error',
            reasonCode: 'protocol_proof_missing',
            observedAt: '2026-08-27T14:48:33.000Z',
            message: 'visible_reply_still_required',
          },
        },
        {
          name: 'Qwen',
          providerId: 'opencode',
          runtimeAdvisory: {
            kind: 'api_error',
            reasonCode: 'backend_error',
            observedAt: '2026-08-27T14:48:35.000Z',
            message: 'OpenCode session refresh scheduled after resolved behavior changed',
          },
        },
      ],
    } as unknown as TeamViewSnapshot);
    getMemberSpawnStatuses.mockResolvedValue({
      runId: 'run-mixrun42',
      statuses: {
        Olla: { status: 'online', launchState: 'confirmed_alive', bootstrapConfirmed: true },
        Qwen: { status: 'online', launchState: 'confirmed_alive', bootstrapConfirmed: true },
      },
    } as unknown as MemberSpawnStatusesSnapshot);
    getTeamAgentRuntimeSnapshot.mockResolvedValue({
      teamName: 'mixrun42',
      updatedAt: '2026-08-27T14:49:37.000Z',
      runId: 'run-mixrun42',
      members: {
        Olla: { memberName: 'Olla', alive: true, providerId: 'opencode' },
        Qwen: { memberName: 'Qwen', alive: true, providerId: 'opencode' },
      },
    } as unknown as TeamAgentRuntimeSnapshot);

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/teams/mixrun42/members/diagnostics',
      });

      expect(response.statusCode).toBe(200);
      const [olla, qwen] = response.json().members;
      expect(olla.memberCardError).toBeUndefined();
      expect(olla).toMatchObject({
        runtimeAdvisoryKind: 'api_error',
        runtimeAdvisoryReasonCode: 'protocol_proof_missing',
        diagnostics: ['visible_reply_still_required'],
      });
      expect(qwen.memberCardError).toBeUndefined();
      expect(qwen).toMatchObject({
        runtimeAdvisoryKind: 'api_error',
        diagnostics: ['OpenCode session refresh scheduled after resolved behavior changed'],
      });
    } finally {
      await app.close();
    }
  });

  it('drops healed spawn failures from the member card error but keeps unsafe ones', async () => {
    const { app, getTeamData, getMemberSpawnStatuses, getTeamAgentRuntimeSnapshot } =
      await createApp();
    const provisionedButNotAlive =
      'CLI process exited (code unknown) - team provisioned but not alive';
    getTeamData.mockResolvedValue({
      teamName: 'mixrun42',
      members: [{ name: 'Olla' }, { name: 'Qwen' }],
    } as unknown as TeamViewSnapshot);
    getMemberSpawnStatuses.mockResolvedValue({
      runId: 'run-mixrun42',
      statuses: {
        Olla: {
          status: 'error',
          launchState: 'failed_to_start',
          hardFailure: true,
          error: provisionedButNotAlive,
          hardFailureReason: provisionedButNotAlive,
          bootstrapConfirmed: true,
          livenessKind: 'confirmed_bootstrap',
          updatedAt: '2026-08-27T14:48:41.000Z',
        },
        Qwen: {
          status: 'error',
          launchState: 'failed_to_start',
          hardFailure: true,
          error: provisionedButNotAlive,
          hardFailureReason: provisionedButNotAlive,
          bootstrapConfirmed: true,
          livenessKind: 'not_found',
          updatedAt: '2026-08-27T14:48:41.000Z',
        },
      },
    } as unknown as MemberSpawnStatusesSnapshot);
    getTeamAgentRuntimeSnapshot.mockResolvedValue({
      teamName: 'mixrun42',
      updatedAt: '2026-08-27T14:49:37.000Z',
      runId: 'run-mixrun42',
      members: {
        Olla: {
          memberName: 'Olla',
          alive: true,
          livenessKind: 'runtime_process',
          updatedAt: '2026-08-27T14:49:37.000Z',
        },
      },
    } as unknown as TeamAgentRuntimeSnapshot);

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/teams/mixrun42/members/diagnostics',
      });

      expect(response.statusCode).toBe(200);
      const [olla, qwen] = response.json().members;
      expect(olla.memberCardError).toBeUndefined();
      // The evidence stays in the payload; only the card-error claim is dropped.
      expect(olla).toMatchObject({
        hardFailureReason: provisionedButNotAlive,
        diagnostics: [provisionedButNotAlive],
      });
      expect(qwen.memberCardError).toBe(provisionedButNotAlive);
    } finally {
      await app.close();
    }
  });

  it('answers 404 for member diagnostics of an unknown team', async () => {
    const { app, getTeamData, getMemberSpawnStatuses, getTeamAgentRuntimeSnapshot } =
      await createApp();
    getTeamData.mockRejectedValue(new Error('Team not found: ghost-team'));
    getMemberSpawnStatuses.mockResolvedValue({
      runId: null,
      statuses: {},
    } as unknown as MemberSpawnStatusesSnapshot);
    getTeamAgentRuntimeSnapshot.mockResolvedValue({
      teamName: 'ghost-team',
      updatedAt: '2026-08-27T14:49:37.000Z',
      runId: null,
      members: {},
    } as unknown as TeamAgentRuntimeSnapshot);

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/teams/ghost-team/members/diagnostics',
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: 'Team not found: ghost-team' });
    } finally {
      await app.close();
    }
  });

  it('drops removed members unless the spawn or runtime snapshots still track them', async () => {
    const { app, getTeamData, getMemberSpawnStatuses, getTeamAgentRuntimeSnapshot } =
      await createApp();
    const removedAt = 1_756_300_000_000;
    getTeamData.mockResolvedValue({
      teamName: 'mixrun42',
      members: [{ name: 'Olla' }, { name: 'Ghost', removedAt }, { name: 'Tracked', removedAt }],
    } as unknown as TeamViewSnapshot);
    getMemberSpawnStatuses.mockResolvedValue({
      runId: 'run-mixrun42',
      statuses: {
        Olla: { status: 'online', launchState: 'confirmed_alive' },
        Tracked: { status: 'online', launchState: 'confirmed_alive' },
      },
    } as unknown as MemberSpawnStatusesSnapshot);
    getTeamAgentRuntimeSnapshot.mockResolvedValue({
      teamName: 'mixrun42',
      updatedAt: '2026-08-27T14:49:37.000Z',
      runId: 'run-mixrun42',
      members: { Olla: { memberName: 'Olla', alive: true } },
    } as unknown as TeamAgentRuntimeSnapshot);

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/teams/mixrun42/members/diagnostics',
      });

      expect(response.statusCode).toBe(200);
      const members = response.json().members;
      expect(members.map((member: { memberName: string }) => member.memberName)).toEqual([
        'Olla',
        'Tracked',
      ]);
      expect(members[0].removedAt).toBeUndefined();
      expect(members[1].removedAt).toBe(removedAt);
    } finally {
      await app.close();
    }
  });

  it('serves member work sync diagnostics and explicit refresh routes', async () => {
    const app = Fastify();
    const mocks = createServicesMock();
    const queueDiagnostics = {
      queued: 0,
      running: 0,
      enqueued: 2,
      coalesced: 1,
      reconciled: 1,
      dropped: 0,
      failed: 0,
      queuedItems: [],
      runningItems: [],
    };
    const metrics = {
      teamName: 'demo-team',
      generatedAt: '2026-05-05T00:00:00.000Z',
      memberCount: 1,
      stateCounts: {
        caught_up: 1,
        needs_sync: 0,
        still_working: 0,
        blocked: 0,
        inactive: 0,
        unknown: 0,
      },
      actionableItemCount: 0,
      wouldNudgeCount: 0,
      fingerprintChangeCount: 0,
      reportAcceptedCount: 0,
      reportRejectedCount: 0,
      recentEvents: [],
      phase2Readiness: {
        state: 'collecting_shadow_data',
        reasons: ['insufficient_members'],
        thresholds: {
          minObservedMembers: 2,
          minStatusEvents: 10,
          minObservationHours: 1,
          maxWouldNudgesPerMemberHour: 1,
          maxFingerprintChangesPerMemberHour: 1,
          maxReportRejectionRate: 0.1,
        },
        rates: {
          observationHours: 0,
          statusEventCount: 0,
          wouldNudgesPerMemberHour: 0,
          fingerprintChangesPerMemberHour: 0,
          reportRejectionRate: 0,
        },
        diagnostics: [],
      },
    };
    const refreshedStatus = {
      teamName: 'demo-team',
      memberName: 'bob',
      state: 'caught_up',
      agenda: {
        teamName: 'demo-team',
        memberName: 'bob',
        generatedAt: '2026-05-05T00:00:00.000Z',
        fingerprint: 'empty',
        items: [],
        diagnostics: [],
      },
      evaluatedAt: '2026-05-05T00:00:00.000Z',
      diagnostics: [],
    };
    const memberWorkSyncFeature = {
      getStatus: vi.fn(),
      refreshStatus: vi.fn(() => Promise.resolve(refreshedStatus)),
      getMetrics: vi.fn(() => Promise.resolve(metrics)),
      report: vi.fn(() =>
        Promise.resolve({
          accepted: true,
          code: 'accepted',
          message: 'ok',
          status: refreshedStatus,
        })
      ),
      noteTeamChange: vi.fn(),
      enqueueStartupScan: vi.fn(),
      replayPendingReports: vi.fn(),
      dispatchDueNudges: vi.fn(),
      buildRuntimeTurnSettledHookSettings: vi.fn(),
      buildRuntimeTurnSettledEnvironment: vi.fn(),
      drainRuntimeTurnSettledEvents: vi.fn(),
      getQueueDiagnostics: vi.fn(() => queueDiagnostics),
      dispose: vi.fn(),
    } as unknown as NonNullable<HttpServices['memberWorkSyncFeature']>;
    registerTeamRoutes(app, {
      ...mocks.services,
      memberWorkSyncFeature,
    });
    await app.ready();

    try {
      const diagnosticsResponse = await app.inject({
        method: 'GET',
        url: '/api/teams/demo-team/member-work-sync/diagnostics',
      });
      expect(diagnosticsResponse.statusCode).toBe(200);
      expect(diagnosticsResponse.json()).toMatchObject({
        teamName: 'demo-team',
        queue: queueDiagnostics,
        metrics,
      });

      const refreshResponse = await app.inject({
        method: 'POST',
        url: '/api/teams/demo-team/member-work-sync/bob/refresh',
      });
      expect(refreshResponse.statusCode).toBe(200);
      expect(refreshResponse.json()).toMatchObject(refreshedStatus);
      expect(memberWorkSyncFeature.refreshStatus).toHaveBeenCalledWith({
        teamName: 'demo-team',
        memberName: 'bob',
      });

      const reportResponse = await app.inject({
        method: 'POST',
        url: '/api/teams/demo-team/member-work-sync/report',
        payload: {
          memberName: 'bob',
          state: 'still_working',
          agendaFingerprint: 'agenda:v1:abc',
          reportToken: 'wrs:v1.test.token',
          taskIds: [' task-a ', '', 'task-a'],
        },
      });
      expect(reportResponse.statusCode).toBe(200);
      expect(memberWorkSyncFeature.report).toHaveBeenCalledWith({
        teamName: 'demo-team',
        memberName: 'bob',
        state: 'still_working',
        agendaFingerprint: 'agenda:v1:abc',
        reportToken: 'wrs:v1.test.token',
        taskIds: ['task-a'],
        source: 'mcp',
      });
    } finally {
      await app.close();
    }
  });
});
