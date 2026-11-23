import { hostTeamSelectionKey } from '@features/agent-backend/renderer';
import { api } from '@renderer/api';
import { isProjectContextRecoveryError } from '@renderer/components/team/definitionEdit/projectContextRecoveryError';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentBackendApi } from '@features/agent-backend/contracts/operations';
import type { ElectronAPI, TeamsAPI } from '@shared/types/api';
import type { TeamDefinitionEditsTransport } from '@shared/types/teamDefinitionEdit';

const original = window.electronAPI;
afterEach(() => {
  window.electronAPI = original;
});

function install(teams: Partial<TeamsAPI>, agentBackend?: AgentBackendApi) {
  window.electronAPI = {
    teams: Object.freeze(teams),
    ...(agentBackend ? { agentBackend } : {}),
  } as ElectronAPI;
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
  it('preserves tagged native edit failures when the Host adapter is present', async () => {
    const message = 'Open the interrupted project first';
    const updateConfig = vi.fn(async () => ({
      type: 'team-definition-edit-refusal' as const,
      message,
      failure: { code: 'TEAM_PROJECT_CONTEXT_UNRECONCILED' as const },
    }));
    const raw = vi.fn(async () => {
      throw new Error(message);
    });
    const backend: AgentBackendApi = { getConnections: vi.fn(), invoke: vi.fn() };
    install({ updateConfig: raw, definitionEdits: createDefinitionEdits(updateConfig) }, backend);

    const error = await api.teams.updateConfig('builders', {}).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      message,
      failure: { code: 'TEAM_PROJECT_CONTEXT_UNRECONCILED' },
    });
    expect(isProjectContextRecoveryError(error)).toBe(true);
    expect(updateConfig).toHaveBeenCalledExactlyOnceWith('builders', {});
    expect(raw).not.toHaveBeenCalled();
    expect(backend.getConnections).not.toHaveBeenCalled();
    expect(backend.invoke).not.toHaveBeenCalled();
  });

  it('keeps Host roster edits on their captured backend when definition transport is present', async () => {
    const handleId = 'TEST-definition-owner';
    const teamName = hostTeamSelectionKey(handleId);
    const commandId = 'TEST-definition-edit';
    const expectedRevision = 'a'.repeat(64);
    const raw = vi.fn(async () => undefined);
    const transported = vi.fn(async () => undefined);
    const definitionEdits = createDefinitionEdits(async () => ({ name: 'Builders' }));
    definitionEdits.replaceMembers = transported;
    const backend: AgentBackendApi = {
      getConnections: vi.fn().mockResolvedValue({
        state: 'ready',
        bindings: [{ handle: { handleId }, label: 'Host', members: [] }],
      }),
      invoke: vi.fn().mockResolvedValue({
        ok: true,
        value: { commandId, revision: 'b'.repeat(64) },
      }),
    };
    install({ replaceMembers: raw, definitionEdits }, backend);

    await api.teams.replaceMembers(teamName, {
      members: [],
      command: { commandId, idempotencyKey: commandId },
      configuration: { expectedRevision },
    });

    expect(backend.invoke).toHaveBeenCalledExactlyOnceWith({
      handle: { handleId },
      commandId,
      operation: 'team.roster.replace',
      payload: { expectedRevision, members: [] },
    });
    expect(raw).not.toHaveBeenCalled();
    expect(transported).not.toHaveBeenCalled();
  });

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
