import {
  areAllExpectedLaunchMembersConfirmed,
  areLaunchStateSnapshotsSemanticallyEqual,
  getMemberLaunchSummary,
  getPersistedLaunchMemberNames,
  hasMixedLaunchMetadata,
  hasMixedSecondaryLaunchMetadata,
  hasPrimaryOnlyLaneAwareLaunchMetadata,
  shouldOverlayPrimaryBootstrapTruth,
  toStableJsonValue,
} from '@main/services/team/provisioning/TeamProvisioningLaunchStateProjection';
import { createPersistedLaunchSnapshot } from '@main/services/team/TeamLaunchStateEvaluator';
import { describe, expect, it } from 'vitest';

import type {
  TeamRuntimeLaunchResult,
  TeamRuntimeMemberLaunchEvidence,
} from '@main/services/team/runtime/TeamRuntimeAdapter';
import type {
  MemberSpawnStatusEntry,
  PersistedTeamLaunchMemberState,
  PersistedTeamLaunchSnapshot,
} from '@shared/types';

const at = '2026-01-01T00:00:00.000Z';

function makeStatus(overrides: Partial<MemberSpawnStatusEntry> = {}): MemberSpawnStatusEntry {
  return {
    status: 'offline',
    launchState: 'starting',
    agentToolAccepted: false,
    runtimeAlive: false,
    bootstrapConfirmed: false,
    hardFailure: false,
    updatedAt: at,
    ...overrides,
  };
}

function makeMember(
  name: string,
  overrides: Partial<PersistedTeamLaunchMemberState> = {}
): PersistedTeamLaunchMemberState {
  return {
    name,
    launchState: 'starting',
    agentToolAccepted: false,
    runtimeAlive: false,
    bootstrapConfirmed: false,
    hardFailure: false,
    lastEvaluatedAt: at,
    ...overrides,
  };
}

function makeSnapshot(
  members: Record<string, PersistedTeamLaunchMemberState>,
  overrides: Partial<PersistedTeamLaunchSnapshot> = {}
): PersistedTeamLaunchSnapshot {
  return createPersistedLaunchSnapshot({
    teamName: 'demo',
    expectedMembers: Object.keys(members),
    launchPhase: 'active',
    members,
    updatedAt: at,
    ...overrides,
  });
}

function makeEvidence(
  overrides: Partial<TeamRuntimeMemberLaunchEvidence> = {}
): TeamRuntimeMemberLaunchEvidence {
  return {
    memberName: 'Builder',
    providerId: 'opencode',
    launchState: 'confirmed_alive',
    agentToolAccepted: true,
    runtimeAlive: true,
    bootstrapConfirmed: true,
    hardFailure: false,
    diagnostics: [],
    ...overrides,
  };
}

function makeRuntimeResult(
  member: TeamRuntimeMemberLaunchEvidence,
  overrides: Partial<TeamRuntimeLaunchResult> = {}
): TeamRuntimeLaunchResult {
  return {
    runId: 'run-1',
    teamName: 'demo',
    launchPhase: 'active',
    teamLaunchState: 'clean_success',
    members: { [member.memberName]: member },
    warnings: [],
    diagnostics: [],
    ...overrides,
  };
}

describe('TeamProvisioningLaunchStateProjection', () => {
  it('summarizes launch members from run status state', () => {
    const summary = getMemberLaunchSummary({
      expectedMembers: ['Confirmed', 'Skipped', 'Failed', 'Permission', 'Shell', 'Missing'],
      memberSpawnStatuses: new Map([
        ['Confirmed', makeStatus({ launchState: 'confirmed_alive' })],
        ['Skipped', makeStatus({ launchState: 'skipped_for_launch' })],
        ['Failed', makeStatus({ launchState: 'failed_to_start' })],
        [
          'Permission',
          makeStatus({ launchState: 'runtime_pending_permission', runtimeAlive: true }),
        ],
        ['Shell', makeStatus({ livenessKind: 'shell_only' })],
      ]),
    });

    expect(summary).toEqual({
      confirmedCount: 1,
      pendingCount: 3,
      failedCount: 1,
      skippedCount: 1,
      runtimeAlivePendingCount: 1,
      shellOnlyPendingCount: 1,
      runtimeProcessPendingCount: 0,
      runtimeCandidatePendingCount: 0,
      noRuntimePendingCount: 0,
      permissionPendingCount: 1,
    });
  });

  it('compares launch snapshots by semantic state instead of timestamps or object order', () => {
    const left = makeSnapshot(
      {
        Builder: makeMember('Builder', {
          launchState: 'confirmed_alive',
          bootstrapConfirmed: true,
          runtimeAlive: true,
          lastRuntimeAliveAt: '2026-01-01T00:00:01.000Z',
          lastEvaluatedAt: '2026-01-01T00:00:02.000Z',
        }),
        Reviewer: makeMember('Reviewer'),
      },
      { updatedAt: '2026-01-01T00:00:03.000Z' }
    );
    const right = makeSnapshot(
      {
        Reviewer: makeMember('Reviewer'),
        Builder: makeMember('Builder', {
          launchState: 'confirmed_alive',
          bootstrapConfirmed: true,
          runtimeAlive: true,
          lastRuntimeAliveAt: '2026-01-01T00:00:04.000Z',
          lastEvaluatedAt: '2026-01-01T00:00:05.000Z',
        }),
      },
      {
        expectedMembers: ['Builder', 'Reviewer'],
        updatedAt: '2026-01-01T00:00:06.000Z',
      }
    );

    expect(areLaunchStateSnapshotsSemanticallyEqual(left, right)).toBe(true);
    expect(
      areLaunchStateSnapshotsSemanticallyEqual(
        left,
        makeSnapshot({
          Builder: makeMember('Builder', { launchState: 'failed_to_start', hardFailure: true }),
        })
      )
    ).toBe(false);
    expect(
      toStableJsonValue({ b: undefined, c: { z: 1, a: 2 }, a: [undefined, { y: 1 }] })
    ).toEqual({
      a: [undefined, { y: 1 }],
      c: { a: 2, z: 1 },
    });
  });

  it('requires primary and secondary launch members to be confirmed', () => {
    const primaryConfirmed = makeStatus({
      launchState: 'confirmed_alive',
      bootstrapConfirmed: true,
    });
    const secondaryLane = {
      member: { name: 'Builder' },
      state: 'finished',
      runId: 'run-1',
      result: makeRuntimeResult(makeEvidence({ memberName: 'Builder' })),
    };

    expect(
      areAllExpectedLaunchMembersConfirmed({
        expectedMembers: ['Lead', 'Builder'],
        memberSpawnStatuses: new Map([
          ['Lead', primaryConfirmed],
          ['Builder', primaryConfirmed],
        ]),
        mixedSecondaryLanes: [secondaryLane],
      })
    ).toBe(true);
    expect(
      areAllExpectedLaunchMembersConfirmed({
        expectedMembers: ['Lead', 'Builder'],
        memberSpawnStatuses: new Map([
          ['Lead', primaryConfirmed],
          ['Builder', primaryConfirmed],
        ]),
        mixedSecondaryLanes: [
          { ...secondaryLane, result: { ...secondaryLane.result, runId: 'old' } },
        ],
      })
    ).toBe(false);
  });

  it('rejects secondary confirmation evidence without a current lane run id', () => {
    expect(
      areAllExpectedLaunchMembersConfirmed({
        expectedMembers: ['Lead'],
        memberSpawnStatuses: new Map([
          [
            'Lead',
            makeStatus({
              launchState: 'confirmed_alive',
              bootstrapConfirmed: true,
            }),
          ],
        ]),
        mixedSecondaryLanes: [
          {
            member: { name: 'Builder' },
            state: 'finished',
            result: makeRuntimeResult(makeEvidence({ memberName: 'Builder' })),
          },
        ],
      })
    ).toBe(false);
  });

  it('projects lane metadata presence without mutating snapshots', () => {
    const secondary = makeSnapshot({
      Builder: makeMember('Builder', {
        providerId: 'opencode',
        laneId: 'secondary:opencode:Builder',
        laneKind: 'secondary',
        laneOwnerProviderId: 'opencode',
      }),
    });
    const primaryOnly = makeSnapshot({
      Builder: makeMember('Builder', {
        laneId: 'primary:anthropic',
        laneKind: 'primary',
      }),
    });

    expect(getPersistedLaunchMemberNames(makeSnapshot({ Builder: makeMember('Builder') }))).toEqual(
      ['Builder']
    );
    expect(hasMixedLaunchMetadata(secondary)).toBe(true);
    expect(hasMixedSecondaryLaunchMetadata(secondary)).toBe(true);
    expect(hasPrimaryOnlyLaneAwareLaunchMetadata(secondary)).toBe(false);
    expect(hasPrimaryOnlyLaneAwareLaunchMetadata(primaryOnly)).toBe(true);
    expect(shouldOverlayPrimaryBootstrapTruth({ isLaunch: false, mixedSecondaryLanes: [] })).toBe(
      false
    );
    expect(
      shouldOverlayPrimaryBootstrapTruth({
        isLaunch: false,
        mixedSecondaryLanes: [{ member: { name: 'Builder' }, state: 'queued', result: null }],
      })
    ).toBe(true);
  });
});
