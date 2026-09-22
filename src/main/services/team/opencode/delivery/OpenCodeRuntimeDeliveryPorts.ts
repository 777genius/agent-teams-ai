import { CROSS_TEAM_SENT_SOURCE } from '@shared/constants/crossTeam';

import { CrossTeamOutbox, type CrossTeamRuntimeDeliveryProofInput } from '../../CrossTeamOutbox';

import type { TeamInboxReader } from '../../TeamInboxReader';
import type { TeamInboxWriter } from '../../TeamInboxWriter';
import type { TeamSentMessagesStore } from '../../TeamSentMessagesStore';
import type { RuntimeDeliveryLocation } from './RuntimeDeliveryJournal';
import type {
  RuntimeDeliveryDestinationPort,
  RuntimeDeliveryRecoveryEvidence,
} from './RuntimeDeliveryService';
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
  crossTeamOutbox?: Pick<CrossTeamOutbox, 'findAcceptedRuntimeDelivery'>;
}

function isRuntimeTaskRef(value: unknown): value is TaskRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const taskRef = value as Partial<TaskRef>;
  return (
    typeof taskRef.taskId === 'string' &&
    taskRef.taskId.trim().length > 0 &&
    typeof taskRef.displayId === 'string' &&
    taskRef.displayId.trim().length > 0 &&
    typeof taskRef.teamName === 'string' &&
    taskRef.teamName.trim().length > 0
  );
}

function runtimeTaskRefs(teamName: string, value: unknown): InboxMessage['taskRefs'] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const taskRefs: TaskRef[] = [];
  for (const taskRef of value) {
    if (typeof taskRef === 'string') {
      const taskId = taskRef.trim();
      if (taskId) {
        taskRefs.push({ teamName, taskId, displayId: taskId });
      }
      continue;
    }
    if (isRuntimeTaskRef(taskRef)) {
      taskRefs.push({
        taskId: taskRef.taskId,
        displayId: taskRef.displayId,
        teamName: taskRef.teamName,
      });
    }
  }

  return taskRefs.length > 0 ? taskRefs : undefined;
}

function isCrossTeamSendResult(value: unknown): value is CrossTeamSendResult {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const messageId = (value as { messageId?: unknown }).messageId;
  const deliveredToInbox = (value as { deliveredToInbox?: unknown }).deliveredToInbox;
  return typeof messageId === 'string' && messageId.trim().length > 0 && deliveredToInbox === true;
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

function isExactCrossTeamRuntimeProof(input: {
  destination: Extract<
    Parameters<RuntimeDeliveryDestinationPort['verify']>[0]['destination'],
    { kind: 'cross_team_outbox' }
  >;
  location: Extract<RuntimeDeliveryLocation, { kind: 'cross_team_outbox' }>;
}): boolean {
  return (
    input.location.fromTeamName === input.destination.fromTeamName &&
    input.location.toTeamName === input.destination.toTeamName &&
    input.location.toMemberName === input.destination.toMemberName
  );
}

function isExactPreCanonicalRuntimeMessage(input: {
  message: InboxMessage;
  envelope: Parameters<RuntimeDeliveryDestinationPort['write']>[0]['envelope'];
  destinationMessageId: string;
  to: string;
  source: InboxMessage['source'];
}): boolean {
  const expectedTaskRefs = runtimeTaskRefs(input.envelope.teamName, input.envelope.taskRefs);
  return (
    typeof input.message.from === 'string' &&
    typeof input.message.to === 'string' &&
    input.message.messageId === input.destinationMessageId &&
    input.message.from.trim().toLowerCase() ===
      input.envelope.fromMemberName.trim().toLowerCase() &&
    input.message.to.trim().toLowerCase() === input.to.trim().toLowerCase() &&
    input.message.text === input.envelope.text &&
    input.message.timestamp === input.envelope.createdAt &&
    input.message.source === input.source &&
    input.message.leadSessionId === input.envelope.runtimeSessionId &&
    (input.message.summary ?? undefined) === (input.envelope.summary ?? undefined) &&
    JSON.stringify(input.message.taskRefs ?? []) === JSON.stringify(expectedTaskRefs ?? [])
  );
}

function buildRuntimeDeliveryRecoveryEvidence(input: {
  message: InboxMessage;
  destinationMessageId: string;
  expectedTo: string;
  source: InboxMessage['source'];
}): RuntimeDeliveryRecoveryEvidence | undefined {
  if (
    input.message.messageId !== input.destinationMessageId ||
    typeof input.message.from !== 'string' ||
    input.message.from.trim().length === 0 ||
    input.message.to?.trim().toLowerCase() !== input.expectedTo.trim().toLowerCase() ||
    input.message.source !== input.source ||
    typeof input.message.leadSessionId !== 'string' ||
    input.message.leadSessionId.trim().length === 0 ||
    typeof input.message.text !== 'string' ||
    input.message.text.length === 0 ||
    typeof input.message.timestamp !== 'string' ||
    !Number.isFinite(Date.parse(input.message.timestamp))
  ) {
    return undefined;
  }

  return {
    fromMemberName: input.message.from,
    runtimeSessionId: input.message.leadSessionId,
    text: input.message.text,
    createdAt: input.message.timestamp,
    summary: input.message.summary ?? null,
    ...(input.message.taskRefs ? { taskRefs: input.message.taskRefs } : {}),
  };
}

export function createOpenCodeRuntimeDeliveryPorts(
  deps: OpenCodeRuntimeDeliveryPortsDependencies
): RuntimeDeliveryDestinationPort[] {
  const crossTeamOutbox = deps.crossTeamOutbox ?? new CrossTeamOutbox();
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
    verify: async ({
      destination,
      destinationMessageId,
      preCanonicalRecovery,
      includeRecoveryEvidence,
    }) => {
      if (destination.kind !== 'user_sent_messages') {
        return { found: false, location: null, diagnostics: ['destination kind mismatch'] };
      }
      const messages = await deps.sentMessagesStore.readMessages(destination.teamName);
      const message = messages.find((candidate) => candidate.messageId === destinationMessageId);
      const recoveryEvidence =
        includeRecoveryEvidence && message
          ? buildRuntimeDeliveryRecoveryEvidence({
              message,
              destinationMessageId,
              expectedTo: 'user',
              source: 'lead_process',
            })
          : undefined;
      const found = preCanonicalRecovery
        ? preCanonicalRecovery.canonicalDestination.kind === 'user_sent_messages' &&
          preCanonicalRecovery.canonicalDestination.teamName === destination.teamName &&
          messages.some((persistedMessage) =>
            isExactPreCanonicalRuntimeMessage({
              message: persistedMessage,
              envelope: preCanonicalRecovery.envelope,
              destinationMessageId,
              to: 'user',
              source: 'lead_process',
            })
          )
        : includeRecoveryEvidence
          ? recoveryEvidence !== undefined
          : message !== undefined;
      return {
        found,
        location: found
          ? {
              kind: 'user_sent_messages',
              teamName: destination.teamName,
              messageId: destinationMessageId,
            }
          : null,
        diagnostics: !found
          ? [
              preCanonicalRecovery
                ? 'pre-canonical user runtime delivery proof missing'
                : includeRecoveryEvidence
                  ? 'canonical user runtime delivery payload proof missing'
                  : 'user runtime delivery proof missing',
            ]
          : [],
        ...(recoveryEvidence ? { recoveryEvidence } : {}),
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
    verify: async ({
      destination,
      destinationMessageId,
      location,
      preCanonicalRecovery,
      includeRecoveryEvidence,
    }) => {
      if (destination.kind !== 'member_inbox') {
        return { found: false, location: null, diagnostics: ['destination kind mismatch'] };
      }
      if (
        preCanonicalRecovery &&
        (preCanonicalRecovery.canonicalDestination.kind !== 'member_inbox' ||
          preCanonicalRecovery.canonicalDestination.teamName !== destination.teamName)
      ) {
        return {
          found: false,
          location: null,
          diagnostics: ['pre-canonical member runtime delivery destination mismatch'],
        };
      }
      const proofLocation = preCanonicalRecovery && location;
      if (
        proofLocation &&
        (proofLocation.kind !== 'member_inbox' ||
          proofLocation.teamName !== destination.teamName ||
          proofLocation.messageId !== destinationMessageId)
      ) {
        return {
          found: false,
          location: null,
          diagnostics: ['pre-canonical member runtime delivery location mismatch'],
        };
      }
      const proofMemberName =
        proofLocation?.kind === 'member_inbox' ? proofLocation.memberName : destination.memberName;
      const messages = await deps.inboxReader.getMessagesFor(destination.teamName, proofMemberName);
      const message = messages.find((candidate) => candidate.messageId === destinationMessageId);
      const recoveryEvidence =
        includeRecoveryEvidence && message
          ? buildRuntimeDeliveryRecoveryEvidence({
              message,
              destinationMessageId,
              expectedTo: proofMemberName,
              source: 'inbox',
            })
          : undefined;
      const found = preCanonicalRecovery
        ? messages.some((persistedMessage) =>
            isExactPreCanonicalRuntimeMessage({
              message: persistedMessage,
              envelope: preCanonicalRecovery.envelope,
              destinationMessageId,
              to: proofMemberName,
              source: 'inbox',
            })
          )
        : includeRecoveryEvidence
          ? recoveryEvidence !== undefined
          : message !== undefined;
      return {
        found,
        location: found
          ? (proofLocation ?? {
              kind: 'member_inbox',
              teamName: destination.teamName,
              memberName: destination.memberName,
              messageId: destinationMessageId,
            })
          : null,
        diagnostics: !found
          ? [
              preCanonicalRecovery
                ? 'pre-canonical member runtime delivery proof missing'
                : includeRecoveryEvidence
                  ? 'canonical member runtime delivery payload proof missing'
                  : 'member runtime delivery proof missing',
            ]
          : [],
        ...(recoveryEvidence ? { recoveryEvidence } : {}),
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
      const resultTarget = getCrossTeamSendResultTarget(result);
      const recipient = {
        teamName: resultTarget.teamName ?? envelope.to.teamName,
        memberName: resultTarget.memberName ?? (envelope.to.memberName?.trim() || 'team-lead'),
      };
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
          taskRefs: runtimeTaskRefs(envelope.teamName, envelope.taskRefs),
          conversationId: envelope.idempotencyKey,
        });
      }

      return location;
    },
    verify: async ({
      destination,
      destinationMessageId,
      location,
      preCanonicalRecovery,
      includeRecoveryEvidence,
    }) => {
      if (destination.kind !== 'cross_team_outbox') {
        return { found: false, location: null, diagnostics: ['destination kind mismatch'] };
      }
      if (preCanonicalRecovery) {
        const canonicalDestination = preCanonicalRecovery.canonicalDestination;
        const envelope = preCanonicalRecovery.envelope;
        if (
          canonicalDestination.kind !== 'cross_team_outbox' ||
          envelope.to === 'user' ||
          !('teamName' in envelope.to) ||
          destination.fromTeamName !== canonicalDestination.fromTeamName ||
          destination.toTeamName !== canonicalDestination.toTeamName
        ) {
          return {
            found: false,
            location: null,
            diagnostics: ['pre-canonical cross-team recovery destination mismatch'],
          };
        }
        const expected: CrossTeamRuntimeDeliveryProofInput = {
          messageId: destinationMessageId,
          fromTeam: canonicalDestination.fromTeamName,
          fromMember: envelope.fromMemberName,
          toTeam: canonicalDestination.toTeamName,
          toMember: canonicalDestination.toMemberName,
          conversationId: envelope.idempotencyKey,
          text: envelope.text,
          ...(envelope.taskRefs ? { taskRefs: envelope.taskRefs } : {}),
          ...(envelope.summary ? { summary: envelope.summary } : {}),
          timestamp: envelope.createdAt,
        };
        const accepted = await crossTeamOutbox.findAcceptedRuntimeDelivery(
          canonicalDestination.fromTeamName,
          expected
        );
        const acceptedLocation: RuntimeDeliveryLocation | null = accepted
          ? {
              kind: 'cross_team_outbox',
              fromTeamName: accepted.fromTeam,
              toTeamName: accepted.toTeam,
              toMemberName: accepted.toMember ?? canonicalDestination.toMemberName,
              messageId: accepted.messageId,
            }
          : null;
        return {
          found: acceptedLocation !== null,
          location: acceptedLocation,
          diagnostics: acceptedLocation
            ? []
            : ['pre-canonical cross-team runtime acceptance proof missing'],
        };
      }
      if (!isCrossTeamLocation(location)) {
        return {
          found: false,
          location: null,
          diagnostics: ['cross-team target runtime proof required'],
        };
      }
      if (!isExactCrossTeamRuntimeProof({ destination, location })) {
        return {
          found: false,
          location: null,
          diagnostics: ['cross-team target runtime proof mismatch'],
        };
      }
      const expectedLocation = location;
      const messages = await deps.sentMessagesStore.readMessages(expectedLocation.fromTeamName);
      const message = findCrossTeamSenderCopy(messages, expectedLocation);
      const recoveryEvidence =
        includeRecoveryEvidence && message
          ? buildRuntimeDeliveryRecoveryEvidence({
              message,
              destinationMessageId,
              expectedTo: `${expectedLocation.toTeamName}.${expectedLocation.toMemberName}`,
              source: CROSS_TEAM_SENT_SOURCE,
            })
          : undefined;
      const found = includeRecoveryEvidence
        ? recoveryEvidence !== undefined
        : message !== undefined;
      return {
        found,
        location: found ? expectedLocation : null,
        diagnostics: found
          ? []
          : [
              includeRecoveryEvidence
                ? 'canonical cross-team runtime delivery payload proof missing'
                : 'cross-team sender copy proof missing',
            ],
        ...(recoveryEvidence ? { recoveryEvidence } : {}),
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
