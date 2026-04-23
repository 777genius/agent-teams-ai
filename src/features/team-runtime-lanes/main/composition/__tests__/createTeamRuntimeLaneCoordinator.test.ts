import { describe, expect, it } from 'vitest';

import { createTeamRuntimeLaneCoordinator } from '../createTeamRuntimeLaneCoordinator';

describe('createTeamRuntimeLaneCoordinator', () => {
  it('plans a mixed OpenCode side lane when the adapter is available', () => {
    const coordinator = createTeamRuntimeLaneCoordinator();

    const plan = coordinator.planProvisioningMembers({
      leadProviderId: 'codex',
      hasOpenCodeRuntimeAdapter: true,
      members: [
        { name: 'alice', providerId: 'codex', model: 'gpt-5.4' },
        { name: 'tom', providerId: 'opencode', model: 'minimax-m2.5-free' },
      ],
    });

    expect(coordinator.isMixedSideLanePlan(plan)).toBe(true);
    expect(plan).toMatchObject({
      mode: 'mixed_opencode_side_lanes',
      primaryMembers: [{ name: 'alice', providerId: 'codex', model: 'gpt-5.4' }],
      sideLanes: [
        {
          laneId: 'secondary:opencode:tom',
          providerId: 'opencode',
          member: {
            name: 'tom',
            providerId: 'opencode',
            model: 'minimax-m2.5-free',
          },
        },
      ],
    });
  });

  it('rejects a mixed OpenCode side lane when the runtime adapter is unavailable', () => {
    const coordinator = createTeamRuntimeLaneCoordinator();

    expect(() =>
      coordinator.planProvisioningMembers({
        leadProviderId: 'codex',
        hasOpenCodeRuntimeAdapter: false,
        members: [
          { name: 'alice', providerId: 'codex', model: 'gpt-5.4' },
          { name: 'tom', providerId: 'opencode', model: 'minimax-m2.5-free' },
        ],
      })
    ).toThrow('Mixed teams with OpenCode side lanes require the OpenCode runtime adapter');
  });
});
