import { CROSS_TEAM_SENT_SOURCE } from '@shared/constants/crossTeam';

import type { TeamInboxReader } from '../../TeamInboxReader';
import type { TeamInboxWriter } from '../../TeamInboxWriter';
import type { TeamSentMessagesStore } from '../../TeamSentMessagesStore';
import type { RuntimeDeliveryLocation } from './RuntimeDeliveryJournal';
import type { RuntimeDeliveryDestinationPort } from './RuntimeDeliveryService';
import type { CrossTeamSendResult, InboxMessage, TaskRef } from '@shared/types/team';

export type OpenCodeRuntimeDeliveryCrossTeamSender = (request: {
  fromTeam: string;
  fromMember: string;
  toTeam: string;
  toMember?: string;
  text: string;
  summary?: string;
  taskRefs?: TaskRef[];
  messageId?: string;
  timestamp?: string;
  conversationId?: string;
  requireRuntimeDelivery?: boolean;
}) => Promise<CrossTeamSendResult>;

export interface OpenCodeRuntimeDeliveryPortsDependencies {
  sentMessagesStore: Pick<TeamSentMessagesStore, 'appendMessage' | 'readMessages'>;
  inboxReader: Pick<TeamInboxReader, 'getMessagesFor'>;
  inboxWriter: Pick<TeamInboxWriter, 'sendMessage'>;
  getCrossTeamSender: () => OpenCodeRuntimeDeliveryCrossTeamSender | null;
}

function runtimeTaskRefs(
  value: readonly TaskRef[] | undefined
): InboxMessage['taskRefs'] | undefined {
  return value?.length
    ? value.map((taskRef) => ({
        taskId: taskRef.taskId,
        displayId: taskRef.displayId,
        teamName: taskRef.teamName,
      }))
    : undefined;
}

function isCrossTeamSendResult(value: unknown): value is CrossTeamSendResult {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const messageId = (value as { messageId?: unknown }).messageId;
  const deliveredToInbox = (value as { deliveredToInbox?: unknown }).deliveredToInbox;
  return typeof messageId === 'string' && messageId.trim().length > 0 && deliveredToInbox === true;
}

function parseCrossTeamRecipient(
  value: string | undefined,
  fallbackTeamName: string,
  fallbackMemberName: string | undefined
): { teamName: string; memberName: string } {
  const separator = typeof value === 'string' ? value.indexOf('.') : -1;
  if (separator > 0 && separator < String(value).length - 1) {
    return {
      teamName: String(value).slice(0, separator),
      memberName: String(value).slice(separator + 1),
    };
  }
  return { teamName: fallbackTeamName, memberName: fallbackMemberName?.trim() || 'team-lead' };
}

function getCrossTeamSendResultTarget(value: unknown): {
  teamName: string | undefined;
  memberName: string | undefined;
} {
  if (!value || typeof value !== 'object') {
    return { teamName: undefined, memberName: undefined };
  }
  const result = value as { toTeam?: unknown; toMember?: unknown };
  return {
    teamName:
      typeof result.toTeam === 'string' && result.toTeam.trim().length > 0
        ? result.toTeam.trim()
        : undefined,
    memberName:
      typeof result.toMember === 'string' && result.toMember.trim().length > 0
        ? result.toMember.trim()
        : undefined,
  };
}

function isCrossTeamLocation(
  location: RuntimeDeliveryLocation | undefined
): location is Extract<RuntimeDeliveryLocation, { kind: 'cross_team_outbox' }> {
  return location?.kind === 'cross_team_outbox';
}

function findCrossTeamSenderCopy(
  messages: InboxMessage[],
  location: Extract<RuntimeDeliveryLocation, { kind: 'cross_team_outbox' }>
): InboxMessage | undefined {
  const expectedRecipient = `${location.toTeamName}.${location.toMemberName}`;
  return messages.find(
    (message) => message.messageId === location.messageId && message.to === expectedRecipient
  );
}

export function createOpenCodeRuntimeDeliveryPorts(
  deps: OpenCodeRuntimeDeliveryPortsDependencies
): RuntimeDeliveryDestinationPort[] {
  const userMessagesPort: RuntimeDeliveryDestinationPort = {
    kind: 'user_sent_messages',
    write: async ({ envelope, destinationMessageId }) => {
      await deps.sentMessagesStore.appendMessage(envelope.teamName, {
        from: envelope.fromMemberName,
        to: 'user',
        text: envelope.text,
        timestamp: envelope.createdAt,
        read: true,
        summary: envelope.summary ?? undefined,
        messageId: destinationMessageId,
        source: 'lead_process',
        leadSessionId: envelope.runtimeSessionId,
        taskRefs: runtimeTaskRefs(envelope.taskRefs),
      });
      return {
        kind: 'user_sent_messages',
        teamName: envelope.teamName,
        messageId: destinationMessageId,
      };
    },
    verify: async ({ destination, destinationMessageId }) => {
      if (destination.kind !== 'user_sent_messages') {
        return { found: false, location: null, diagnostics: ['destination kind mismatch'] };
      }
      const messages = await deps.sentMessagesStore.readMessages(destination.teamName);
      const found = messages.some((message) => message.messageId === destinationMessageId);
      return {
        found,
        location: found
          ? {
              kind: 'user_sent_messages',
              teamName: destination.teamName,
              messageId: destinationMessageId,
            }
          : null,
        diagnostics: [],
      };
    },
    buildChangeEvent: ({ teamName }) => ({
      type: 'lead-message',
      teamName,
      data: { detail: 'opencode-runtime-delivery' },
    }),
  };

  const memberInboxPort: RuntimeDeliveryDestinationPort = {
    kind: 'member_inbox',
    write: async ({ envelope, destinationMessageId }) => {
      if (typeof envelope.to !== 'object' || !('memberName' in envelope.to)) {
        throw new Error('Runtime delivery member destination missing memberName');
      }
      const memberName = envelope.to.memberName;
      await deps.inboxWriter.sendMessage(envelope.teamName, {
        member: memberName,
        from: envelope.fromMemberName,
        to: memberName,
        text: envelope.text,
        timestamp: envelope.createdAt,
        messageId: destinationMessageId,
        summary: envelope.summary ?? undefined,
        source: 'inbox',
        leadSessionId: envelope.runtimeSessionId,
        taskRefs: runtimeTaskRefs(envelope.taskRefs),
      });
      return {
        kind: 'member_inbox',
        teamName: envelope.teamName,
        memberName,
        messageId: destinationMessageId,
      };
    },
    verify: async ({ destination, destinationMessageId }) => {
      if (destination.kind !== 'member_inbox') {
        return { found: false, location: null, diagnostics: ['destination kind mismatch'] };
      }
      const messages = await deps.inboxReader.getMessagesFor(
        destination.teamName,
        destination.memberName
      );
      const found = messages.some((message) => message.messageId === destinationMessageId);
      return {
        found,
        location: found
          ? {
              kind: 'member_inbox',
              teamName: destination.teamName,
              memberName: destination.memberName,
              messageId: destinationMessageId,
            }
          : null,
        diagnostics: [],
      };
    },
    buildChangeEvent: ({ teamName, location }) => ({
      type: 'inbox',
      teamName,
      data: {
        detail:
          location.kind === 'member_inbox' ? `inboxes/${location.memberName}.json` : 'inboxes',
      },
    }),
  };

  const crossTeamPort: RuntimeDeliveryDestinationPort = {
    kind: 'cross_team_outbox',
    write: async ({ envelope, destinationMessageId }) => {
      if (typeof envelope.to !== 'object' || !('teamName' in envelope.to)) {
        throw new Error('Runtime delivery cross-team destination missing teamName');
      }
      const crossTeamSender = deps.getCrossTeamSender();
      if (!crossTeamSender) {
        throw new Error('Cross-team sender is not configured');
      }
      const taskRefs = runtimeTaskRefs(envelope.taskRefs);
      const result = await crossTeamSender({
        fromTeam: envelope.teamName,
        fromMember: envelope.fromMemberName,
        toTeam: envelope.to.teamName,
        toMember: envelope.to.memberName,
        text: envelope.text,
        summary: envelope.summary ?? undefined,
        ...(taskRefs ? { taskRefs } : {}),
        messageId: destinationMessageId,
        timestamp: envelope.createdAt,
        conversationId: envelope.idempotencyKey,
        requireRuntimeDelivery: true,
      });
      if (!isCrossTeamSendResult(result)) {
        throw new Error('Cross-team runtime sender did not return a confirmed delivery result');
      }

      const deliveredMessageId = result.messageId.trim();
      const senderMessages = await deps.sentMessagesStore.readMessages(envelope.teamName);
      const senderCopy =
        senderMessages.find((message) => message.messageId === deliveredMessageId) ??
        senderMessages.find((message) => message.messageId === destinationMessageId);
      const resultTarget = getCrossTeamSendResultTarget(result);
      const recipient = parseCrossTeamRecipient(
        senderCopy?.to,
        resultTarget.teamName ?? envelope.to.teamName,
        resultTarget.memberName ?? envelope.to.memberName
      );
      const location: Extract<RuntimeDeliveryLocation, { kind: 'cross_team_outbox' }> = {
        kind: 'cross_team_outbox',
        fromTeamName: envelope.teamName,
        toTeamName: recipient.teamName,
        toMemberName: recipient.memberName,
        messageId: deliveredMessageId,
      };

      if (!findCrossTeamSenderCopy(senderMessages, location)) {
        await deps.sentMessagesStore.appendMessage(envelope.teamName, {
          from: envelope.fromMemberName,
          to: `${location.toTeamName}.${location.toMemberName}`,
          text: envelope.text,
          timestamp: envelope.createdAt,
          read: true,
          messageId: location.messageId,
          source: CROSS_TEAM_SENT_SOURCE,
          summary: envelope.summary ?? `Cross-team message to ${location.toTeamName}`,
          leadSessionId: envelope.runtimeSessionId,
          taskRefs: runtimeTaskRefs(envelope.taskRefs),
          conversationId: envelope.idempotencyKey,
        });
      }

      return location;
    },
    verify: async ({ destination, location }) => {
      if (destination.kind !== 'cross_team_outbox') {
        return { found: false, location: null, diagnostics: ['destination kind mismatch'] };
      }
      if (!isCrossTeamLocation(location)) {
        return {
          found: false,
          location: null,
          diagnostics: ['cross-team target runtime proof required'],
        };
      }
      const expectedLocation = location;
      const messages = await deps.sentMessagesStore.readMessages(expectedLocation.fromTeamName);
      const found = Boolean(findCrossTeamSenderCopy(messages, expectedLocation));
      return {
        found,
        location: found ? expectedLocation : null,
        diagnostics: found ? [] : ['cross-team sender copy proof missing'],
      };
    },
    buildChangeEvent: ({ teamName }) => ({
      type: 'inbox',
      teamName,
      data: { detail: 'cross-team-outbox' },
    }),
  };

  return [userMessagesPort, memberInboxPort, crossTeamPort];
}
