import {
  createPersistedLaunchSnapshot,
  normalizePersistedLaunchSnapshot,
} from '@main/services/team/TeamLaunchStateEvaluator';
import { describe, expect, it } from 'vitest';

import type { PersistedTeamLaunchMemberState } from '@shared/types';

const at = '2026-08-28T12:20:00.000Z';

/** Exactly the fields `toOpenCodePersistedLaunchMember` stamps on a lane member. */
function openCodeLaneLead(
  overrides: Partial<PersistedTeamLaunchMemberState> = {}
): PersistedTeamLaunchMemberState {
  return {
    name: 'team-lead',
    providerId: 'opencode',
    laneId: 'primary',
    laneKind: 'primary',
    laneOwnerProviderId: 'opencode',
    launchState: 'failed_to_start',
    agentToolAccepted: false,
    runtimeAlive: false,
    bootstrapConfirmed: false,
    hardFailure: true,
    hardFailureReason: 'OpenCode primary lane produced no runtime evidence.',
    lastEvaluatedAt: at,
    ...overrides,
  };
}

function member(name: string): PersistedTeamLaunchMemberState {
  return {
    name,
    providerId: 'opencode',
    laneId: `secondary:opencode:${name}`,
    laneKind: 'secondary',
    laneOwnerProviderId: 'opencode',
    launchState: 'confirmed_alive',
    agentToolAccepted: true,
    runtimeAlive: true,
    bootstrapConfirmed: true,
    hardFailure: false,
    lastEvaluatedAt: at,
  };
}

function readBackOf(teamName: string, written: unknown) {
  return normalizePersistedLaunchSnapshot(teamName, JSON.parse(JSON.stringify(written)));
}

describe('normalizePersistedLaunchSnapshot keeps the OpenCode primary-lane lead', () => {
  it('stops reporting clean_success for a team whose lead is dead', () => {
    // The snapshot is written with `includeLeadMembers` and was read back without
    // it, so the lead vanished on read-back and only the healthy side lanes voted.
    const written = createPersistedLaunchSnapshot({
      teamName: 'lane-team',
      expectedMembers: ['team-lead', 'Ada', 'Ben'],
      includeLeadMembers: true,
      launchPhase: 'finished',
      members: {
        'team-lead': openCodeLaneLead(),
        Ada: member('Ada'),
        Ben: member('Ben'),
      },
      updatedAt: at,
    });

    const readBack = readBackOf('lane-team', written);

    expect(readBack?.members['team-lead']?.launchState).toBe('failed_to_start');
    expect(readBack?.teamLaunchState).toBe('partial_failure');
    expect(readBack?.summary?.failedCount).toBe(1);
    // The roster the UI renders is deliberately unchanged: the lead is a runtime
    // member, not a teammate card.
    expect(readBack?.expectedMembers).toEqual(['Ada', 'Ben']);
  });

  it('keeps a healthy lane-owned lead without changing the aggregate state', () => {
    const written = createPersistedLaunchSnapshot({
      teamName: 'lane-team',
      expectedMembers: ['team-lead', 'Ada'],
      includeLeadMembers: true,
      launchPhase: 'finished',
      members: {
        'team-lead': openCodeLaneLead({
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
          hardFailureReason: undefined,
        }),
        Ada: member('Ada'),
      },
      updatedAt: at,
    });

    const readBack = readBackOf('lane-team', written);

    expect(readBack?.members['team-lead']?.launchState).toBe('confirmed_alive');
    expect(readBack?.teamLaunchState).toBe('clean_success');
  });

  // NEGATIVE CONTROL: the persisted-lane policy applies only to lane-owned
  // members. A stale snapshot whose lead is not lane-owned must read back
  // exactly as it did before this change - lead dropped, side lanes voting.
  it('leaves a lead that is not lane-owned dropped exactly as before', () => {
    const written = createPersistedLaunchSnapshot({
      teamName: 'native-lead-team',
      expectedMembers: ['team-lead', 'Ada'],
      includeLeadMembers: true,
      launchPhase: 'finished',
      members: {
        'team-lead': openCodeLaneLead({
          providerId: 'anthropic',
          laneOwnerProviderId: undefined,
        }),
        Ada: member('Ada'),
      },
      updatedAt: at,
    });

    const readBack = readBackOf('native-lead-team', written);

    expect(readBack?.members['team-lead']).toBeUndefined();
    expect(readBack?.teamLaunchState).toBe('clean_success');
  });

  // NEGATIVE CONTROL: the same stale read-back for a lead that runs on the
  // OpenCode provider but whose lane is owned by another runtime. Provider alone
  // is not the discriminator; lane ownership is.
  it('leaves an OpenCode lead on a foreign-owned lane dropped exactly as before', () => {
    const written = createPersistedLaunchSnapshot({
      teamName: 'mixed-lane-team',
      expectedMembers: ['team-lead', 'Ada'],
      includeLeadMembers: true,
      launchPhase: 'finished',
      members: {
        'team-lead': openCodeLaneLead({ laneOwnerProviderId: 'anthropic' }),
        Ada: member('Ada'),
      },
      updatedAt: at,
    });

    const readBack = readBackOf('mixed-lane-team', written);

    expect(readBack?.members['team-lead']).toBeUndefined();
    expect(readBack?.teamLaunchState).toBe('clean_success');
  });

  it('does not misclassify a secondary-lane member named team-lead as the primary lead', () => {
    const written = createPersistedLaunchSnapshot({
      teamName: 'lane-team',
      expectedMembers: ['team-lead', 'Ada'],
      includeLeadMembers: true,
      launchPhase: 'finished',
      members: {
        'team-lead': openCodeLaneLead({
          laneKind: 'secondary',
          laneId: 'secondary:opencode:team-lead',
        }),
        Ada: member('Ada'),
      },
      updatedAt: at,
    });

    expect(readBackOf('lane-team', written)?.members['team-lead']).toBeUndefined();
  });

  it('accepts a legacy lane member that carries laneId but no laneKind', () => {
    const written = createPersistedLaunchSnapshot({
      teamName: 'lane-team',
      expectedMembers: ['team-lead', 'Ada'],
      includeLeadMembers: true,
      launchPhase: 'finished',
      members: {
        'team-lead': openCodeLaneLead({ laneKind: undefined }),
        Ada: member('Ada'),
      },
      updatedAt: at,
    });

    expect(readBackOf('lane-team', written)?.members['team-lead']?.launchState).toBe(
      'failed_to_start'
    );
  });
});

describe('normalizeLaunchFailureReasonText recovers a routed SendMessage reason', () => {
  it('reads the human-readable part out of a complete SendMessage result body', () => {
    const written = createPersistedLaunchSnapshot({
      teamName: 'lane-team',
      expectedMembers: ['team-lead'],
      includeLeadMembers: true,
      launchPhase: 'finished',
      members: {
        'team-lead': openCodeLaneLead({
          hardFailureReason: JSON.stringify({
            success: true,
            message: 'Message sent to team-lead',
            routing: { summary: 'lead unreachable', content: 'no session record' },
          }),
        }),
      },
      updatedAt: at,
    });

    expect(readBackOf('lane-team', written)?.members['team-lead']?.hardFailureReason).toBe(
      'lead unreachable: no session record'
    );
  });

  it('recovers the reason from a body an older build truncated mid-string', () => {
    const written = createPersistedLaunchSnapshot({
      teamName: 'lane-team',
      expectedMembers: ['team-lead'],
      includeLeadMembers: true,
      launchPhase: 'finished',
      members: {
        'team-lead': openCodeLaneLead({
          hardFailureReason:
            '{"success":true,"message":"Message sent to team-lead","routing":{"summary":"lead unreachable',
        }),
      },
      updatedAt: at,
    });

    expect(readBackOf('lane-team', written)?.members['team-lead']?.hardFailureReason).toBe(
      'lead unreachable'
    );
  });

  it('leaves a plain failure reason untouched', () => {
    const written = createPersistedLaunchSnapshot({
      teamName: 'lane-team',
      expectedMembers: ['team-lead'],
      includeLeadMembers: true,
      launchPhase: 'finished',
      members: {
        'team-lead': openCodeLaneLead({ hardFailureReason: 'spawn ENOENT' }),
      },
      updatedAt: at,
    });

    expect(readBackOf('lane-team', written)?.members['team-lead']?.hardFailureReason).toBe(
      'spawn ENOENT'
    );
  });
});
