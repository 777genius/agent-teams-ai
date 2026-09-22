import { describe, expect, it } from 'vitest';

import { resolveOpenCodeMemberIdentityFromDirectory } from '../TeamProvisioningOpenCodeMemberIdentity';

import type { TeamConfig } from '@shared/types';

function createDirectory(config: TeamConfig) {
  return {
    config,
    teamMeta: null,
    metaMembers: [],
  };
}

function createConfig(members: TeamConfig['members']): TeamConfig {
  return {
    name: 'identity-team',
    projectPath: '/fake/identity-team',
    members,
  };
}

describe('TeamProvisioningOpenCodeMemberIdentity', () => {
  it('rejects recipients that do not resolve to OpenCode', () => {
    expect(
      resolveOpenCodeMemberIdentityFromDirectory({
        memberName: 'alice',
        directory: createDirectory(
          createConfig([
            { name: 'lead', role: 'Team Lead', providerId: 'anthropic' },
            { name: 'alice', role: 'Reviewer', providerId: 'anthropic' },
          ])
        ),
      })
    ).toEqual({ ok: false, reason: 'recipient_is_not_opencode' });
  });

  it('uses active secondary runtime lanes before planned lane identity', () => {
    const identity = resolveOpenCodeMemberIdentityFromDirectory({
      memberName: 'builder',
      directory: createDirectory(
        createConfig([
          { name: 'lead', role: 'Team Lead', providerId: 'anthropic' },
          { name: 'builder', role: 'Builder', providerId: 'opencode', cwd: '/fake/config-cwd' },
        ])
      ),
      secondaryRuntimeRuns: [
        {
          laneId: 'opencode-secondary-builder',
          memberName: 'builder-2',
          cwd: '/fake/runtime-cwd',
        },
      ],
    });

    expect(identity).toMatchObject({
      ok: true,
      canonicalMemberName: 'builder',
      laneId: 'opencode-secondary-builder',
      laneIdentity: {
        laneId: 'opencode-secondary-builder',
        laneKind: 'secondary',
        laneOwnerProviderId: 'opencode',
      },
      memberRuntimeCwd: '/fake/runtime-cwd',
    });
  });

  it('uses OpenCode aggregate runtime identity when no secondary lane is active', () => {
    const identity = resolveOpenCodeMemberIdentityFromDirectory({
      memberName: 'worker',
      directory: createDirectory(
        createConfig([
          {
            name: 'lead',
            role: 'Team Lead',
            providerId: 'opencode',
            model: 'openrouter/shared-model',
          },
          {
            name: 'worker',
            role: 'Builder',
            providerId: 'opencode',
            model: 'openrouter/shared-model',
            cwd: '/fake/identity-team',
          },
        ])
      ),
      runtimeAdapterProviderId: 'opencode',
    });

    expect(identity).toMatchObject({
      ok: true,
      canonicalMemberName: 'worker',
      laneIdentity: {
        laneOwnerProviderId: 'opencode',
      },
      memberRuntimeCwd: '/fake/identity-team',
    });
  });

  it('reconstructs a pure OpenCode secondary model lane without in-memory runtime state', () => {
    const identity = resolveOpenCodeMemberIdentityFromDirectory({
      memberName: 'worker',
      directory: {
        ...createDirectory(
          createConfig([
            {
              name: 'team-lead',
              role: 'Team Lead',
              providerId: 'opencode',
              model: 'minimax-coding-plan/MiniMax-M3',
            },
            {
              name: 'worker',
              role: 'Builder',
              providerId: 'opencode',
              model: 'zai-coding-plan/glm-5.2',
            },
          ])
        ),
        teamMeta: {
          providerId: 'opencode',
          model: 'minimax-coding-plan/MiniMax-M3',
        },
      },
      runtimeAdapterProviderId: 'opencode',
    });

    expect(identity).toMatchObject({
      ok: true,
      canonicalMemberName: 'worker',
      laneId: 'secondary:opencode:worker',
      laneIdentity: {
        laneId: 'secondary:opencode:worker',
        laneKind: 'secondary',
        laneOwnerProviderId: 'opencode',
      },
    });
  });

  it('delegates the runtime-only solo recipient fallback', () => {
    const identity = resolveOpenCodeMemberIdentityFromDirectory({
      memberName: 'solo',
      directory: createDirectory(
        createConfig([{ name: 'team-lead', role: 'Team Lead', providerId: 'opencode' }])
      ),
    });

    expect(identity).toMatchObject({
      ok: true,
      canonicalMemberName: 'solo',
      laneId: 'primary',
      metaMember: {
        name: 'solo',
        role: 'Solo OpenCode Agent',
        providerId: 'opencode',
      },
    });
  });
});
