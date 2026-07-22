import { describe, expect, it } from 'vitest';

import {
  buildConfiguredProvisioningMember,
  buildPrimaryOwnedMemberSpecForRuntime,
} from '../TeamProvisioningConfiguredMemberSpecs';

import type { EffectiveConfiguredMember } from '../TeamProvisioningMemberStatusProjection';

describe('TeamProvisioningConfiguredMemberSpecs', () => {
  it('projects configured member fields into a provisioning member spec', () => {
    const configuredMember: EffectiveConfiguredMember = {
      name: 'Builder',
      role: 'Implementer',
      workflow: 'ship changes',
      isolation: 'worktree',
      cwd: '/repo/workers/builder',
      providerId: 'codex',
      providerBackendId: 'codex-native',
      model: 'gpt-5',
      effort: 'high',
      fastMode: 'off',
      mcpPolicy: { mode: 'appOnly' },
      agentType: 'specialist',
      removedAt: 123,
    };

    expect(buildConfiguredProvisioningMember(configuredMember)).toEqual({
      name: 'Builder',
      role: 'Implementer',
      workflow: 'ship changes',
      isolation: 'worktree',
      cwd: '/repo/workers/builder',
      providerId: 'codex',
      providerBackendId: 'codex-native',
      model: 'gpt-5',
      effort: 'high',
      fastMode: 'off',
      mcpPolicy: { mode: 'appOnly' },
    });
  });

  it('applies primary runtime defaults to primary-owned members', () => {
    expect(
      buildPrimaryOwnedMemberSpecForRuntime({
        configuredMember: {
          name: 'Builder',
          role: 'Implementer',
          agentType: 'specialist',
        },
        request: {
          providerId: 'codex',
          providerBackendId: 'codex-native',
          model: 'gpt-5',
          effort: 'high',
          fastMode: 'on',
        },
      })
    ).toEqual({
      name: 'Builder',
      role: 'Implementer',
      providerId: 'codex',
      providerBackendId: 'codex-native',
      model: 'gpt-5',
      effort: 'high',
      fastMode: 'on',
      agentType: 'specialist',
    });
  });

  it('does not inherit primary fast mode or backend for a different member runtime', () => {
    expect(
      buildPrimaryOwnedMemberSpecForRuntime({
        configuredMember: {
          name: 'Reviewer',
          providerId: 'opencode',
          model: 'opencode-model',
        },
        request: {
          providerId: 'codex',
          providerBackendId: 'codex-native',
          model: 'gpt-5',
          effort: 'high',
          fastMode: 'on',
        },
      })
    ).toEqual({
      name: 'Reviewer',
      providerId: 'opencode',
      model: 'opencode-model',
      effort: undefined,
    });
  });
});
