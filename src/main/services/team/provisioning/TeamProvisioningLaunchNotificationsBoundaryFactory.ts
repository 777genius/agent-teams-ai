import { ConfigManager } from '@main/services/infrastructure/ConfigManager';
import { NotificationManager } from '@main/services/infrastructure/NotificationManager';

import { buildTeamLaunchIncompleteNotificationPayload } from './TeamProvisioningLaunchIncompleteNotification';
import {
  type TeamProvisioningLaunchNotificationRunLike,
  TeamProvisioningLaunchNotifications,
  type TeamProvisioningLaunchNotificationsConfig,
  type TeamProvisioningLaunchNotificationsLogger,
  type TeamProvisioningLaunchNotificationsPorts,
} from './TeamProvisioningLaunchNotifications';

export interface TeamProvisioningLaunchNotificationsBoundaryPorts<
  TRun extends TeamProvisioningLaunchNotificationRunLike =
    TeamProvisioningLaunchNotificationRunLike,
> {
  areAllExpectedLaunchMembersConfirmed(run: TRun): boolean;
  logger: TeamProvisioningLaunchNotificationsLogger;
  getConfig?: TeamProvisioningLaunchNotificationsPorts<TRun>['getConfig'];
  addTeamNotification?: TeamProvisioningLaunchNotificationsPorts<TRun>['addTeamNotification'];
  buildLaunchIncompleteNotificationPayload?: TeamProvisioningLaunchNotificationsPorts<TRun>['buildLaunchIncompleteNotificationPayload'];
}

function getTeamProvisioningLaunchNotificationsConfig(): TeamProvisioningLaunchNotificationsConfig {
  return ConfigManager.getInstance().getConfig();
}

export function createTeamProvisioningLaunchNotificationsBoundary<
  TRun extends TeamProvisioningLaunchNotificationRunLike =
    TeamProvisioningLaunchNotificationRunLike,
>(
  ports: TeamProvisioningLaunchNotificationsBoundaryPorts<TRun>
): TeamProvisioningLaunchNotifications<TRun> {
  return new TeamProvisioningLaunchNotifications<TRun>({
    getConfig: ports.getConfig ?? getTeamProvisioningLaunchNotificationsConfig,
    addTeamNotification:
      ports.addTeamNotification ??
      ((notification) => NotificationManager.getInstance().addTeamNotification(notification)),
    areAllExpectedLaunchMembersConfirmed: (run) => ports.areAllExpectedLaunchMembersConfirmed(run),
    buildLaunchIncompleteNotificationPayload:
      ports.buildLaunchIncompleteNotificationPayload ??
      buildTeamLaunchIncompleteNotificationPayload,
    logger: ports.logger,
  });
}
