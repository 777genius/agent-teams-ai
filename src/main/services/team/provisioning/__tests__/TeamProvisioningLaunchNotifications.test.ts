import { describe, expect, it, vi } from 'vitest';

import {
  type TeamProvisioningLaunchNotificationRunLike,
  TeamProvisioningLaunchNotifications,
  type TeamProvisioningLaunchNotificationsPorts,
} from '../TeamProvisioningLaunchNotifications';

import type { TeamNotificationPayload } from '@main/utils/teamNotificationBuilder';

const provisionTeamProjectPath = '/repo/.agent-teams-test-projects/provision-team';
const launchTeamProjectPath = '/repo/.agent-teams-test-projects/launch-team';

describe('TeamProvisioningLaunchNotifications', () => {
  it('fires the non-launch provisioned notification payload', async () => {
    const run = runLike({
      isLaunch: false,
      teamName: 'provision-team',
      runId: 'run-42',
      request: {
        displayName: 'Provision Team',
        cwd: provisionTeamProjectPath,
      },
    });
    const ports = createPorts({
      getConfig: vi.fn(() => ({ notifications: { notifyOnTeamLaunched: false } })),
    });
    const helper = new TeamProvisioningLaunchNotifications(ports);

    await helper.fireTeamLaunchedNotification(run);

    expect(run.teamLaunchedNotificationFired).toBe(true);
    expect(ports.addTeamNotification).toHaveBeenCalledWith({
      teamEventType: 'team_launched',
      teamName: 'provision-team',
      teamDisplayName: 'Provision Team',
      from: 'system',
      summary: 'Team provisioned',
      body: 'Team "Provision Team" has been provisioned and is ready for tasks.',
      dedupeKey: 'team_launched:provision-team:run-42',
      target: { kind: 'team', teamName: 'provision-team', section: 'overview' },
      projectPath: provisionTeamProjectPath,
      suppressToast: true,
    });
  });

  it('waits to fire the launch notification until all expected members are confirmed', async () => {
    const run = runLike({
      isLaunch: true,
      expectedMembers: ['builder'],
    });
    const ports = createPorts({
      areAllExpectedLaunchMembersConfirmed: vi.fn(() => false),
    });
    const helper = new TeamProvisioningLaunchNotifications(ports);

    await helper.fireTeamLaunchedNotification(run);

    expect(ports.areAllExpectedLaunchMembersConfirmed).toHaveBeenCalledWith(run);
    expect(ports.addTeamNotification).not.toHaveBeenCalled();
    expect(run.teamLaunchedNotificationFired).toBeUndefined();
  });

  it('keeps the launched notification one-shot flag and rolls it back when storage fails', async () => {
    const run = runLike({
      isLaunch: true,
      expectedMembers: ['builder', 'reviewer'],
    });
    const addTeamNotification = vi
      .fn()
      .mockRejectedValueOnce(new Error('write failed'))
      .mockResolvedValue(undefined);
    const ports = createPorts({
      addTeamNotification,
      areAllExpectedLaunchMembersConfirmed: vi.fn(() => true),
    });
    const helper = new TeamProvisioningLaunchNotifications(ports);

    await helper.fireTeamLaunchedNotification(run);

    expect(run.teamLaunchedNotificationFired).toBe(false);
    expect(ports.logger.warn).toHaveBeenCalledWith(
      '[launch-team] Failed to fire team_launched notification: write failed'
    );

    await helper.fireTeamLaunchedNotification(run);
    await helper.fireTeamLaunchedNotification(run);

    expect(addTeamNotification).toHaveBeenCalledTimes(2);
    expect(run.teamLaunchedNotificationFired).toBe(true);
    expect(addTeamNotification).toHaveBeenLastCalledWith(
      expect.objectContaining({
        summary: 'Team launched',
        body: 'Team "Launch Team" has been launched - all 2 teammates joined and are ready for tasks.',
      })
    );
  });

  it('fires the incomplete notification payload returned by the payload helper', async () => {
    const run = runLike();
    const launchSummary = {
      confirmedCount: 1,
      pendingCount: 0,
      failedCount: 1,
      runtimeAlivePendingCount: 0,
    };
    const payload = teamNotificationPayload({
      teamEventType: 'team_launch_incomplete',
      summary: 'Team launch incomplete',
      body: '1/2 joined · failed: @builder',
    });
    const ports = createPorts({
      buildLaunchIncompleteNotificationPayload: vi.fn(() => payload),
    });
    const helper = new TeamProvisioningLaunchNotifications(ports);

    await helper.fireTeamLaunchIncompleteNotification(run, [{ name: 'builder' }], launchSummary);

    expect(ports.buildLaunchIncompleteNotificationPayload).toHaveBeenCalledWith({
      run,
      failedMembers: [{ name: 'builder' }],
      launchSummary,
      snapshot: undefined,
      suppressToast: false,
    });
    expect(ports.addTeamNotification).toHaveBeenCalledWith(payload);
  });

  it('does not fire the incomplete notification when the payload helper returns null', async () => {
    const run = runLike();
    const ports = createPorts({
      buildLaunchIncompleteNotificationPayload: vi.fn(() => null),
    });
    const helper = new TeamProvisioningLaunchNotifications(ports);

    await helper.fireTeamLaunchIncompleteNotification(run, [], {
      confirmedCount: 1,
      pendingCount: 0,
      failedCount: 0,
      runtimeAlivePendingCount: 0,
    });

    expect(ports.buildLaunchIncompleteNotificationPayload).toHaveBeenCalled();
    expect(ports.addTeamNotification).not.toHaveBeenCalled();
  });
});

function createPorts(
  overrides: Partial<TeamProvisioningLaunchNotificationsPorts> = {}
): TeamProvisioningLaunchNotificationsPorts {
  return {
    getConfig: vi.fn(() => ({ notifications: { notifyOnTeamLaunched: true } })),
    addTeamNotification: vi.fn().mockResolvedValue(undefined),
    areAllExpectedLaunchMembersConfirmed: vi.fn(() => true),
    buildLaunchIncompleteNotificationPayload: vi.fn(() => null),
    logger: {
      warn: vi.fn(),
    },
    ...overrides,
  };
}

function runLike(
  overrides: Partial<TeamProvisioningLaunchNotificationRunLike> = {}
): TeamProvisioningLaunchNotificationRunLike {
  return {
    teamName: 'launch-team',
    runId: 'run-1',
    request: {
      displayName: 'Launch Team',
      cwd: launchTeamProjectPath,
    },
    expectedMembers: [],
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
    projectPath: launchTeamProjectPath,
    suppressToast: false,
    ...overrides,
  };
}
