import { registerTeamRoutes } from '@main/http/teams';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import type { HttpServices } from '@main/http';
import type {
  OpenCodeRuntimeControlAck,
  TeamHttpHandlerApis,
  TeamRuntimeControlCompatibilityApi,
} from '@main/services/team/contracts/TeamProvisioningApis';

function unexpectedTeamApiCall(): never {
  throw new Error('Unexpected team API call in runtime-control validation fixture');
}

function createHttpServices(
  teamRuntimeControlApi: TeamRuntimeControlCompatibilityApi
): HttpServices {
  return {
    projectScanner: {} as HttpServices['projectScanner'],
    sessionParser: {} as HttpServices['sessionParser'],
    subagentResolver: {} as HttpServices['subagentResolver'],
    chunkBuilder: {} as HttpServices['chunkBuilder'],
    dataCache: {} as HttpServices['dataCache'],
    updaterService: {} as HttpServices['updaterService'],
    sshConnectionManager: {} as HttpServices['sshConnectionManager'],
    teamApis: {
      provisioningStart: {
        createTeam: unexpectedTeamApiCall,
        launchTeam: unexpectedTeamApiCall,
      },
      provisioningStatus: {
        getProvisioningStatus: unexpectedTeamApiCall,
      },
      taskActivity: {
        repairStaleTaskActivityIntervalsBeforeSnapshot: unexpectedTeamApiCall,
      },
      runtime: {
        getRuntimeState: unexpectedTeamApiCall,
        stopTeam: unexpectedTeamApiCall,
        getAliveTeams: unexpectedTeamApiCall,
      },
      runtimeControl: teamRuntimeControlApi,
    } satisfies TeamHttpHandlerApis,
  };
}

function createRuntimeControlApi(overrides: Partial<TeamRuntimeControlCompatibilityApi> = {}) {
  const ack = vi.fn<(raw: unknown) => Promise<OpenCodeRuntimeControlAck>>();
  const api = {
    recordOpenCodeRuntimeBootstrapCheckin: ack,
    deliverOpenCodeRuntimeMessage: ack,
    recordOpenCodeRuntimeTaskEvent: ack,
    recordOpenCodeRuntimeHeartbeat: ack,
    answerOpenCodeRuntimePermission: ack,
    ...overrides,
  } satisfies TeamRuntimeControlCompatibilityApi;

  return api;
}

describe('HTTP team runtime-control validation', () => {
  it('accepts omitted or valid heartbeat observedAt and rejects invalid provided values', async () => {
    const recordOpenCodeRuntimeHeartbeat =
      vi.fn<(raw: unknown) => Promise<OpenCodeRuntimeControlAck>>();
    recordOpenCodeRuntimeHeartbeat.mockResolvedValue({
      ok: true,
      providerId: 'opencode',
      teamName: 'demo-team',
      runId: 'run-opencode',
      state: 'recorded',
      memberName: 'builder',
      runtimeSessionId: 'session-1',
      diagnostics: [],
      observedAt: '2026-03-12T00:00:02.000Z',
    });
    const app = Fastify();
    registerTeamRoutes(
      app,
      createHttpServices(createRuntimeControlApi({ recordOpenCodeRuntimeHeartbeat }))
    );
    await app.ready();

    const heartbeat = {
      runId: 'run-opencode',
      memberName: 'builder',
      runtimeSessionId: 'session-1',
    };

    try {
      for (const observedAt of [undefined, '2026-03-12T00:00:02.000Z']) {
        const response = await app.inject({
          method: 'POST',
          url: '/api/teams/demo-team/opencode/runtime/heartbeat',
          payload: {
            ...heartbeat,
            ...(observedAt === undefined ? {} : { observedAt }),
          },
        });

        expect(response.statusCode).toBe(200);
        expect(recordOpenCodeRuntimeHeartbeat).toHaveBeenLastCalledWith({
          ...heartbeat,
          ...(observedAt === undefined ? {} : { observedAt }),
          teamName: 'demo-team',
        });
      }

      recordOpenCodeRuntimeHeartbeat.mockClear();
      for (const observedAt of ['not-a-date', 42]) {
        const response = await app.inject({
          method: 'POST',
          url: '/api/teams/demo-team/opencode/runtime/heartbeat',
          payload: { ...heartbeat, observedAt },
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

  it('maps invalid runtime delivery targets to 400', async () => {
    const deliverOpenCodeRuntimeMessage =
      vi.fn<(raw: unknown) => Promise<OpenCodeRuntimeControlAck>>();
    deliverOpenCodeRuntimeMessage.mockRejectedValueOnce(
      new Error('Runtime delivery target must be user or object')
    );
    const app = Fastify();
    registerTeamRoutes(
      app,
      createHttpServices(createRuntimeControlApi({ deliverOpenCodeRuntimeMessage }))
    );
    await app.ready();

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/teams/demo-team/opencode/runtime/deliver-message',
        payload: {
          runId: 'run-opencode',
          to: 42,
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: 'Runtime delivery target must be user or object',
      });
    } finally {
      await app.close();
    }
  });

  it('maps missing runtime delivery idempotency identifiers to 400', async () => {
    const deliverOpenCodeRuntimeMessage =
      vi.fn<(raw: unknown) => Promise<OpenCodeRuntimeControlAck>>();
    deliverOpenCodeRuntimeMessage.mockRejectedValueOnce(
      new Error('Runtime delivery envelope missing idempotencyKey')
    );
    const app = Fastify();
    registerTeamRoutes(
      app,
      createHttpServices(createRuntimeControlApi({ deliverOpenCodeRuntimeMessage }))
    );
    await app.ready();

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/teams/demo-team/opencode/runtime/deliver-message',
        payload: {
          runId: 'run-opencode',
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: 'Runtime delivery envelope missing idempotencyKey',
      });
    } finally {
      await app.close();
    }
  });

  it('maps OpenCode runtime permission validation failures to 400', async () => {
    const answerOpenCodeRuntimePermission =
      vi.fn<(raw: unknown) => Promise<OpenCodeRuntimeControlAck>>();
    answerOpenCodeRuntimePermission.mockRejectedValueOnce(
      new Error('OpenCode runtime permission expectedMembers must be an array')
    );
    const app = Fastify();
    registerTeamRoutes(
      app,
      createHttpServices(createRuntimeControlApi({ answerOpenCodeRuntimePermission }))
    );
    await app.ready();

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/teams/demo-team/opencode/runtime/permission-answer',
        payload: {
          runId: 'run-opencode',
          expectedMembers: 'not-an-array',
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: 'OpenCode runtime permission expectedMembers must be an array',
      });
    } finally {
      await app.close();
    }
  });
});
