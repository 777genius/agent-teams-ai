import { createTeamRuntimeLaneCoordinator } from '@features/team-runtime-lanes/main';
import { describe, expect, it } from 'vitest';

import { TeamLaunchValidationError } from '../TeamLaunchValidationError';
import {
  createMixedSecondaryLaneStates,
  planRuntimeLanesOrThrow,
  shouldRouteOpenCodeToRuntimeAdapter,
} from '../TeamProvisioningRuntimeBootstrapDelivery';

import type { TeamCreateRequest } from '@shared/types';

function member(
  name: string,
  providerId: 'anthropic' | 'codex' | 'opencode',
  extra: Partial<TeamCreateRequest['members'][number]> = {}
): TeamCreateRequest['members'][number] {
  return {
    name,
    role: 'engineer',
    providerId,
    ...extra,
  } as TeamCreateRequest['members'][number];
}

describe('TeamProvisioningRuntimeBootstrapDelivery', () => {
  it('routes only pure OpenCode requests when the runtime adapter exists', () => {
    expect(
      shouldRouteOpenCodeToRuntimeAdapter(
        {
          providerId: 'opencode',
          members: [member('Ada', 'opencode')],
        },
        true
      )
    ).toBe(true);

    expect(
      shouldRouteOpenCodeToRuntimeAdapter(
        {
          providerId: 'opencode',
          members: [member('Ada', 'opencode')],
        },
        false
      )
    ).toBe(false);

    expect(
      shouldRouteOpenCodeToRuntimeAdapter(
        {
          providerId: 'codex',
          members: [member('Ada', 'codex'), member('Grace', 'opencode')],
        },
        true
      )
    ).toBe(false);
  });

  it('plans OpenCode side lanes only when the runtime adapter is available', () => {
    const coordinator = createTeamRuntimeLaneCoordinator();
    const members = [member('Ada', 'codex'), member('Grace', 'opencode')];

    expect(() =>
      planRuntimeLanesOrThrow(coordinator, {
        leadProviderId: 'codex',
        members,
        hasOpenCodeRuntimeAdapter: false,
      })
    ).toThrow('OpenCode side lanes require the OpenCode runtime adapter to be registered.');

    const plan = planRuntimeLanesOrThrow(coordinator, {
      leadProviderId: 'codex',
      members,
      hasOpenCodeRuntimeAdapter: true,
    });

    expect(plan.mode).toBe('mixed_opencode_side_lanes');
    expect(plan.primaryMembers.map((candidate) => candidate.name)).toEqual(['Ada']);
    expect(createMixedSecondaryLaneStates(plan)).toMatchObject([
      {
        laneId: 'secondary:opencode:Grace',
        providerId: 'opencode',
        state: 'queued',
        member: { name: 'Grace' },
      },
    ]);
  });

  it('retypes lane-plan rejections as user-facing launch validation errors', () => {
    const coordinator = createTeamRuntimeLaneCoordinator();
    const run = () =>
      planRuntimeLanesOrThrow(coordinator, {
        leadProviderId: 'opencode',
        members: [member('Ada', 'anthropic')],
        hasOpenCodeRuntimeAdapter: true,
      });

    expect(run).toThrow(TeamLaunchValidationError);
    expect(run).toThrow('Mixed teams with an OpenCode lead are not supported in this phase');
  });
});
