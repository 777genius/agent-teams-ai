import {
  canMemberShowAttachmentControl,
  getMemberAttachmentUnavailableReason,
  validateAttachmentPayloadsForMember,
} from '@renderer/utils/attachmentRecipientCapabilities';
import { stripEncodedTaskReferenceMetadata } from '@renderer/utils/taskReferenceUtils';
import { isLeadMember } from '@shared/utils/leadDetection';
import { parseStandaloneSlashCommand } from '@shared/utils/slashCommands';

import type { CapturedCrossTeamReply } from './capturedCrossTeamReply';
import type { ComposerDraftContent, ComposerPreparedRequest } from '@renderer/types/composerDraft';
import type {
  AgentActionMode,
  AttachmentPayload,
  CrossTeamSendRequest,
  ResolvedTeamMember,
  TaskRef,
} from '@shared/types';

let pendingSendIdCounter = 0;

export function createPendingSendId(): string {
  const randomId = globalThis.crypto?.randomUUID?.();
  if (randomId) return randomId;
  pendingSendIdCounter += 1;
  return `${Date.now()}-${pendingSendIdCounter}`;
}

interface BuildPreparedSendRequestOptions {
  crossTeamReply?: CapturedCrossTeamReply | null;
  attemptId: string;
  teamName: string;
  selectedTeam: string | null;
  lockedRecipient?: string;
  crossTeamRecipient: string | null;
  localRecipient: string;
  text: string;
  summary: string;
  attachments: AttachmentPayload[];
  actionMode: AgentActionMode;
  taskRefs: TaskRef[];
}

export function buildPreparedSendRequest({
  attemptId,
  teamName,
  selectedTeam,
  lockedRecipient,
  crossTeamRecipient,
  crossTeamReply,
  localRecipient,
  text,
  summary,
  attachments,
  actionMode,
  taskRefs,
}: BuildPreparedSendRequestOptions): ComposerPreparedRequest {
  if (selectedTeam && !lockedRecipient) {
    return {
      kind: 'cross-team',
      request: {
        fromTeam: teamName,
        fromMember: 'user',
        toTeam: selectedTeam,
        ...(crossTeamReply?.toTeam === selectedTeam &&
        (crossTeamReply.toMember ?? null) === crossTeamRecipient
          ? {
              conversationId: crossTeamReply.conversationId,
              replyToConversationId: crossTeamReply.conversationId,
            }
          : {}),
        ...(crossTeamRecipient ? { toMember: crossTeamRecipient } : {}),
        text,
        summary,
        actionMode,
        taskRefs,
        messageId: attemptId,
      },
    };
  }
  return {
    kind: 'local',
    teamName,
    request: {
      member: localRecipient,
      text,
      summary,
      attachments: attachments.length ? attachments : undefined,
      actionMode,
      taskRefs,
      messageId: attemptId,
    },
  };
}

/** Forward metadata from the persisted original request, including after UI state is gone. */
export function preparedCrossTeamReplyArgs(
  request: CrossTeamSendRequest
): [] | [Pick<CrossTeamSendRequest, 'conversationId' | 'replyToConversationId'>] {
  if (request.conversationId === undefined && request.replyToConversationId === undefined)
    return [];
  return [
    {
      ...(request.conversationId === undefined ? {} : { conversationId: request.conversationId }),
      ...(request.replyToConversationId === undefined
        ? {}
        : { replyToConversationId: request.replyToConversationId }),
    },
  ];
}

export function buildRevisionCorrectionText(originalMessageId: string, text: string): string {
  return [
    `Correction for my previous message (MessageId: ${originalMessageId}).`,
    '',
    'Please use this corrected version instead:',
    '',
    text,
  ].join('\n');
}

export function isPreparedSendAllowed(
  content: ComposerDraftContent,
  request: ComposerPreparedRequest,
  members: readonly ResolvedTeamMember[],
  teamName: string,
  isTeamAlive?: boolean
): boolean {
  const crossTeam = request.kind === 'cross-team';
  const originTeam = crossTeam ? request.request.fromTeam : request.teamName;
  if (teamName !== originTeam) return false;
  const recipient = crossTeam ? null : request.request.member;
  const member = members.find((candidate) => candidate.name === recipient);
  const canAttach =
    !crossTeam &&
    !!isTeamAlive &&
    canMemberShowAttachmentControl(member) &&
    getMemberAttachmentUnavailableReason(member) == null;
  if (
    content.attachments.length &&
    (!canAttach ||
      validateAttachmentPayloadsForMember({ member, attachments: content.attachments }))
  )
    return false;
  const slash = parseStandaloneSlashCommand(stripEncodedTaskReferenceMetadata(content.text).trim());
  return (
    !slash ||
    (!crossTeam &&
      !!member &&
      isLeadMember(member) &&
      !!isTeamAlive &&
      content.attachments.length === 0)
  );
}
