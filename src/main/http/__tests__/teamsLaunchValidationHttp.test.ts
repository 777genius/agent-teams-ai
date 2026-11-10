import { TeamLaunchValidationError } from '@main/services/team/provisioning/TeamLaunchValidationError';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerTeamRoutes } from '../teams';

import type { HttpServices } from '../index';
import type { FastifyInstance } from 'fastify';

function createServices(launchError: unknown): HttpServices {
  return {
    teamApis: {
      provisioningStart: {
        createTeam: vi.fn(),
        launchTeam: vi.fn().mockRejectedValue(launchError),
      },
    },
  } as unknown as HttpServices;
}

describe('POST /api/teams/:teamName/launch error mapping', () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  async function injectLaunch(launchError: unknown) {
    app = Fastify();
    registerTeamRoutes(app, createServices(launchError));
    return app.inject({
      method: 'POST',
      url: '/api/teams/demo-team/launch',
      payload: { cwd: process.cwd(), providerId: 'opencode' },
    });
  }

  it('maps TeamLaunchValidationError to 422 with the real validation message', async () => {
    const message =
      'Mixed teams with an OpenCode lead are not supported in this phase. ' +
      'Keep the team lead on Anthropic or Codex when you mix OpenCode with other providers.';
    const response = await injectLaunch(new TeamLaunchValidationError(message));
    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({ error: message });
  });

  it('keeps unexpected launch failures as opaque 500 responses', async () => {
    const response = await injectLaunch(new Error('unexpected internal failure'));
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: 'Internal server error' });
    // Unexpected failures must stay observable in the log even though the HTTP
    // body is opaque; consume the expected logger.error call so the global
    // console guard in test/setup.ts does not flag it.
    const errorSpy = vi.mocked(console.error);
    expect(
      errorSpy.mock.calls.some((call) =>
        call.some((arg) => String(arg).includes('unexpected internal failure'))
      )
    ).toBe(true);
    errorSpy.mockClear();
  });
});
