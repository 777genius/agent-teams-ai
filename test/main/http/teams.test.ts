import { registerTeamRoutes } from '@main/http/teams';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import type { HttpServices } from '@main/http';
import type {
  OpenCodeRuntimeControlAck,
  TeamHttpDataApi,
  TeamHttpRuntimeApi,
  TeamLaunchApi,
  TeamRuntimeControlCompatibilityApi,
  TeamTaskActivityRepairApi,
} from '@main/services/team/contracts/TeamProvisioningApis';
import type {
  TeamCreateConfigRequest,
  TeamCreateRequest,
  TeamCreateResponse,
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
    const repairStaleTaskActivityIntervalsBeforeSnapshot =
      vi.fn<(teamName: string) => Promise<void>>(() => Promise.resolve());
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
    const createTeam =
      vi.fn<
        (
          request: TeamCreateRequest,
          onProgress: (progress: TeamProvisioningProgress) => void
        ) => Promise<TeamCreateResponse>
      >();
    const listTeams = vi.fn<() => Promise<TeamSummary[]>>();
    const getTeamData = vi.fn<(teamName: string) => Promise<TeamViewSnapshot>>();
    const getSavedRequest = vi.fn<(teamName: string) => Promise<TeamCreateRequest | null>>();
    const createTeamConfig = vi.fn<(request: TeamCreateConfigRequest) => Promise<void>>(() =>
      Promise.resolve()
    );
    const teamLaunchApi = {
      createTeam,
      launchTeam,
      getProvisioningStatus,
    } satisfies Pick<TeamLaunchApi, 'createTeam' | 'launchTeam' | 'getProvisioningStatus'>;
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
    } satisfies TeamRuntimeControlCompatibilityApi;
    const teamDataApi = {
      listTeams,
      getTeamData,
      getSavedRequest,
      createTeamConfig,
    } as Pick<
      TeamHttpDataApi,
      'listTeams' | 'getTeamData' | 'getSavedRequest' | 'createTeamConfig'
    > as HttpServices['teamDataApi'];

    const services = {
      projectScanner: {} as HttpServices['projectScanner'],
      sessionParser: {} as HttpServices['sessionParser'],
      subagentResolver: {} as HttpServices['subagentResolver'],
      chunkBuilder: {} as HttpServices['chunkBuilder'],
      dataCache: {} as HttpServices['dataCache'],
      updaterService: {} as HttpServices['updaterService'],
      sshConnectionManager: {} as HttpServices['sshConnectionManager'],
      teamDataApi,
      teamProvisioningApis: {
        launch: teamLaunchApi,
        taskActivity: teamTaskActivityRepairApi,
        runtime: teamRuntimeApi,
        runtimeControl: teamRuntimeControlApi,
      },
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
      createTeam,
      listTeams,
      getTeamData,
      getSavedRequest,
      createTeamConfig,
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
    const { app, listTeams, getTeamData, createTeamConfig } = await createApp();
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
          members: [{ name: 'builder', role: 'Engineer', providerId: 'codex' }],
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
    const { app, createTeam, getSavedRequest, launchTeam } = await createApp();
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
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ runId: 'run-draft' });
      expect(launchTeam).not.toHaveBeenCalled();
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
        },
        expect.any(Function)
      );
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

  it('returns 501 for OpenCode runtime callbacks without the runtime-control facade', async () => {
    const app = Fastify();
    const mocks = createServicesMock();
    registerTeamRoutes(app, {
      ...mocks.services,
      teamProvisioningApis: {
        ...mocks.services.teamProvisioningApis,
        runtimeControl: undefined,
      },
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
      refreshStatus: vi.fn(async () => refreshedStatus),
      getMetrics: vi.fn(async () => metrics),
      report: vi.fn(async () => ({
        accepted: true,
        code: 'accepted',
        message: 'ok',
        status: refreshedStatus,
      })),
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
