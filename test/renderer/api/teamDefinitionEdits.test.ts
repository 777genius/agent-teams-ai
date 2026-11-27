import { api } from '@renderer/api';
import { isProjectContextRecoveryError } from '@renderer/components/team/definitionEdit/projectContextRecoveryError';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ElectronAPI, TeamsAPI } from '@shared/types/api';
import type { TeamDefinitionEditsTransport } from '@shared/types/teamDefinitionEdit';

const original = window.electronAPI;
afterEach(() => {
  window.electronAPI = original;
});

function install(teams: Partial<TeamsAPI>) {
  window.electronAPI = { teams: Object.freeze(teams) } as ElectronAPI;
}

function createDefinitionEdits(
  updateConfig: TeamDefinitionEditsTransport['updateConfig']
): TeamDefinitionEditsTransport {
  return {
    updateConfig,
    addMember: async () => undefined,
    replaceMembers: async () => undefined,
    removeMember: async () => undefined,
    restoreMember: async () => undefined,
    updateMemberRole: async () => undefined,
  };
}

describe('renderer definition edit refusal hydration', () => {
  it('hydrates a cloned refusal into a renderer Error without changing its message', async () => {
    const message = 'Open the interrupted project first';
    const updateConfig = vi.fn(async () => ({
      type: 'team-definition-edit-refusal' as const,
      message,
      failure: { code: 'TEAM_PROJECT_CONTEXT_UNRECONCILED' as const },
    }));
    const raw = vi.fn();
    install({
      updateConfig: raw,
      definitionEdits: createDefinitionEdits(updateConfig),
    });
    const error = await api.teams.updateConfig('builders', {}).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ message });
    expect(isProjectContextRecoveryError(error)).toBe(true);
    expect(updateConfig).toHaveBeenCalledExactlyOnceWith('builders', {});
    expect(raw).not.toHaveBeenCalled();
    expect(api.teams.updateConfig).toBe(api.teams.updateConfig);
  });

  it('preserves success values and unrelated rejection identity', async () => {
    const config = { name: 'Builders', members: [] };
    const unrelated = new Error('TEAM_PROJECT_CONTEXT_UNRECONCILED is only text here');
    const updateConfig = vi
      .fn<TeamDefinitionEditsTransport['updateConfig']>()
      .mockResolvedValueOnce(config)
      .mockRejectedValueOnce(unrelated);
    install({ definitionEdits: createDefinitionEdits(updateConfig) });
    await expect(api.teams.updateConfig('builders', {})).resolves.toBe(config);
    await expect(api.teams.updateConfig('builders', {})).rejects.toBe(unrelated);
    expect(isProjectContextRecoveryError(unrelated)).toBe(false);
  });

  it('requires the exact transport discriminator before interpreting a result', async () => {
    const config = {
      name: 'Builders',
      type: 'unrelated-result',
      message: 'Not a refusal',
      failure: { code: 'TEAM_PROJECT_CONTEXT_UNRECONCILED' },
    };
    install({
      definitionEdits: createDefinitionEdits(async () => config),
    });
    await expect(api.teams.updateConfig('builders', {})).resolves.toBe(config);
  });

  it('uses the existing API unchanged when the optional transport is absent', async () => {
    const config = { name: 'Builders' };
    const updateConfig = vi.fn(async () => config);
    install({ updateConfig });
    expect(api.teams).toBe(window.electronAPI.teams);
    await expect(api.teams.updateConfig('builders', {})).resolves.toBe(config);
    expect(updateConfig).toHaveBeenCalledExactlyOnceWith('builders', {});
  });
});
