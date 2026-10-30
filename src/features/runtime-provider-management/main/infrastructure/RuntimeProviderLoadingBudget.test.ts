// @vitest-environment node
import { PROVIDER_CLI_TIMEOUT_MS } from '@shared/constants/runtimeLoading';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { execCliMock } = vi.hoisted(() => ({ execCliMock: vi.fn() }));
vi.mock('@main/utils/childProcess', () => ({
  execCli: execCliMock,
  spawnCli: vi.fn(),
  killProcessTree: vi.fn(),
}));
vi.mock('@main/services/team/ClaudeBinaryResolver', () => ({
  ClaudeBinaryResolver: {
    resolve: vi.fn(async () => '/TEST/agent-teams-cli'),
    clearCache: vi.fn(),
  },
}));
vi.mock('@main/utils/shellEnv', () => ({
  resolveInteractiveShellEnvBestEffort: vi.fn(async () => ({})),
}));
vi.mock('@main/services/runtime/providerAwareCliEnv', () => ({
  buildProviderAwareCliEnv: vi.fn(async () => ({ env: {} })),
}));

import { AgentTeamsRuntimeProviderManagementCliClient } from './AgentTeamsRuntimeProviderManagementCliClient';

describe('actual provider CLI loading allowance', () => {
  beforeEach(() => { execCliMock.mockReset(); });

  it('does not kill a model catalog at the old 90-second boundary', async () => {
    execCliMock.mockResolvedValue({ stdout: JSON.stringify({
      schemaVersion: 1, runtimeId: 'opencode', models: {
        runtimeId: 'opencode', providerId: 'openrouter', models: [], defaultModelId: null,
        diagnostics: [], catalogState: 'fresh',
      },
    }), stderr: '' });
    const response = await new AgentTeamsRuntimeProviderManagementCliClient().loadModels({
      runtimeId: 'opencode', providerId: 'openrouter', projectPath: '/TEST/slow-models',
    });
    expect(response.error).toBeUndefined();
    expect(execCliMock).toHaveBeenCalledWith(expect.anything(), expect.anything(),
      expect.objectContaining({ timeout: PROVIDER_CLI_TIMEOUT_MS }));
  });

  it('lets provider-directory loading and owned cleanup finish before the CLI cutoff', async () => {
    execCliMock.mockResolvedValue({ stdout: JSON.stringify({
      schemaVersion: 1, runtimeId: 'opencode', directory: {
        runtimeId: 'opencode', entries: [], diagnostics: [], nextCursor: null,
      },
    }), stderr: '' });
    await new AgentTeamsRuntimeProviderManagementCliClient().loadProviderDirectory({
      runtimeId: 'opencode', projectPath: '/TEST/slow-directory', summary: false,
    });
    expect(execCliMock).toHaveBeenCalled();
    for (const call of execCliMock.mock.calls) {
      expect(call[2]).toEqual(expect.objectContaining({ timeout: PROVIDER_CLI_TIMEOUT_MS }));
    }
  });
});
