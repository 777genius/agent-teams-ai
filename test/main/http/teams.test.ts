import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { registerTeamRoutes } from '@main/http/teams';
import type { HttpServices } from '@main/http';
import type {
  TeamLaunchRequest,
  TeamLaunchResponse,
  TeamProvisioningProgress,
  TeamRuntimeState,
} from '@shared/types/team';

describe('HTTP team runtime routes', () => {
  function createServicesMock() {
    const launchTeam = vi.fn<
      (request: TeamLaunchRequest, onProgress: (progress: TeamProvisioningProgress) => void) => Promise<TeamLaunchResponse>
    >();
    const getRuntimeState = vi.fn<(teamName: string) => TeamRuntimeState>();
    const getProvisioningStatus = vi.fn<(runId: string) => Promise<TeamProvisioningProgress>>();
    const stopTeam = vi.fn<(teamName: string) => void>();
    const getAliveTeams = vi.fn<() => string[]>();
    const teamProvisioningService = {
      launchTeam,
      getRuntimeState,
      getProvisioningStatus,
      stopTeam,
      getAliveTeams,
    } as Pick<
      NonNullable<HttpServices['teamProvisioningService']>,
      'launchTeam' | 'getRuntimeState' | 'getProvisioningStatus' | 'stopTeam' | 'getAliveTeams'
    > as HttpServices['teamProvisioningService'];

    const services = {
      projectScanner: {} as HttpServices['projectScanner'],
      sessionParser: {} as HttpServices['sessionParser'],
      subagentResolver: {} as HttpServices['subagentResolver'],
      chunkBuilder: {} as HttpServices['chunkBuilder'],
      dataCache: {} as HttpServices['dataCache'],
      updaterService: {} as HttpServices['updaterService'],
      sshConnectionManager: {} as HttpServices['sshConnectionManager'],
      teamProvisioningService,
    } satisfies HttpServices;

    return {
      services,
      launchTeam,
      getRuntimeState,
      getProvisioningStatus,
      stopTeam,
      getAliveTeams,
    };
  }

  async function createApp() {
    const app = Fastify();
    const mocks = createServicesMock();
    registerTeamRoutes(app, mocks.services);
    await app.ready();
    return { app, ...mocks };
  }

  it('launches a team with validated request payload', async () => {
    const { app, launchTeam } = await createApp();
    launchTeam.mockResolvedValue({ runId: 'run-1' });

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/teams/demo-team/launch',
        payload: {
          cwd: '/tmp/project',
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
          cwd: '/tmp/project',
          prompt: 'Resume work',
          skipPermissions: false,
          clearContext: true,
        },
        expect.any(Function)
      );
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
    const { app, getRuntimeState, getProvisioningStatus, stopTeam, getAliveTeams } = await createApp();
    getRuntimeState
      .mockReturnValueOnce({
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
      .mockReturnValueOnce({
        teamName: 'demo-team',
        isAlive: false,
        runId: null,
        progress: null,
      })
      .mockReturnValueOnce({
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

  it('returns 501 when team runtime routes are registered without a runtime service', async () => {
    const app = Fastify();
    registerTeamRoutes(
      app,
      {
        projectScanner: {} as HttpServices['projectScanner'],
        sessionParser: {} as HttpServices['sessionParser'],
        subagentResolver: {} as HttpServices['subagentResolver'],
        chunkBuilder: {} as HttpServices['chunkBuilder'],
        dataCache: {} as HttpServices['dataCache'],
        updaterService: {} as HttpServices['updaterService'],
        sshConnectionManager: {} as HttpServices['sshConnectionManager'],
      } satisfies HttpServices
    );
    await app.ready();

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/teams/runtime/alive',
      });

      expect(response.statusCode).toBe(501);
      expect(response.json()).toEqual({ error: 'Team runtime control is not available in this mode' });
    } finally {
      await app.close();
    }
  });
});
