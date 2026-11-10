import { describe, expect, it } from 'vitest';

import {
  isOpenCodeSoloRuntimeRoster,
  resolveOpenCodeSoloMemberIdentityFromDirectory,
  resolveOpenCodeSoloRuntimeRecipientProviderId,
} from '../TeamProvisioningOpenCodeSoloRuntime';

import type { TeamConfig, TeamMember } from '@shared/types';

function createOpenCodeLeadOnlyConfig(overrides: Partial<TeamConfig> = {}): TeamConfig {
  return {
    name: 'solo-team',
    projectPath: '/fake/solo-team',
    members: [
      {
        name: 'team-lead',
        role: 'Team Lead',
        providerId: 'opencode',
        model: 'opencode/big-pickle',
      },
    ],
    ...overrides,
  };
}

describe('TeamProvisioningOpenCodeSoloRuntime', () => {
  it('recognizes an empty OpenCode-led roster as a solo runtime roster', () => {
    expect(
      isOpenCodeSoloRuntimeRoster({
        config: createOpenCodeLeadOnlyConfig(),
        metaMembers: [],
      })
    ).toBe(true);
  });

  it('does not treat configured or active metadata teammates as solo runtime rosters', () => {
    const activeMetaMember: TeamMember = {
      name: 'alice',
      role: 'Reviewer',
      providerId: 'opencode',
    };

    expect(
      isOpenCodeSoloRuntimeRoster({
        config: createOpenCodeLeadOnlyConfig({
          members: [
            { name: 'team-lead', role: 'Team Lead', providerId: 'opencode' },
            { name: 'bob', role: 'Developer', providerId: 'opencode' },
          ],
        }),
        metaMembers: [],
      })
    ).toBe(false);
    expect(
      isOpenCodeSoloRuntimeRoster({
        config: createOpenCodeLeadOnlyConfig(),
        metaMembers: [activeMetaMember],
      })
    ).toBe(false);
  });

  it('resolves the runtime-only solo identity on the primary OpenCode lane', () => {
    const identity = resolveOpenCodeSoloMemberIdentityFromDirectory(' SOLO ', {
      config: createOpenCodeLeadOnlyConfig(),
      teamMeta: null,
      metaMembers: [],
    });

    expect(identity).toMatchObject({
      ok: true,
      canonicalMemberName: 'solo',
      laneId: 'primary',
      laneIdentity: {
        laneId: 'primary',
        laneKind: 'primary',
        laneOwnerProviderId: 'opencode',
      },
      metaMember: {
        name: 'solo',
        role: 'Solo OpenCode Agent',
        providerId: 'opencode',
        cwd: '/fake/solo-team',
      },
      memberRuntimeCwd: '/fake/solo-team',
    });
  });

  it('only reports OpenCode provider ownership for the synthetic solo recipient', () => {
    const config = createOpenCodeLeadOnlyConfig();

    expect(
      resolveOpenCodeSoloRuntimeRecipientProviderId({
        memberName: 'solo',
        config,
        metaMembers: [],
      })
    ).toBe('opencode');
    expect(
      resolveOpenCodeSoloRuntimeRecipientProviderId({
        memberName: 'alice',
        config,
        metaMembers: [],
      })
    ).toBeUndefined();
  });
});
