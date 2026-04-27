import { formatTaskDisplayLabel } from '@shared/utils/taskIdentity';
import { createLogger } from '@shared/utils/logger';

import { TeamInboxReader } from '../TeamInboxReader';
import { TeamInboxWriter } from '../TeamInboxWriter';
import type { TeamDataService } from '../TeamDataService';
import type { TeamProvisioningService } from '../TeamProvisioningService';
import type { TaskStallAlert } from './TeamTaskStallTypes';
import type { SendMessageRequest } from '@shared/types';

const logger = createLogger('Service:TeamTaskStallNotifier');

type OpenCodeTaskStallRelayService = Pick<
  TeamProvisioningService,
  'relayOpenCodeMemberInboxMessages'
>;
type OpenCodeTaskStallRelayResult = Awaited<
  ReturnType<OpenCodeTaskStallRelayService['relayOpenCodeMemberInboxMessages']>
>;
type OpenCodeTaskStallDelivery = NonNullable<OpenCodeTaskStallRelayResult['lastDelivery']>;

function buildLeadAlertText(alerts: TaskStallAlert[]): string {
  return alerts
    .map(
      (alert) =>
        `- ${formatTaskDisplayLabel({ id: alert.taskId, displayId: alert.displayId })} [${alert.branch}] ${alert.subject} - ${alert.reason}`
    )
    .join('\n');
}

function buildOpenCodeOwnerNudgeText(alert: TaskStallAlert): string {
  const taskLabel = formatTaskDisplayLabel({
    id: alert.taskId,
    displayId: alert.displayId,
  });
  return [
    `Task ${taskLabel} may be stalled after a low-signal progress update.`,
    'Continue the task now. If blocked, add a concrete task comment explaining the blocker and needed input. If done, add a final task comment with the result and complete the task.',
    'Do not send acknowledgement-only replies.',
  ].join('\n');
}

function isOpenCodeDeliveryAccepted(delivery: OpenCodeTaskStallDelivery): boolean {
  if (delivery.queuedBehindMessageId) {
    return false;
  }
  if (delivery.responsePending === true) {
    return false;
  }
  if (delivery.accepted === true) {
    return true;
  }
  if (delivery.delivered === true) {
    return true;
  }
  return false;
}

export class TeamTaskStallNotifier {
  constructor(
    private readonly teamDataService: Pick<TeamDataService, 'sendSystemNotificationToLead'>,
    private readonly teamProvisioningService?: OpenCodeTaskStallRelayService,
    private readonly inboxReader: Pick<TeamInboxReader, 'getMessagesFor'> = new TeamInboxReader(),
    private readonly inboxWriter: Pick<TeamInboxWriter, 'sendMessage'> = new TeamInboxWriter()
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

  private async ensureOpenCodeOwnerNudgeInboxMessage(args: {
    teamName: string;
    alert: TaskStallAlert;
    messageId: string;
    text: string;
    timestamp: string;
  }): Promise<boolean> {
    const owner = args.alert.owner?.trim();
    if (!owner) {
      return false;
    }

    try {
      const existing = await this.inboxReader.getMessagesFor(args.teamName, owner);
      if (existing.some((message) => message.messageId === args.messageId)) {
        return true;
      }

      const request: SendMessageRequest = {
        member: owner,
        from: 'system',
        to: owner,
        messageId: args.messageId,
        timestamp: args.timestamp,
        summary: 'Potential stalled task',
        text: args.text,
        taskRefs: [args.alert.taskRef],
        actionMode: 'do',
        source: 'system_notification',
      };
      await this.inboxWriter.sendMessage(args.teamName, request);
      return true;
    } catch (error) {
      logger.warn(
        `OpenCode task stall remediation inbox write failed for ${args.teamName}/${args.alert.taskId}: ${String(
          error
        )}`
      );
      return false;
    }
  }

  async notifyOpenCodeOwners(
    teamName: string,
    alerts: TaskStallAlert[]
  ): Promise<TaskStallAlert[]> {
    if (!this.teamProvisioningService || alerts.length === 0) {
      return [];
    }

    const deliveredAlerts: TaskStallAlert[] = [];
    for (const alert of alerts) {
      if (alert.branch !== 'work' || alert.ownerProviderId !== 'opencode' || !alert.owner?.trim()) {
        continue;
      }

      try {
        const messageId = `task-stall:${teamName}:${alert.taskId}:${alert.epochKey}`;
        const timestamp = new Date().toISOString();
        const text = buildOpenCodeOwnerNudgeText(alert);
        const inboxReady = await this.ensureOpenCodeOwnerNudgeInboxMessage({
          teamName,
          alert,
          messageId,
          text,
          timestamp,
        });
        if (!inboxReady) {
          continue;
        }

        const relay = await this.teamProvisioningService.relayOpenCodeMemberInboxMessages(
          teamName,
          alert.owner,
          {
            onlyMessageId: messageId,
            source: 'watchdog',
            deliveryMetadata: {
              replyRecipient: 'user',
              actionMode: 'do',
              taskRefs: [alert.taskRef],
            },
          }
        );
        const delivery = relay.lastDelivery;
        if (delivery && isOpenCodeDeliveryAccepted(delivery)) {
          deliveredAlerts.push(alert);
          continue;
        }
        logger.debug(
          `OpenCode task stall remediation was not accepted for ${teamName}/${alert.taskId}: ${
            delivery?.reason ?? relay.diagnostics?.[0] ?? 'unknown'
          }`
        );
      } catch (error) {
        logger.warn(
          `OpenCode task stall remediation failed for ${teamName}/${alert.taskId}: ${String(error)}`
        );
      }
    }

    return deliveredAlerts;
  }
}
