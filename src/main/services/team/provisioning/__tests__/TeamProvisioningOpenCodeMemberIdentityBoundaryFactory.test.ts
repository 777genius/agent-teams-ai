import { describe, expect, it, vi } from 'vitest';

import { createTeamProvisioningOpenCodeMemberIdentityBoundary } from '../TeamProvisioningOpenCodeMemberIdentityBoundaryFactory';

import type { TeamConfig } from '@shared/types';

function createConfig(members: TeamConfig['members']): TeamConfig {
  return {
    name: 'identity-boundary-team',
    projectPath: '/fake/identity-boundary-team',
    members,
  };
}

describe('TeamProvisioningOpenCodeMemberIdentityBoundaryFactory', () => {
  it('wires team-scoped runtime state into OpenCode member identity resolution', () => {
    const getSecondaryRuntimeRuns = vi.fn(() => [
      {
        laneId: 'opencode-secondary-worker',
        memberName: 'worker',
        cwd: '/runtime/worker',
      },
    ]);
    const getRuntimeAdapterProviderId = vi.fn(() => null);
    const boundary = createTeamProvisioningOpenCodeMemberIdentityBoundary({
      getSecondaryRuntimeRuns,
      getRuntimeAdapterProviderId,
    });

    const identity = boundary.resolveOpenCodeMemberIdentityFromDirectory('alpha', 'worker', {
      config: createConfig([
        { name: 'lead', role: 'Team Lead', providerId: 'anthropic' },
        { name: 'worker', role: 'Developer', providerId: 'opencode', cwd: '/config/worker' },
      ]),
      teamMeta: null,
      metaMembers: [],
    });

    expect(identity).toMatchObject({
      ok: true,
      canonicalMemberName: 'worker',
      laneId: 'opencode-secondary-worker',
      memberRuntimeCwd: '/runtime/worker',
    });
    expect(getSecondaryRuntimeRuns).toHaveBeenCalledWith('alpha');
    expect(getRuntimeAdapterProviderId).toHaveBeenCalledWith('alpha');
  });
});
