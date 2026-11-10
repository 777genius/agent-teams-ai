import { describe, expect, it, vi } from 'vitest';

import {
  createTeamProvisioningLaunchIdentityBoundary,
  type TeamProvisioningLaunchIdentityBoundaryDeps,
} from '../TeamProvisioningLaunchIdentityBoundaryFactory';

function createDeps(
  overrides: Partial<TeamProvisioningLaunchIdentityBoundaryDeps> = {}
): TeamProvisioningLaunchIdentityBoundaryDeps {
  return {
    execCli: vi.fn(async () => ({
      stdout: JSON.stringify({
        providers: {
          gemini: {
            defaultModel: 'gemini-default',
            models: ['gemini-default'],
          },
        },
      }),
      stderr: '',
    })),
    providerConnectionService: {
      getCodexModelCatalog: vi.fn(async () => null),
    },
    getAnthropicFastModeDefault: vi.fn(() => false),
    getProviderLabel: vi.fn((providerId) => providerId),
    logger: {
      warn: vi.fn(),
    },
    ...overrides,
  };
}

describe('TeamProvisioningLaunchIdentityBoundaryFactory', () => {
  it('wires direct member launch identity resolution through provisioning dependencies', async () => {
    const deps = createDeps();
    const boundary = createTeamProvisioningLaunchIdentityBoundary(deps);

    const identity = await boundary.resolveDirectMemberLaunchIdentity({
      claudePath: '/bin/claude',
      cwd: '/repo',
      providerId: 'gemini',
      provisioningEnv: {
        env: { PATH: '/bin' },
        providerArgs: ['--provider-arg'],
      },
      memberSpec: {
        name: 'Worker',
        model: 'gemini-default',
        effort: 'low',
      },
      requestLimitContext: true,
    });

    expect(identity).toMatchObject({
      providerId: 'gemini',
      providerBackendId: null,
      selectedModel: 'gemini-default',
      resolvedLaunchModel: 'gemini-default',
      selectedEffort: 'low',
      resolvedEffort: 'low',
    });
    expect(deps.execCli).toHaveBeenCalledWith(
      '/bin/claude',
      ['--provider-arg', 'model', 'list', '--json', '--provider', 'gemini'],
      expect.objectContaining({
        cwd: '/repo',
        env: { PATH: '/bin' },
      })
    );
    expect(deps.providerConnectionService.getCodexModelCatalog).not.toHaveBeenCalled();
    expect(deps.logger.warn).not.toHaveBeenCalled();
  });
});
