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
    ).toThrow('OpenCode side lanes require the OpenCode runtime adapter');
  });

  it('drops stale hard-failure reasons when secondary OpenCode evidence later confirms alive', () => {
    const coordinator = createTeamRuntimeLaneCoordinator();

    const snapshot = coordinator.buildAggregateLaunchSnapshot({
      teamName: 'mixed-team',
      launchPhase: 'active',
      leadDefaults: {
        providerId: 'codex',
      },
      primaryMembers: [],
      primaryStatuses: {},
      secondaryMembers: [
        {
          laneId: 'secondary:opencode:jack',
          member: {
            name: 'jack',
            providerId: 'opencode',
            model: 'qwen/qwen3-coder',
          },
          leadDefaults: {
            providerId: 'codex',
          },
          evidence: {
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
            hardFailureReason: 'OpenCode bridge reported member launch failure',
            diagnostics: ['OpenCode runtime bootstrap check-in accepted'],
          },
        },
      ],
    });

    expect(snapshot.members.jack).toMatchObject({
      launchState: 'confirmed_alive',
      hardFailure: false,
      hardFailureReason: undefined,
    });
    expect(snapshot.members.jack.diagnostics).not.toContain(
      'hard failure reason: OpenCode bridge reported member launch failure'
    );
  });
});
