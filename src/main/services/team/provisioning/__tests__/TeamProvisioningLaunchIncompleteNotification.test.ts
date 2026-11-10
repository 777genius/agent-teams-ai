/* eslint-disable sonarjs/publicly-writable-directories -- Test fixtures intentionally use temp paths. */

import { describe, expect, it } from 'vitest';

import {
  buildTeamLaunchIncompleteNotificationPayload,
  formatLaunchIncompleteMemberMentions,
  getLaunchIncompleteFailedNames,
  getLaunchIncompleteJoinedCount,
  getLaunchIncompletePendingNames,
  type LaunchIncompleteRunLike,
} from '../TeamProvisioningLaunchIncompleteNotification';

import type {
  MemberSpawnStatusEntry,
  PersistedTeamLaunchMemberState,
  PersistedTeamLaunchSnapshot,
} from '@shared/types';

const ISO = '2026-01-01T00:00:00.000Z';

function liveStatus(overrides: Partial<MemberSpawnStatusEntry>): MemberSpawnStatusEntry {
  return {
    status: 'offline',
    launchState: 'starting',
    updatedAt: ISO,
    ...overrides,
  };
}

function persistedMember(
  name: string,
  overrides: Partial<PersistedTeamLaunchMemberState>
): PersistedTeamLaunchMemberState {
  return {
    name,
    launchState: 'starting',
    agentToolAccepted: false,
    runtimeAlive: false,
    bootstrapConfirmed: false,
    hardFailure: false,
    lastEvaluatedAt: ISO,
    ...overrides,
  };
}

function persistedSnapshot(params: {
  expectedMembers: string[];
  members: Record<string, PersistedTeamLaunchMemberState>;
  summary?: Partial<PersistedTeamLaunchSnapshot['summary']>;
}): PersistedTeamLaunchSnapshot {
  return {
    version: 2,
    teamName: 'launch-team',
    updatedAt: ISO,
    launchPhase: 'finished',
    expectedMembers: params.expectedMembers,
    members: params.members,
    summary: {
      confirmedCount: 0,
      pendingCount: 0,
      failedCount: 0,
      runtimeAlivePendingCount: 0,
      ...params.summary,
    },
    teamLaunchState: 'partial_failure',
  };
}

function runLike(overrides: Partial<LaunchIncompleteRunLike> = {}): LaunchIncompleteRunLike {
  return {
    teamName: 'launch-team',
    runId: 'run-1',
    request: {
      displayName: 'Launch Team',
      cwd: '/tmp/launch-team',
    },
    expectedMembers: [],
    allEffectiveMembers: [],
    memberSpawnStatuses: new Map(),
    ...overrides,
  };
}

describe('launch incomplete notification helpers', () => {
  it('formats member mentions for notification text', () => {
    expect(formatLaunchIncompleteMemberMentions(['api', 'web'])).toBe('@api, @web');
  });

  it('derives failed, pending, and joined counts from live and persisted evidence', () => {
    const expectedMembers = ['api', 'web', 'qa', 'ops', 'docs'];
    const run = runLike({
      expectedMembers,
      memberSpawnStatuses: new Map([
        ['api', liveStatus({ launchState: 'failed_to_start', hardFailure: true })],
        ['web', liveStatus({ launchState: 'confirmed_alive', bootstrapConfirmed: true })],
        ['qa', liveStatus({ launchState: 'runtime_pending_bootstrap', runtimeAlive: true })],
        ['ops', liveStatus({ launchState: 'skipped_for_launch', skippedForLaunch: true })],
      ]),
    });
    const snapshot = persistedSnapshot({
      expectedMembers,
      members: {
        docs: persistedMember('docs', {
          launchState: 'confirmed_alive',
          bootstrapConfirmed: true,
        }),
        qa: persistedMember('qa', {
          launchState: 'runtime_pending_bootstrap',
          runtimeAlive: true,
        }),
      },
    });

    const failedNames = getLaunchIncompleteFailedNames(
      run,
      expectedMembers,
      [{ name: 'web' }],
      snapshot
    );
    const pendingNames = getLaunchIncompletePendingNames(
      run,
      expectedMembers,
      failedNames,
      snapshot
    );
    const joinedCount = getLaunchIncompleteJoinedCount(
      run,
      expectedMembers,
      failedNames.length + pendingNames.length,
      {
        confirmedCount: 4,
      },
      snapshot
    );

    expect(failedNames).toEqual(['api']);
    expect(pendingNames).toEqual(['qa']);
    expect(joinedCount).toBe(3);
  });

  it('builds the team launch incomplete notification payload without changing text', () => {
    const run = runLike({
      teamName: 'rocket-team',
      runId: 'run-42',
      request: {
        displayName: 'Rocket Team',
        cwd: '/tmp/rocket-team',
      },
      expectedMembers: ['frontend', 'backend', 'qa'],
      memberSpawnStatuses: new Map([
        ['frontend', liveStatus({ launchState: 'confirmed_alive', bootstrapConfirmed: true })],
        ['backend', liveStatus({ launchState: 'failed_to_start', hardFailure: true })],
        ['qa', liveStatus({ launchState: 'runtime_pending_bootstrap', runtimeAlive: true })],
      ]),
    });

    expect(
      buildTeamLaunchIncompleteNotificationPayload({
        run,
        failedMembers: [{ name: 'backend' }],
        launchSummary: {
          confirmedCount: 1,
          pendingCount: 1,
          failedCount: 1,
          runtimeAlivePendingCount: 1,
        },
        suppressToast: true,
      })
    ).toEqual({
      teamEventType: 'team_launch_incomplete',
      teamName: 'rocket-team',
      teamDisplayName: 'Rocket Team',
      from: 'system',
      summary: 'Team launch incomplete',
      body: '1/3 joined · failed: @backend · still joining: @qa',
      dedupeKey: 'team_launch_incomplete:rocket-team:run-42',
      target: { kind: 'team', teamName: 'rocket-team', section: 'members' },
      projectPath: '/tmp/rocket-team',
      suppressToast: true,
    });
  });

  it('does not build a launch incomplete payload when no failed member remains', () => {
    const run = runLike({
      expectedMembers: ['frontend'],
      memberSpawnStatuses: new Map([
        ['frontend', liveStatus({ launchState: 'confirmed_alive', bootstrapConfirmed: true })],
      ]),
    });

    expect(
      buildTeamLaunchIncompleteNotificationPayload({
        run,
        failedMembers: [{ name: 'frontend' }],
        launchSummary: {
          confirmedCount: 1,
          pendingCount: 0,
          failedCount: 0,
          runtimeAlivePendingCount: 0,
        },
        suppressToast: false,
      })
    ).toBeNull();
  });

  it('does not build a payload for pending-only teammates that are still joining', () => {
    const expectedMembers = ['alice', 'bob', 'jack', 'tom'];
    const run = runLike({
      teamName: 'beacon-desk-15',
      runId: 'run-beacon-desk-15',
      request: {
        displayName: 'beacon-desk-15',
        cwd: '/tmp/beacon-desk-15',
      },
      expectedMembers,
      allEffectiveMembers: expectedMembers.map((name) => ({ name })),
      memberSpawnStatuses: new Map(
        expectedMembers.map((name) => [
          name,
          liveStatus({
            status: 'waiting',
            launchState: 'runtime_pending_bootstrap',
            runtimeAlive: true,
            bootstrapConfirmed: false,
            hardFailure: false,
          }),
        ])
      ),
    });
    const snapshot = persistedSnapshot({
      expectedMembers,
      members: Object.fromEntries(
        expectedMembers.map((name) => [
          name,
          persistedMember(name, {
            launchState: 'runtime_pending_bootstrap',
            agentToolAccepted: true,
            runtimeAlive: true,
          }),
        ])
      ),
      summary: {
        pendingCount: 4,
        runtimeAlivePendingCount: 4,
      },
    });

    expect(
      buildTeamLaunchIncompleteNotificationPayload({
        run,
        failedMembers: [],
        launchSummary: snapshot.summary,
        snapshot,
        suppressToast: false,
      })
    ).toBeNull();
  });

  it('ignores stale failed summaries without concrete failed member evidence', () => {
    const run = runLike({
      teamName: 'stale-summary-team',
      runId: 'run-stale-summary',
      expectedMembers: ['alice'],
      allEffectiveMembers: [{ name: 'alice' }],
      memberSpawnStatuses: new Map([
        [
          'alice',
          liveStatus({
            status: 'waiting',
            launchState: 'runtime_pending_bootstrap',
            runtimeAlive: true,
            bootstrapConfirmed: false,
            hardFailure: false,
          }),
        ],
      ]),
    });
    const snapshot = persistedSnapshot({
      expectedMembers: ['alice'],
      members: {
        alice: persistedMember('alice', {
          launchState: 'runtime_pending_bootstrap',
          agentToolAccepted: true,
          runtimeAlive: true,
        }),
      },
      summary: {
        failedCount: 1,
      },
    });

    expect(
      buildTeamLaunchIncompleteNotificationPayload({
        run,
        failedMembers: [],
        launchSummary: snapshot.summary,
        snapshot,
        suppressToast: false,
      })
    ).toBeNull();
  });

  it('prefers live confirmed evidence over stale persisted failed member evidence', () => {
    const run = runLike({
      teamName: 'live-confirmed-team',
      runId: 'run-live-confirmed',
      expectedMembers: ['alice'],
      allEffectiveMembers: [{ name: 'alice' }],
      memberSpawnStatuses: new Map([
        [
          'alice',
          liveStatus({
            status: 'online',
            launchState: 'confirmed_alive',
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
          }),
        ],
      ]),
    });
    const snapshot = persistedSnapshot({
      expectedMembers: ['alice'],
      members: {
        alice: persistedMember('alice', {
          launchState: 'failed_to_start',
          agentToolAccepted: true,
          hardFailure: true,
          hardFailureReason: 'stale failure',
        }),
      },
      summary: {
        failedCount: 1,
      },
    });

    expect(
      buildTeamLaunchIncompleteNotificationPayload({
        run,
        failedMembers: [],
        launchSummary: snapshot.summary,
        snapshot,
        suppressToast: false,
      })
    ).toBeNull();
  });

  it('uses live member evidence instead of stale summary values for notification copy', () => {
    const expectedMembers = ['bob', 'jack', 'alice', 'tom'];
    const run = runLike({
      teamName: 'relay-works-18',
      runId: 'run-relay-works-18',
      request: {
        displayName: 'relay-works-18',
        cwd: '/tmp/relay-works-18',
      },
      expectedMembers,
      allEffectiveMembers: expectedMembers.map((name) => ({ name })),
      memberSpawnStatuses: new Map([
        [
          'bob',
          liveStatus({
            status: 'online',
            launchState: 'confirmed_alive',
            runtimeAlive: true,
            bootstrapConfirmed: true,
          }),
        ],
        [
          'jack',
          liveStatus({
            status: 'online',
            launchState: 'confirmed_alive',
            runtimeAlive: true,
            bootstrapConfirmed: true,
          }),
        ],
        [
          'alice',
          liveStatus({
            status: 'error',
            launchState: 'failed_to_start',
            hardFailure: true,
            hardFailureReason: 'Insufficient credits',
          }),
        ],
        [
          'tom',
          liveStatus({
            status: 'waiting',
            launchState: 'runtime_pending_bootstrap',
            runtimeAlive: true,
            bootstrapConfirmed: false,
          }),
        ],
      ]),
    });
    const snapshot = persistedSnapshot({
      expectedMembers,
      members: Object.fromEntries(
        expectedMembers.map((name) => [
          name,
          persistedMember(name, {
            launchState: 'runtime_pending_bootstrap',
            agentToolAccepted: true,
          }),
        ])
      ),
      summary: {
        pendingCount: 4,
      },
    });

    const payload = buildTeamLaunchIncompleteNotificationPayload({
      run,
      failedMembers: [{ name: 'alice' }],
      launchSummary: snapshot.summary,
      snapshot,
      suppressToast: false,
    });

    expect(payload?.body).toBe('2/4 joined · failed: @alice · still joining: @tom');
    expect(payload?.body).not.toContain('0/4');
    expect(payload?.body).not.toContain('did not join');
  });

  it('does not report persisted bootstrap-confirmed primary members from a stale failed list', () => {
    const expectedMembers = ['bob', 'jack', 'alice', 'tom'];
    const run = runLike({
      teamName: 'forge-labs-15',
      runId: 'run-forge-labs-15',
      expectedMembers,
      allEffectiveMembers: expectedMembers.map((name) => ({ name })),
      memberSpawnStatuses: new Map([
        [
          'bob',
          liveStatus({
            status: 'error',
            launchState: 'failed_to_start',
            hardFailure: true,
            hardFailureReason: 'Teammate was never spawned during launch.',
          }),
        ],
        [
          'jack',
          liveStatus({
            status: 'error',
            launchState: 'failed_to_start',
            hardFailure: true,
            hardFailureReason: 'Teammate was never spawned during launch.',
          }),
        ],
        [
          'alice',
          liveStatus({
            status: 'waiting',
            launchState: 'runtime_pending_bootstrap',
            runtimeAlive: false,
            bootstrapConfirmed: false,
          }),
        ],
        [
          'tom',
          liveStatus({
            status: 'online',
            launchState: 'confirmed_alive',
            runtimeAlive: true,
            bootstrapConfirmed: true,
          }),
        ],
      ]),
    });
    const snapshot = persistedSnapshot({
      expectedMembers,
      members: {
        bob: persistedMember('bob', {
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
        }),
        jack: persistedMember('jack', {
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
        }),
        alice: persistedMember('alice', {
          launchState: 'runtime_pending_bootstrap',
          agentToolAccepted: true,
        }),
        tom: persistedMember('tom', {
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
        }),
      },
      summary: {
        confirmedCount: 3,
        pendingCount: 1,
      },
    });

    expect(
      buildTeamLaunchIncompleteNotificationPayload({
        run,
        failedMembers: [{ name: 'bob' }, { name: 'jack' }],
        launchSummary: snapshot.summary,
        snapshot,
        suppressToast: false,
      })
    ).toBeNull();
  });
});
/* eslint-enable sonarjs/publicly-writable-directories -- Re-enable after temp-path fixtures. */
