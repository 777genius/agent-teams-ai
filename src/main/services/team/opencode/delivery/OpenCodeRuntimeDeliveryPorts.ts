import type { TeamInboxReader } from '../../TeamInboxReader';
import type { TeamInboxWriter } from '../../TeamInboxWriter';
import type { TeamSentMessagesStore } from '../../TeamSentMessagesStore';
import type { RuntimeDeliveryDestinationPort } from './RuntimeDeliveryService';
import type { InboxMessage, TaskRef } from '@shared/types/team';

export type OpenCodeRuntimeDeliveryCrossTeamSender = (request: {
  fromTeam: string;
  fromMember: string;
  toTeam: string;
  text: string;
  summary?: string;
  taskRefs?: TaskRef[];
  messageId?: string;
  timestamp?: string;
  conversationId?: string;
}) => Promise<unknown>;

export interface OpenCodeRuntimeDeliveryPortsDependencies {
  sentMessagesStore: Pick<TeamSentMessagesStore, 'appendMessage' | 'readMessages'>;
  inboxReader: Pick<TeamInboxReader, 'getMessagesFor'>;
  inboxWriter: Pick<TeamInboxWriter, 'sendMessage'>;
  getCrossTeamSender: () => OpenCodeRuntimeDeliveryCrossTeamSender | null;
}

function normalizeRuntimeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
}

function runtimeTaskRefs(teamName: string, value: unknown): InboxMessage['taskRefs'] | undefined {
  const refs = normalizeRuntimeStringArray(value);
  return refs.length > 0
    ? refs.map((ref) => ({
        teamName,
        taskId: ref,
        displayId: ref,
      }))
    : undefined;
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
        taskRefs: runtimeTaskRefs(envelope.teamName, envelope.taskRefs),
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
        taskRefs: runtimeTaskRefs(envelope.teamName, envelope.taskRefs),
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
      const taskRefs = runtimeTaskRefs(envelope.teamName, envelope.taskRefs);
      await crossTeamSender({
        fromTeam: envelope.teamName,
        fromMember: envelope.fromMemberName,
        toTeam: envelope.to.teamName,
        text: envelope.text,
        summary: envelope.summary ?? undefined,
        ...(taskRefs ? { taskRefs } : {}),
        messageId: destinationMessageId,
        timestamp: envelope.createdAt,
        conversationId: envelope.idempotencyKey,
      });
      return {
        kind: 'cross_team_outbox',
        fromTeamName: envelope.teamName,
        toTeamName: envelope.to.teamName,
        toMemberName: envelope.to.memberName,
        messageId: destinationMessageId,
      };
    },
    verify: async ({ destination, destinationMessageId }) => {
      if (destination.kind !== 'cross_team_outbox') {
        return { found: false, location: null, diagnostics: ['destination kind mismatch'] };
      }
      const messages = await deps.sentMessagesStore.readMessages(destination.fromTeamName);
      const found = messages.some((message) => message.messageId === destinationMessageId);
      return {
        found,
        location: found
          ? {
              kind: 'cross_team_outbox',
              fromTeamName: destination.fromTeamName,
              toTeamName: destination.toTeamName,
              toMemberName: destination.toMemberName,
              messageId: destinationMessageId,
            }
          : null,
        diagnostics: [],
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
