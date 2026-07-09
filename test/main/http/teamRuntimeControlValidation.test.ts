import { registerTeamRoutes } from '@main/http/teams';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import type { HttpServices } from '@main/http';
import type {
  OpenCodeRuntimeControlAck,
  TeamRuntimeControlCompatibilityApi,
} from '@main/services/team/contracts/TeamProvisioningApis';

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
    teamRuntimeControlApi,
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
