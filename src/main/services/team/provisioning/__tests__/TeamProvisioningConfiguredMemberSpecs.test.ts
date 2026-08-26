import { describe, expect, it } from 'vitest';

import {
  buildConfiguredProvisioningMember,
  buildPrimaryOwnedMemberSpecForRuntime,
} from '../TeamProvisioningConfiguredMemberSpecs';
import { buildEffectiveTeamMemberSpec } from '../TeamProvisioningMemberSpecs';

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
      runtimeSelectionProvenance: {
        version: 1,
        providerBackendId: 'explicit',
        model: 'explicit',
        effort: 'explicit',
      },
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
      runtimeSelectionProvenance: {
        version: 1,
        providerBackendId: 'explicit',
        model: 'explicit',
        effort: 'explicit',
      },
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
          runtimeSelectionProvenance: {
            version: 1,
            providerBackendId: 'inherited',
            model: 'inherited',
            effort: 'inherited',
          },
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
      runtimeSelectionProvenance: {
        version: 1,
        providerBackendId: 'inherited',
        model: 'inherited',
        effort: 'inherited',
      },
    });
  });

  it('does not inherit primary fast mode or backend for a different member runtime', () => {
    expect(
      buildPrimaryOwnedMemberSpecForRuntime({
        configuredMember: {
          name: 'Reviewer',
          providerId: 'opencode',
          model: 'opencode-model',
          runtimeSelectionProvenance: {
            version: 1,
            providerBackendId: 'inherited',
            model: 'explicit',
            effort: 'inherited',
          },
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
      providerBackendId: 'opencode-cli',
      model: 'opencode-model',
      effort: undefined,
      runtimeSelectionProvenance: {
        version: 1,
        providerBackendId: 'inherited',
        model: 'explicit',
        effort: 'inherited',
      },
    });
  });

  it('recomputes inherited restart axes from the current lead and preserves explicit axes', () => {
    expect(
      buildPrimaryOwnedMemberSpecForRuntime({
        configuredMember: {
          name: 'Builder',
          providerId: 'codex',
          providerBackendId: 'codex-native',
          model: 'gpt-5',
          effort: 'high',
          runtimeSelectionProvenance: {
            version: 1,
            providerBackendId: 'inherited',
            model: 'inherited',
            effort: 'explicit',
          },
        },
        request: {
          providerId: 'codex',
          providerBackendId: 'adapter',
          model: 'gpt-6',
          effort: 'xhigh',
          fastMode: 'off',
        },
      })
    ).toMatchObject({
      providerBackendId: 'adapter',
      model: 'gpt-6',
      effort: 'high',
      runtimeSelectionProvenance: {
        providerBackendId: 'inherited',
        model: 'inherited',
        effort: 'explicit',
      },
    });
  });

  it('fails closed for a partial legacy selection with missing provenance', () => {
    expect(() =>
      buildPrimaryOwnedMemberSpecForRuntime({
        configuredMember: { name: 'Legacy', model: 'gpt-5', effort: 'high' },
        request: {
          providerId: 'codex',
          providerBackendId: 'adapter',
          model: 'gpt-6',
          effort: 'xhigh',
          fastMode: 'off',
        },
      })
    ).toThrow(/unresolved legacy runtime selection provenance/);
  });

  it('rematerializes inherited axes for partial-launch continuation at the current roster revision', () => {
    expect(
      buildEffectiveTeamMemberSpec(
        {
          name: 'PendingWorker',
          providerId: 'codex',
          providerBackendId: 'codex-native',
          model: 'gpt-5',
          effort: 'high',
          runtimeSelectionProvenance: {
            version: 1,
            providerBackendId: 'inherited',
            model: 'explicit',
            effort: 'inherited',
          },
        },
        {
          providerId: 'codex',
          providerBackendId: 'adapter',
          model: 'gpt-6',
          effort: 'xhigh',
        }
      )
    ).toMatchObject({
      providerBackendId: 'adapter',
      model: 'gpt-5',
      effort: 'xhigh',
      runtimeSelectionProvenance: {
        providerBackendId: 'inherited',
        model: 'explicit',
        effort: 'inherited',
      },
    });
  });
});
