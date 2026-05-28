import { HostedIntegrationDomainError } from '@features/hosted-integrations/core/domain';
import { ControlPlaneHttpClient } from '@features/hosted-integrations/main/infrastructure/ControlPlaneHttpClient';

describe('ControlPlaneHttpClient', () => {
  it('sends desktop bearer token only to normalized control-plane routes', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            desktopClientId: 'desktop_1',
            workspaceId: 'workspace_1',
          }),
          { headers: { 'content-type': 'application/json' }, status: 200 }
        )
    ) as typeof fetch;
    const client = new ControlPlaneHttpClient({
      allowLocalhostHttp: true,
      fetchImpl,
      getBaseUrl: async () => 'http://127.0.0.1:4100',
    });

    const session = await client.getMe('agtcp_secret');

    expect(session).toMatchObject({
      desktopClientId: 'desktop_1',
      state: 'paired',
      workspaceId: 'workspace_1',
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:4100/api/desktop/v1/me',
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: 'Bearer agtcp_secret',
        }),
        redirect: 'manual',
      })
    );
  });

  it('rejects redirects before following token-bearing requests', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('', {
          headers: { location: 'https://evil.example.com/callback' },
          status: 302,
        })
    ) as typeof fetch;
    const client = new ControlPlaneHttpClient({
      fetchImpl,
      getBaseUrl: async () => 'https://cp.example.com',
    });

    await expect(client.getMe('agtcp_secret')).rejects.toThrow(HostedIntegrationDomainError);
  });

  it('normalizes GitHub action status responses without raw credential fields', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            actionRequestId: 'action_1',
            githubUrl: 'https://github.com/org/repo/issues/1#issuecomment-1',
            status: 'succeeded',
            token: 'should-not-be-read',
          }),
          { status: 200 }
        )
    ) as typeof fetch;
    const client = new ControlPlaneHttpClient({
      fetchImpl,
      getBaseUrl: async () => 'https://cp.example.com',
    });

    const status = await client.getAgentGithubActionStatus('agtcp_secret', 'action_1');

    expect(status).toEqual({
      actionRequestId: 'action_1',
      fetchedAt: expect.any(String),
      githubUrl: 'https://github.com/org/repo/issues/1#issuecomment-1',
      status: 'succeeded',
    });
  });

  it('normalizes backend setup, repository, and action status aliases', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/api/desktop/v1/integrations/github/setup/start')) {
        return new Response(
          JSON.stringify({
            setupSessionId: 'setup_1',
            installUrl: 'https://github.com/apps/agent-teams/installations/new',
            status: 'install_url_created',
            expiresAt: '2026-01-01T00:10:00.000Z',
          }),
          { status: 200 }
        );
      }
      if (url.endsWith('/api/desktop/v1/integrations/connection_1/repository-targets/available')) {
        return new Response(
          JSON.stringify({
            repositories: [
              {
                providerRepositoryId: '123',
                displayOwner: 'org',
                displayName: 'repo',
                displayFullName: 'org/repo',
                target: { id: 'target_1', status: 'stale' },
              },
            ],
          }),
          { status: 200 }
        );
      }
      if (url.endsWith('/api/desktop/v1/github-actions/action_1')) {
        return new Response(
          JSON.stringify({
            actionRequestId: 'action_1',
            status: 'dispatching',
            safeFailure: {
              category: 'external',
              code: 'CONTROL_PLANE_GITHUB_RATE_LIMITED',
              message: 'GitHub rate limited the request.',
              retryable: true,
            },
          }),
          { status: 200 }
        );
      }
      throw new Error(`Unexpected URL ${url}`);
    }) as typeof fetch;
    const client = new ControlPlaneHttpClient({
      fetchImpl,
      getBaseUrl: async () => 'https://cp.example.com',
    });

    const setup = await client.startGitHubSetup('agtcp_secret');
    const repositories = await client.listAvailableRepositories('agtcp_secret', {
      connectionId: 'connection_1',
    });
    const actionStatus = await client.getAgentGithubActionStatus('agtcp_secret', 'action_1');

    expect(setup).toMatchObject({
      setupSessionId: 'setup_1',
      setupUrl: 'https://github.com/apps/agent-teams/installations/new',
      state: 'pending_installation',
    });
    expect(repositories[0]).toMatchObject({
      githubRepositoryId: '123',
      targetId: 'target_1',
    });
    expect(actionStatus).toMatchObject({
      actionRequestId: 'action_1',
      safeError: {
        code: 'CONTROL_PLANE_GITHUB_RATE_LIMITED',
        retryable: true,
      },
      status: 'dispatching',
    });
  });

  it('rotates desktop tokens through the workspace identity API', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            desktopClientId: 'desktop_1',
            desktopToken: 'agtcp_new_secret',
          }),
          { status: 200 }
        )
    ) as typeof fetch;
    const client = new ControlPlaneHttpClient({
      fetchImpl,
      getBaseUrl: async () => 'https://cp.example.com',
    });

    const result = await client.rotateSessionToken('agtcp_old_secret', 'desktop_1', 'rotation_1');

    expect(result).toEqual({ token: 'agtcp_new_secret' });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://cp.example.com/api/desktop/v1/clients/desktop_1/rotate-token',
      expect.objectContaining({
        body: JSON.stringify({ rotationRequestId: 'rotation_1' }),
        headers: expect.objectContaining({
          authorization: 'Bearer agtcp_old_secret',
        }),
        method: 'POST',
      })
    );
  });
});
