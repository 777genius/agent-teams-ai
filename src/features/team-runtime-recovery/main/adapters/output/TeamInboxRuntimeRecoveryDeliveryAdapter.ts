import { buildRuntimeRecoveryMessageId } from '../../../core/domain';

import type {
  RuntimeRecoveryDeliveryPort,
  RuntimeRecoveryDeliveryResult,
} from '../../../core/application';
import type { RuntimeRecoveryJob } from '../../../core/application';
import type { TeamInboxReader } from '@main/services/team/TeamInboxReader';
import type { TeamInboxWriter } from '@main/services/team/TeamInboxWriter';

interface LiveRelayResult {
  kind: 'ignored' | 'native_lead' | 'native_member_noop' | 'opencode_member';
  relayed: number;
  diagnostics?: string[];
  lastDelivery?: {
    delivered?: boolean;
    accepted?: boolean;
    responsePending?: boolean;
    responseState?: string;
    reason?: string;
  };
}

function isResponseProven(result: LiveRelayResult): boolean {
  if (result.kind === 'native_lead') return result.lastDelivery?.responsePending === false;
  if (result.kind !== 'opencode_member') return false;
  return (
    result.lastDelivery?.delivered === true &&
    result.lastDelivery.responseState?.startsWith('responded_') === true
  );
}

export class TeamInboxRuntimeRecoveryDeliveryAdapter implements RuntimeRecoveryDeliveryPort {
  constructor(
    private readonly deps: {
      inboxReader: Pick<TeamInboxReader, 'getMessagesFor'>;
      inboxWriter: Pick<TeamInboxWriter, 'sendMessage'>;
      relay(
        teamName: string,
        inboxName: string,
        options: { source: 'manual'; onlyMessageId: string }
      ): Promise<LiveRelayResult>;
      getLeadName(teamName: string): Promise<string | null>;
    }
  ) {}

  async deliver(
    input: Parameters<RuntimeRecoveryDeliveryPort['deliver']>[0]
  ): Promise<RuntimeRecoveryDeliveryResult> {
    const messageId = buildRuntimeRecoveryMessageId(input.job);
    try {
      const existing = (
        await this.deps.inboxReader.getMessagesFor(input.job.signal.teamName, input.memberName)
      ).find((message) => message.messageId === messageId);
      if (
        existing &&
        (existing.messageKind !== 'runtime_recovery_nudge' ||
          existing.runtimeRecovery?.payloadHash !== input.payloadHash)
      ) {
        return { ok: false, retryable: false, reason: 'inbox_payload_conflict' };
      }

      if (!existing) {
        await this.deps.inboxWriter.sendMessage(input.job.signal.teamName, {
          member: input.memberName,
          from: 'system',
          to: input.memberName,
          text: input.text,
          summary: `Runtime recovery ${input.job.attempt + 1}`,
          timestamp: new Date().toISOString(),
          messageId,
          messageKind: 'runtime_recovery_nudge',
          source: 'system_notification',
          actionMode: 'do',
          taskRefs: input.job.signal.taskRefs?.map((taskRef) => ({
            taskId: taskRef.taskId,
            displayId: taskRef.displayId ?? taskRef.taskId.slice(0, 8),
            teamName: taskRef.teamName ?? input.job.signal.teamName,
          })),
          runtimeRecovery: {
            schemaVersion: 1,
            recoveryId: input.job.id,
            sourceFailureId: input.job.signal.id,
            attempt: input.job.attempt + 1,
            reasonCode: input.reasonCode,
            payloadHash: input.payloadHash,
          },
        });
      }

      const relay = await this.deps.relay(input.job.signal.teamName, input.memberName, {
        source: 'manual',
        onlyMessageId: messageId,
      });
      if (relay.kind === 'ignored') {
        return { ok: false, retryable: false, reason: 'recipient_ignored' };
      }
      if (relay.kind === 'opencode_member' && relay.lastDelivery?.delivered === false) {
        return {
          ok: false,
          retryable: true,
          reason: 'opencode_delivery_not_confirmed',
        };
      }
      const responseProven = isResponseProven(relay);
      const accepted =
        responseProven ||
        (relay.kind === 'native_lead' && relay.relayed > 0) ||
        (relay.kind === 'opencode_member' && relay.lastDelivery?.accepted === true) ||
        existing?.read === true;
      return { ok: true, messageId, accepted, responseProven };
    } catch {
      return { ok: false, retryable: true, reason: 'delivery_infrastructure_error' };
    }
  }

  async escalate(input: {
    job: RuntimeRecoveryJob;
    leadName: string;
    reason: string;
  }): Promise<void> {
    const messageId = `${input.job.id}-escalation`;
    const existing = await this.deps.inboxReader.getMessagesFor(
      input.job.signal.teamName,
      input.leadName
    );
    if (existing.some((message) => message.messageId === messageId)) return;
    await this.deps.inboxWriter.sendMessage(input.job.signal.teamName, {
      member: input.leadName,
      from: 'system',
      to: input.leadName,
      messageId,
      source: 'system_notification',
      actionMode: 'do',
      summary: 'Agent recovery needs reassignment',
      taskRefs: input.job.signal.taskRefs?.map((taskRef) => ({
        taskId: taskRef.taskId,
        displayId: taskRef.displayId ?? taskRef.taskId.slice(0, 8),
        teamName: taskRef.teamName ?? input.job.signal.teamName,
      })),
      text: [
        `Automatic runtime recovery could not continue ${input.job.signal.memberName}.`,
        `Reason: ${input.reason}.`,
        'Please restore that teammate or explicitly reassign its unfinished work after checking current task state and side effects.',
      ].join('\n'),
    });
    await this.deps.relay(input.job.signal.teamName, input.leadName, {
      source: 'manual',
      onlyMessageId: messageId,
    });
  }
}
