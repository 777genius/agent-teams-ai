import { formatTaskDisplayLabel } from '@shared/utils/taskIdentity';

import type { TaskStallAlert } from './TeamTaskStallTypes';
import type { TeamDataService } from '../TeamDataService';

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
    private readonly teamDataService: Pick<TeamDataService, 'sendSystemNotificationToLead'>
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
}
