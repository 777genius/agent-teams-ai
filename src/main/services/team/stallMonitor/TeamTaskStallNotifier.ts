import { createLogger } from '@shared/utils/logger';
import { formatTaskDisplayLabel } from '@shared/utils/taskIdentity';

import type { TeamDataService } from '../TeamDataService';
import type { TaskStallAlert } from './TeamTaskStallTypes';

const logger = createLogger('Service:TeamTaskStallNotifier');

export interface TeamTaskStallObservationPort {
  record(input: {
    teamName: string;
    memberName: string;
    taskId: string;
    reason: string;
    observedAt: string;
  }): Promise<void>;
}

function buildLeadAlertText(alerts: TaskStallAlert[]): string {
  return alerts
    .map(
      (alert) =>
        `- ${formatTaskDisplayLabel({ id: alert.taskId, displayId: alert.displayId })} [${alert.branch}] ${alert.subject} - ${alert.reason}`
    )
    .join('\n');
}

export class TeamTaskStallNotifier {
  constructor(
    private readonly teamDataService: Pick<TeamDataService, 'sendSystemNotificationToLead'>,
    _teamProvisioningService?: unknown,
    _inboxReader?: unknown,
    _inboxWriter?: unknown,
    private readonly stallObservation?: TeamTaskStallObservationPort
  ) {}

  async notifyLead(teamName: string, alerts: TaskStallAlert[]): Promise<void> {
    if (alerts.length === 0) {
      return;
    }

    await this.teamDataService.sendSystemNotificationToLead({
      teamName,
      summary: 'Potential stalled tasks detected',
      text: buildLeadAlertText(alerts),
      taskRefs: alerts.map((alert) => alert.taskRef),
    });
  }

  /**
   * Stall observations stay with member-work-sync. Automatic owner work/no-start
   * commands are not sent from this watchdog, including OpenCode relay.
   */
  async notifyOpenCodeOwners(
    teamName: string,
    alerts: TaskStallAlert[]
  ): Promise<TaskStallAlert[]> {
    const observedAt = new Date().toISOString();
    for (const alert of alerts) {
      const memberName = (alert.branch === 'review' ? alert.reviewer : alert.owner)?.trim();
      if (!memberName) {
        continue;
      }
      try {
        await this.stallObservation?.record({
          teamName,
          memberName,
          taskId: alert.taskId,
          reason: alert.reason,
          observedAt,
        });
      } catch (error) {
        logger.debug(
          `Task stall observation into work-sync failed for ${teamName}/${alert.taskId}: ${String(error)}`
        );
      }
    }
    if (alerts.length > 0) {
      logger.debug(
        `Task stall observations for ${teamName} are owned by member-work-sync; skipping automatic owner work commands (${alerts.length})`
      );
    }
    return [];
  }
}
