import { createLogger } from '@shared/utils/logger';
import { formatTaskDisplayLabel } from '@shared/utils/taskIdentity';

import { TeamInboxReader } from '../TeamInboxReader';
import { TeamInboxWriter } from '../TeamInboxWriter';

import type { TeamDataService } from '../TeamDataService';
import type { TaskStallAlert } from './TeamTaskStallTypes';
import type { SendMessageRequest } from '@shared/types';

const logger = createLogger('Service:TeamTaskStallNotifier');

interface OpenCodeTaskStallRelayOptions {
  onlyMessageId: string;
  source: 'watchdog';
  deliveryMetadata: {
    replyRecipient: 'user';
    actionMode: 'do';
    taskRefs: TaskStallAlert['taskRef'][];
  };
}

interface OpenCodeTaskStallDelivery {
  delivered?: boolean;
  accepted?: boolean;
  responsePending?: boolean;
  queuedBehindMessageId?: string;
  reason?: string;
}

interface OpenCodeTaskStallRelayResult {
  lastDelivery?: OpenCodeTaskStallDelivery;
  diagnostics?: string[];
}

interface OpenCodeTaskStallRelayService {
  relayOpenCodeMemberInboxMessages(
    teamName: string,
    memberName: string,
    options: OpenCodeTaskStallRelayOptions
  ): Promise<OpenCodeTaskStallRelayResult>;
}

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
  if (alert.remediationKind === 'pending_pickup') {
    return [
      `Task ${taskLabel} is assigned to you and nothing is blocking it, but it is still pending on the board - you never started it.`,
      'Start it now: call task_start for this task, do the work, post the result as a task comment ON THIS TASK, then call task_complete.',
      'A direct message to the user does not move the board and does not count as doing the task.',
      'If you cannot start, add a task comment naming the concrete blocker and what you need. Do not reply with an acknowledgement only.',
      'If prefixed Agent Teams MCP tool names are exposed, use mcp__agent-teams__task_start, mcp__agent-teams__task_add_comment and mcp__agent-teams__task_complete.',
    ].join('\n');
  }
  return [
    `Task ${taskLabel} may be stalled after a low-signal progress update.`,
    'Continue the task now. If blocked, add a concrete task comment explaining the blocker and needed input. If done, add a final task comment with the result and complete the task.',
    'Do not send acknowledgement-only replies.',
  ].join('\n');
}

/**
 * Relay outcomes that report `delivered: true` for a message the member already
 * read, i.e. nothing was sent this time. Treating them as accepted would retire
 * the alert against a no-op and strand the escalation.
 */
const NO_OP_DELIVERY_REASONS = new Set([
  'opencode_inbox_message_already_read',
  'opencode_inbox_read_already_committed',
]);

function isOpenCodeDeliveryAccepted(delivery: OpenCodeTaskStallDelivery): boolean {
  if (delivery.queuedBehindMessageId) {
    return false;
  }
  if (delivery.reason && NO_OP_DELIVERY_REASONS.has(delivery.reason)) {
    return false;
  }
  if (delivery.accepted === true) {
    return true;
  }
  if (delivery.responsePending === true) {
    return false;
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
        summary:
          args.alert.remediationKind === 'pending_pickup'
            ? 'Assigned task not started'
            : 'Potential stalled task',
        text: args.text,
        taskRefs: [args.alert.taskRef],
        actionMode: 'do',
        source: 'system_notification',
        messageKind: 'task_stall_remediation',
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
