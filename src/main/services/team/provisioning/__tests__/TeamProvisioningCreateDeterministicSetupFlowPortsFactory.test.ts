import { describe, expect, it, vi } from 'vitest';

import { createAnthropicApiKeyHelperCleanupRetryOwner } from '../TeamProvisioningAnthropicApiKeyHelperLease';
import {
  createTeamProvisioningCreateDeterministicSetupFlowPortsFromService,
  type TeamProvisioningCreateDeterministicSetupFlowServiceHost,
} from '../TeamProvisioningCreateDeterministicSetupFlowPortsFactory';

import type { TeamCreateRequest } from '@shared/types';

function createHost(): TeamProvisioningCreateDeterministicSetupFlowServiceHost {
  return {
    anthropicApiKeyHelperCleanupRetryOwner: createAnthropicApiKeyHelperCleanupRetryOwner(),
    pathExists: vi.fn(async () => true),
    buildProvisioningEnv: vi.fn(async () => ({
      env: { PATH: '/bin' },
      authSource: 'none' as const,
      geminiRuntimeAuth: null,
    })),
    materializeEffectiveTeamMemberSpecs: vi.fn(async (params) => params.members),
    resolveOpenCodeMemberWorkspacesForRuntime: vi.fn(async (params) => params.members),
    planRuntimeLanesOrThrow: vi.fn(),
    buildCrossProviderMemberArgs: vi.fn(async () => ({
      args: [],
      providerArgsByProvider: new Map(),
      envPatch: {},
      usesAnthropicApiKeyHelper: false,
      ...({ anthropicApiKeyHelper: null } as const),
    })),
    resolveAndValidateLaunchIdentity: vi.fn(async () => null),
    createMixedSecondaryLaneStates: vi.fn(() => []),
    workspaceTrustPreSpawnBoundary: {
      getWorkspaceTrustCoordinator: vi.fn(() => null),
      workspaceTrustWorkspaceCollectionPorts: {
        getHomeDir: () => '/home/tester',
        realpath: vi.fn(async () => null),
        resolveGitRoot: vi.fn(async () => null),
        resolveCanonicalGitRoot: vi.fn(async (gitRoot) => gitRoot),
        platform: 'posix',
      },
    },
    runtimeTurnSettledEnvironmentProvider: null,
  };
}

describe('TeamProvisioningCreateDeterministicSetupFlowPortsFactory', () => {
  it('builds create setup flow ports from service-shaped dependencies', async () => {
    const host = createHost();
    const logger = { warn: vi.fn() };
    const ports = createTeamProvisioningCreateDeterministicSetupFlowPortsFromService(host, {
      logger,
      resolveClaudePath: vi.fn(async () => '/bin/claude'),
      buildMissingCliError: () => new Error('missing cli'),
    });
    const members: TeamCreateRequest['members'] = [{ name: 'Worker' }];

    await expect(ports.resolveClaudePath()).resolves.toBe('/bin/claude');
    expect(ports.buildMissingCliError().message).toBe('missing cli');
    await expect(ports.pathExists('/workspace')).resolves.toBe(true);
    await expect(
      ports.buildProvisioningEnv('codex', undefined, {
        includeCodexTeammateAuth: true,
        teamRuntimeAuth: { teamName: 'alpha' },
      })
    ).resolves.toMatchObject({ authSource: 'none' });
    await expect(
      ports.materializeEffectiveTeamMemberSpecs({
        claudePath: '/bin/claude',
        cwd: '/workspace',
        members,
        defaults: {},
      })
    ).resolves.toBe(members);
    await expect(
      ports.resolveOpenCodeMemberWorkspacesForRuntime({
        teamName: 'alpha',
        baseCwd: '/workspace',
        members,
      })
    ).resolves.toBe(members);

    expect(ports.workspaceTrustCoordinator).toBeNull();
    expect(ports.workspaceTrustWorkspaceCollectionPorts).toBe(
      host.workspaceTrustPreSpawnBoundary.workspaceTrustWorkspaceCollectionPorts
    );
    expect(ports.runtimeTurnSettledEnvironmentProvider).toBeNull();
    expect(ports.logger).toBe(logger);
    expect(host.pathExists).toHaveBeenCalledWith('/workspace');
    expect(host.buildProvisioningEnv).toHaveBeenCalledWith(
      'codex',
      undefined,
      expect.objectContaining({ includeCodexTeammateAuth: true })
    );
  });
});
