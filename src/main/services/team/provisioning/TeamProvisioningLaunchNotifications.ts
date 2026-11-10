import type {
  LaunchIncompleteLaunchSummary,
  LaunchIncompleteRunLike,
} from './TeamProvisioningLaunchIncompleteNotification';
import type { TeamNotificationPayload } from '@main/utils/teamNotificationBuilder';
import type { PersistedTeamLaunchSnapshot } from '@shared/types';

export interface TeamProvisioningLaunchNotificationRunLike extends LaunchIncompleteRunLike {
  isLaunch: boolean;
  teamLaunchedNotificationFired?: boolean;
}

export interface TeamProvisioningLaunchNotificationsConfig {
  notifications: {
    notifyOnTeamLaunched: boolean;
  };
}

export interface TeamProvisioningLaunchNotificationsLogger {
  warn(message: string): void;
}

export interface TeamProvisioningLaunchIncompleteNotificationPayloadParams<
  TRun extends LaunchIncompleteRunLike = LaunchIncompleteRunLike,
> {
  run: TRun;
  failedMembers: readonly { name?: string | null }[];
  launchSummary: LaunchIncompleteLaunchSummary;
  snapshot?: PersistedTeamLaunchSnapshot | null;
  suppressToast: boolean;
}

export interface TeamProvisioningLaunchNotificationsPorts<
  TRun extends TeamProvisioningLaunchNotificationRunLike = TeamProvisioningLaunchNotificationRunLike,
> {
  getConfig(): TeamProvisioningLaunchNotificationsConfig;
  addTeamNotification(notification: TeamNotificationPayload): Promise<unknown>;
  areAllExpectedLaunchMembersConfirmed(run: TRun): boolean;
  buildLaunchIncompleteNotificationPayload(
    params: TeamProvisioningLaunchIncompleteNotificationPayloadParams<TRun>
  ): TeamNotificationPayload | null;
  logger: TeamProvisioningLaunchNotificationsLogger;
}

export class TeamProvisioningLaunchNotifications<
  TRun extends TeamProvisioningLaunchNotificationRunLike = TeamProvisioningLaunchNotificationRunLike,
> {
  constructor(private readonly ports: TeamProvisioningLaunchNotificationsPorts<TRun>) {}

  async fireTeamLaunchedNotification(run: TRun): Promise<void> {
    if (run.teamLaunchedNotificationFired) {
      return;
    }

    try {
      const config = this.ports.getConfig();
      const suppressToast = !config.notifications.notifyOnTeamLaunched;
      const displayName = run.request.displayName || run.teamName;
      const joinedCount = run.expectedMembers?.length ?? 0;
      const allJoined = joinedCount > 0 && this.ports.areAllExpectedLaunchMembersConfirmed(run);
      if (run.isLaunch && joinedCount > 0 && !allJoined) {
        return;
      }
      run.teamLaunchedNotificationFired = true;
      const body = run.isLaunch
        ? allJoined
          ? `Team "${displayName}" has been launched - all ${joinedCount} teammates joined and are ready for tasks.`
          : `Team "${displayName}" has been launched and is ready for tasks.`
        : `Team "${displayName}" has been provisioned and is ready for tasks.`;

      await this.ports.addTeamNotification({
        teamEventType: 'team_launched',
        teamName: run.teamName,
        teamDisplayName: displayName,
        from: 'system',
        summary: run.isLaunch ? 'Team launched' : 'Team provisioned',
        body,
        dedupeKey: `team_launched:${run.teamName}:${run.runId}`,
        target: { kind: 'team', teamName: run.teamName, section: 'overview' },
        projectPath: run.request.cwd,
        suppressToast,
      });
    } catch (error) {
      run.teamLaunchedNotificationFired = false;
      this.ports.logger.warn(
        `[${run.teamName}] Failed to fire team_launched notification: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  async fireTeamLaunchIncompleteNotification(
    run: TRun,
    failedMembers: readonly { name: string }[],
    launchSummary: LaunchIncompleteLaunchSummary,
    snapshot?: PersistedTeamLaunchSnapshot | null
  ): Promise<void> {
    try {
      const config = this.ports.getConfig();
      const suppressToast = !config.notifications.notifyOnTeamLaunched;
      const payload = this.ports.buildLaunchIncompleteNotificationPayload({
        run,
        failedMembers,
        launchSummary,
        snapshot,
        suppressToast,
      });
      if (!payload) {
        return;
      }

      await this.ports.addTeamNotification(payload);
    } catch (error) {
      this.ports.logger.warn(
        `[${run.teamName}] Failed to fire team_launch_incomplete notification: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
}
