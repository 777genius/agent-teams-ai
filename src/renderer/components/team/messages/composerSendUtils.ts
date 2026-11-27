import {
  type AutonomousGoalOptions,
  isHostTeamSelectionKey,
  readAutonomousGoalOptions,
} from '@features/agent-backend/contracts';
import { serializeChipsWithText } from '@renderer/types/inlineChip';
import {
  canMemberShowAttachmentControl,
  getMemberAttachmentUnavailableReason,
  type MemberAttachmentDeclarationLookup,
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
  SendMessageRequest,
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
  autonomousGoal?: AutonomousGoalOptions;
  originalGoalRequest?: Extract<ComposerPreparedRequest, { kind: 'local' }>;
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
  autonomousGoal,
  originalGoalRequest,
  taskRefs,
}: BuildPreparedSendRequestOptions): ComposerPreparedRequest {
  if (selectedTeam && !lockedRecipient) {
    if (autonomousGoal || originalGoalRequest)
      throw new Error('Goal requires a direct lead message');
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
  const prepared: Extract<ComposerPreparedRequest, { kind: 'local' }> = {
    kind: 'local',
    teamName,
    request: {
      member: localRecipient,
      ...(autonomousGoal ? { autonomousGoal: { ...autonomousGoal } } : {}),
      text,
      summary,
      attachments: attachments.length ? attachments : undefined,
      actionMode,
      taskRefs,
      messageId: attemptId,
    },
  };
  if (originalGoalRequest) {
    if (!sameOriginalGoalRequest(originalGoalRequest, prepared))
      throw new Error('Restore the unchanged original request to check its delivery.');
    return structuredClone(originalGoalRequest);
  }
  return prepared;
}

function sameOriginalGoalRequest(
  original: Extract<ComposerPreparedRequest, { kind: 'local' }>,
  prepared: Extract<ComposerPreparedRequest, { kind: 'local' }>
): boolean {
  const source = original.request,
    next = prepared.request;
  return (
    original.kind === 'local' &&
    original.teamName === prepared.teamName &&
    typeof source.messageId === 'string' &&
    source.messageId.length > 0 &&
    source.member === next.member &&
    source.text === next.text &&
    source.actionMode === next.actionMode &&
    JSON.stringify(source.attachments ?? []) === JSON.stringify(next.attachments ?? []) &&
    !!source.autonomousGoal &&
    JSON.stringify(source.autonomousGoal) === JSON.stringify(next.autonomousGoal)
  );
}

/** Unknown intake stays attached to its original payload, even after task suggestions change. */
export function restoredAutonomousGoalRequest(
  content: ComposerDraftContent,
  teamName: string,
  recipient: string
): Extract<ComposerPreparedRequest, { kind: 'local' }> | undefined {
  const original = content.restoredOrigin?.autonomousGoalRequest;
  if (!original || !content.autonomousGoal) return undefined;
  const text = serializeChipsWithText(
    stripEncodedTaskReferenceMetadata(content.text).trim(),
    content.chips
  );
  return sameOriginalGoalRequest(original, {
    kind: 'local',
    teamName,
    request: {
      member: recipient,
      text,
      actionMode: content.actionMode,
      attachments: content.attachments,
      autonomousGoal: content.autonomousGoal,
    },
  })
    ? original
    : undefined;
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
  isTeamAlive?: boolean,
  resolveDeclaration?: MemberAttachmentDeclarationLookup,
  autonomousGoalAvailable = false
): boolean {
  const crossTeam = request.kind === 'cross-team';
  const originTeam = crossTeam ? request.request.fromTeam : request.teamName;
  if (teamName !== originTeam) return false;
  const recipient = crossTeam ? null : request.request.member;
  const member = members.find((candidate) => candidate.name === recipient);
  const capturedGoal = request.kind === 'local' ? request.request.autonomousGoal : undefined;
  if (JSON.stringify(capturedGoal) !== JSON.stringify(content.autonomousGoal)) return false;
  const original = restoredAutonomousGoalRequest(content, teamName, recipient ?? '');
  if (
    content.restoredOrigin?.autonomousGoalRequest &&
    (!original || JSON.stringify(original) !== JSON.stringify(request))
  )
    return false;
  if (content.autonomousGoal) {
    try {
      readAutonomousGoalOptions(content.autonomousGoal);
    } catch {
      return false;
    }
  }
  if (
    content.autonomousGoal &&
    (crossTeam ||
      !isHostTeamSelectionKey(teamName) ||
      (!autonomousGoalAvailable && !original) ||
      !member ||
      !isLeadMember(member) ||
      !isTeamAlive ||
      content.actionMode === 'ask' ||
      parseStandaloneSlashCommand(content.text.trim()))
  )
    return false;
  const canAttach =
    !crossTeam &&
    !!isTeamAlive &&
    canMemberShowAttachmentControl(member) &&
    getMemberAttachmentUnavailableReason(member) == null;
  if (
    content.attachments.length &&
    (!canAttach ||
      validateAttachmentPayloadsForMember({
        member,
        attachments: content.attachments,
        resolveDeclaration,
      }))
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

/** Preserve the legacy callback's argument count when no opt-in was captured. */
export function preparedAutonomousGoalArgs(
  request: SendMessageRequest
): [] | [AutonomousGoalOptions] {
  return request.autonomousGoal ? [request.autonomousGoal] : [];
}
