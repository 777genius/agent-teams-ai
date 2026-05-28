import { HostedIntegrationUseCases } from '@features/hosted-integrations/core/application';
import { HostedIntegrationDomainError } from '@features/hosted-integrations/core/domain';

import type {
  HostedGitHubActionCommandDto,
  HostedGitHubActionStatusDto,
  HostedGitHubRepositoryTargetDto,
  HostedIntegrationStateDto,
} from '@features/hosted-integrations/contracts';
import type { HostedIntegrationUseCasePorts } from '@features/hosted-integrations/core/application';

const now = '2026-01-01T00:00:00.000Z';

describe('HostedIntegrationUseCases', () => {
  it('refreshes target state before action submit and blocks disabled targets before upload', async () => {
    const actions = {
      getAgentGithubActionStatus: vi.fn(),
      submitAgentGithubAction: vi.fn(),
    };
    const stateStore = {
      ...createStateStore(),
      saveTargets: vi.fn(),
    };
    const ports = createPorts({
      actions,
      stateStore,
      targets: {
        ...createTargetsPort(),
        listTargets: vi.fn(async () => [target({ status: 'disabled', targetId: 'target_1' })]),
      },
    });
    const useCases = new HostedIntegrationUseCases(ports);

    await expect(useCases.submitAgentGithubAction(command())).rejects.toThrow(
      HostedIntegrationDomainError
    );

    expect(stateStore.saveTargets).toHaveBeenCalledWith([
      expect.objectContaining({ status: 'disabled', targetId: 'target_1' }),
    ]);
    expect(actions.submitAgentGithubAction).not.toHaveBeenCalled();
  });

  it('submits a trusted envelope only after the target is confirmed enabled', async () => {
    const status: HostedGitHubActionStatusDto = {
      actionRequestId: 'action_1',
      fetchedAt: now,
      status: 'queued',
    };
    const actions = {
      getAgentGithubActionStatus: vi.fn(),
      submitAgentGithubAction: vi.fn(async () => status),
    };
    const ports = createPorts({
      actions,
      targets: {
        ...createTargetsPort(),
        listTargets: vi.fn(async () => [target({ status: 'enabled', targetId: 'target_1' })]),
      },
    });
    const useCases = new HostedIntegrationUseCases(ports);

    await expect(useCases.submitAgentGithubAction(command())).resolves.toEqual(status);

    expect(actions.submitAgentGithubAction).toHaveBeenCalledWith(
      'agtcp_secret',
      expect.objectContaining({
        requestedBy: expect.objectContaining({
          agentId: 'agent:reviewer',
          teamId: 'team:core',
        }),
        requestId: 'github-action:stable',
        targetId: 'target_1',
      })
    );
  });

  it('clears local credentials when the configured control-plane origin changes', async () => {
    const stateStore = {
      ...createStateStore(),
      markSessionRevoked: vi.fn(),
      readState: vi.fn(async () =>
        state({
          controlPlaneBaseUrl: 'https://old-control-plane.example.com',
          session: {
            desktopClientId: 'desktop_1',
            fetchedAt: now,
            state: 'paired',
            workspaceId: 'workspace_1',
          },
        })
      ),
      saveControlPlaneBaseUrl: vi.fn(),
    };
    const tokenStore = {
      clearToken: vi.fn(),
      isAvailable: vi.fn(async () => true),
      readToken: vi.fn(async () => 'agtcp_secret'),
      writeToken: vi.fn(),
    };
    const ports = createPorts({ stateStore, tokenStore });
    const useCases = new HostedIntegrationUseCases(ports);

    await useCases.configure({ controlPlaneBaseUrl: 'https://new-control-plane.example.com' });

    expect(tokenStore.clearToken).toHaveBeenCalledTimes(1);
    expect(stateStore.markSessionRevoked).toHaveBeenCalledTimes(1);
    expect(stateStore.saveControlPlaneBaseUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        href: 'https://new-control-plane.example.com/',
        origin: 'https://new-control-plane.example.com',
      })
    );
  });

  it('keeps local credentials when only the control-plane path changes inside the same origin', async () => {
    const stateStore = {
      ...createStateStore(),
      markSessionRevoked: vi.fn(),
      readState: vi.fn(async () =>
        state({
          controlPlaneBaseUrl: 'https://control-plane.example.com/old',
          session: {
            desktopClientId: 'desktop_1',
            fetchedAt: now,
            state: 'paired',
            workspaceId: 'workspace_1',
          },
        })
      ),
    };
    const tokenStore = {
      clearToken: vi.fn(),
      isAvailable: vi.fn(async () => true),
      readToken: vi.fn(async () => 'agtcp_secret'),
      writeToken: vi.fn(),
    };
    const ports = createPorts({ stateStore, tokenStore });
    const useCases = new HostedIntegrationUseCases(ports);

    await useCases.configure({ controlPlaneBaseUrl: 'https://control-plane.example.com/new' });

    expect(tokenStore.clearToken).not.toHaveBeenCalled();
    expect(stateStore.markSessionRevoked).not.toHaveBeenCalled();
  });

  it('rotates the desktop token and refreshes the authenticated session', async () => {
    const stateStore = {
      ...createStateStore(),
      readState: vi.fn(async () =>
        state({
          session: {
            desktopClientId: 'desktop_1',
            fetchedAt: now,
            state: 'paired',
            workspaceId: 'workspace_1',
          },
        })
      ),
      saveSession: vi.fn(),
    };
    const tokenStore = {
      clearToken: vi.fn(),
      isAvailable: vi.fn(async () => true),
      readToken: vi.fn(async () => 'agtcp_old_secret'),
      writeToken: vi.fn(),
    };
    const connection = {
      bootstrapWorkspace: vi.fn(),
      getMe: vi.fn(async () => ({
        desktopClientId: 'desktop_1',
        fetchedAt: now,
        state: 'paired' as const,
        workspaceId: 'workspace_1',
      })),
      revokeSession: vi.fn(),
      rotateSessionToken: vi.fn(async () => ({ token: 'agtcp_new_secret' })),
    };
    const ports = createPorts({ connection, stateStore, tokenStore });
    const useCases = new HostedIntegrationUseCases(ports);

    await useCases.rotateSessionToken();

    expect(connection.rotateSessionToken).toHaveBeenCalledWith(
      'agtcp_old_secret',
      'desktop_1',
      'desktop-token-rotation:desktop_1:2026-01-01T00:00:00.000Z'
    );
    expect(tokenStore.writeToken).toHaveBeenCalledWith('agtcp_new_secret');
    expect(connection.getMe).toHaveBeenCalledWith('agtcp_new_secret');
    expect(stateStore.saveSession).toHaveBeenCalledWith(
      expect.objectContaining({ desktopClientId: 'desktop_1' })
    );
  });
});

function command(): HostedGitHubActionCommandDto {
  return {
    actionType: 'github.issue_comment.create',
    localAttemptId: 'attempt_1',
    payload: { body: 'Ready for review' },
    runtimeMember: {
      agentId: 'reviewer',
      agentName: 'Reviewer',
      teamId: 'core',
      teamName: 'Core',
    },
    targetId: 'target_1',
  };
}

function createPorts(
  overrides: Partial<HostedIntegrationUseCasePorts> = {}
): HostedIntegrationUseCasePorts {
  return {
    actions: {
      getAgentGithubActionStatus: vi.fn(),
      submitAgentGithubAction: vi.fn(),
    },
    browserOpen: { openExternal: vi.fn() },
    clock: { now: () => new Date(now) },
    connection: {
      bootstrapWorkspace: vi.fn(),
      getMe: vi.fn(),
      revokeSession: vi.fn(),
      rotateSessionToken: vi.fn(),
    },
    idGenerator: { stableActionRequestId: vi.fn(async () => 'github-action:stable') },
    pairing: {
      completePairing: vi.fn(),
      startPairing: vi.fn(),
    },
    setup: {
      getGitHubSetupStatus: vi.fn(),
      startGitHubSetup: vi.fn(),
    },
    stateStore: createStateStore(),
    targets: createTargetsPort(),
    tokenStore: {
      clearToken: vi.fn(),
      isAvailable: vi.fn(async () => true),
      readToken: vi.fn(async () => 'agtcp_secret'),
      writeToken: vi.fn(),
    },
    ...overrides,
  };
}

function createStateStore(): HostedIntegrationUseCasePorts['stateStore'] {
  return {
    markSessionRevoked: vi.fn(),
    readState: vi.fn(async () => state()),
    saveActionStatus: vi.fn(),
    saveConnections: vi.fn(),
    saveControlPlaneBaseUrl: vi.fn(),
    saveSession: vi.fn(),
    saveSetupSession: vi.fn(),
    saveTargets: vi.fn(),
  };
}

function createTargetsPort(): HostedIntegrationUseCasePorts['targets'] {
  return {
    disableTarget: vi.fn(),
    enableTarget: vi.fn(),
    listAvailableRepositories: vi.fn(),
    listConnections: vi.fn(),
    listTargets: vi.fn(async () => [target({ status: 'enabled', targetId: 'target_1' })]),
  };
}

function state(overrides: Partial<HostedIntegrationStateDto> = {}): HostedIntegrationStateDto {
  return {
    availability: {
      contractVersion: 'desktop-hosted-integrations-v1',
      status: 'available',
    },
    connections: [],
    fetchedAt: now,
    recentActions: [],
    targets: [],
    ...overrides,
  };
}

function target(
  overrides: Partial<HostedGitHubRepositoryTargetDto> = {}
): HostedGitHubRepositoryTargetDto {
  return {
    connectionId: 'connection_1',
    displayFullName: 'org/repo',
    displayName: 'repo',
    displayOwner: 'org',
    fetchedAt: now,
    githubRepositoryId: '123',
    status: 'enabled',
    targetId: 'target_1',
    ...overrides,
  };
}
