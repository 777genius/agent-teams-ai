import { describe, expect, it, vi } from 'vitest';

import { createTeamProvisioningLaunchNotificationsBoundary } from '../TeamProvisioningLaunchNotificationsBoundaryFactory';

import type { TeamProvisioningLaunchNotificationRunLike } from '../TeamProvisioningLaunchNotifications';
import type { TeamNotificationPayload } from '@main/utils/teamNotificationBuilder';

describe('TeamProvisioningLaunchNotificationsBoundaryFactory', () => {
  it('wires notification dependencies into the launch notifications boundary', async () => {
    const run = runLike();
    const addTeamNotification = vi.fn().mockResolvedValue(undefined);
    const areAllExpectedLaunchMembersConfirmed = vi.fn(() => true);
    const getConfig = vi.fn(() => ({ notifications: { notifyOnTeamLaunched: false } }));
    const buildLaunchIncompleteNotificationPayload = vi.fn(() => null);

    const boundary = createTeamProvisioningLaunchNotificationsBoundary({
      areAllExpectedLaunchMembersConfirmed,
      getConfig,
      addTeamNotification,
      buildLaunchIncompleteNotificationPayload,
      logger: { warn: vi.fn() },
    });

    await boundary.fireTeamLaunchedNotification(run);

    expect(getConfig).toHaveBeenCalledTimes(1);
    expect(areAllExpectedLaunchMembersConfirmed).toHaveBeenCalledWith(run);
    expect(addTeamNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        teamEventType: 'team_launched',
        teamName: 'launch-team',
        suppressToast: true,
      })
    );
  });

  it('uses the injected incomplete launch payload builder', async () => {
    const run = runLike();
    const payload = teamNotificationPayload({ teamEventType: 'team_launch_incomplete' });
    const addTeamNotification = vi.fn().mockResolvedValue(undefined);
    const buildLaunchIncompleteNotificationPayload = vi.fn(() => payload);

    const boundary = createTeamProvisioningLaunchNotificationsBoundary({
      areAllExpectedLaunchMembersConfirmed: vi.fn(() => true),
      getConfig: vi.fn(() => ({ notifications: { notifyOnTeamLaunched: true } })),
      addTeamNotification,
      buildLaunchIncompleteNotificationPayload,
      logger: { warn: vi.fn() },
    });
    const launchSummary = {
      confirmedCount: 1,
      pendingCount: 0,
      failedCount: 1,
      runtimeAlivePendingCount: 0,
    };

    await boundary.fireTeamLaunchIncompleteNotification(run, [{ name: 'builder' }], launchSummary);

    expect(buildLaunchIncompleteNotificationPayload).toHaveBeenCalledWith({
      run,
      failedMembers: [{ name: 'builder' }],
      launchSummary,
      snapshot: undefined,
      suppressToast: false,
    });
    expect(addTeamNotification).toHaveBeenCalledWith(payload);
  });
});

function runLike(
  overrides: Partial<TeamProvisioningLaunchNotificationRunLike> = {}
): TeamProvisioningLaunchNotificationRunLike {
  return {
    teamName: 'launch-team',
    runId: 'run-1',
    request: {
      displayName: 'Launch Team',
      cwd: '/repo/.agent-teams-test-projects/launch-team',
    },
    expectedMembers: ['builder'],
    allEffectiveMembers: [],
    memberSpawnStatuses: new Map(),
    isLaunch: true,
    ...overrides,
  };
}

function teamNotificationPayload(
  overrides: Partial<TeamNotificationPayload> = {}
): TeamNotificationPayload {
  return {
    teamEventType: 'team_launched',
    teamName: 'launch-team',
    teamDisplayName: 'Launch Team',
    from: 'system',
    summary: 'Team launched',
    body: 'Team launched',
    dedupeKey: 'team_launched:launch-team:run-1',
    target: { kind: 'team', teamName: 'launch-team', section: 'overview' },
    projectPath: '/repo/.agent-teams-test-projects/launch-team',
    suppressToast: false,
    ...overrides,
  };
}
