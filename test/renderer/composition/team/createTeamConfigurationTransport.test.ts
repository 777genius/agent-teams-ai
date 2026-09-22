import { createTeamConfigurationTransport } from '@renderer/composition/team/createTeamConfigurationTransport';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  TeamConfig,
  TeamCreateConfigRequest,
  TeamCreateRequest,
  TeamUpdateConfigRequest,
} from '@shared/types';

const mocks = vi.hoisted(() => ({
  createConfig: vi.fn(),
  getSavedRequest: vi.fn(),
  updateConfig: vi.fn(),
}));

vi.mock('@renderer/api', () => ({
  api: {
    teams: mocks,
  },
}));

describe('createTeamConfigurationTransport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('delegates the narrow create, saved-request, and update capabilities unchanged', async () => {
    const createRequest: TeamCreateConfigRequest = {
      teamName: 'sandbox-team',
      members: [{ name: 'alice' }],
      cwd: '/sandbox/project',
    };
    const savedRequest: TeamCreateRequest = {
      ...createRequest,
      cwd: '/sandbox/project',
    };
    const updates: TeamUpdateConfigRequest = {
      name: 'Sandbox Team',
      description: 'Focused transport',
      color: 'blue',
    };
    const updated: TeamConfig = { ...updates, name: updates.name! };
    mocks.createConfig.mockResolvedValueOnce(undefined);
    mocks.getSavedRequest.mockResolvedValueOnce(savedRequest);
    mocks.updateConfig.mockResolvedValueOnce(updated);
    const transport = createTeamConfigurationTransport();

    await expect(transport.createConfig(createRequest)).resolves.toBeUndefined();
    await expect(transport.getSavedRequest('sandbox-team')).resolves.toBe(savedRequest);
    await expect(transport.updateConfig('sandbox-team', updates)).resolves.toBe(updated);
    expect(mocks.createConfig).toHaveBeenCalledWith(createRequest);
    expect(mocks.getSavedRequest).toHaveBeenCalledWith('sandbox-team');
    expect(mocks.updateConfig).toHaveBeenCalledWith('sandbox-team', updates);
  });

  it('preserves transport failures for dialog-specific error handling', async () => {
    const createFailure = new Error('create failed');
    const readFailure = new Error('read failed');
    const updateFailure = new Error('update failed');
    mocks.createConfig.mockRejectedValueOnce(createFailure);
    mocks.getSavedRequest.mockRejectedValueOnce(readFailure);
    mocks.updateConfig.mockRejectedValueOnce(updateFailure);
    const transport = createTeamConfigurationTransport();

    await expect(transport.createConfig({ teamName: 'sandbox-team', members: [] })).rejects.toBe(
      createFailure
    );
    await expect(transport.getSavedRequest('sandbox-team')).rejects.toBe(readFailure);
    await expect(transport.updateConfig('sandbox-team', {})).rejects.toBe(updateFailure);
  });
});
