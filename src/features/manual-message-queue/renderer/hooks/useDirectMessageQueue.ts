import { useAppTranslation } from '@features/localization/renderer';
import { normalizeConversationParticipant } from '@features/team-direct-chats/renderer';
import { buildPreparedSendRequest } from '@renderer/components/team/messages/composerSendUtils';
import { getTaskSuggestionsForTeamNow } from '@renderer/hooks/useTaskSuggestions';
import { composerDraftRepository } from '@renderer/services/composerDraftRepository';
import { useStore } from '@renderer/store';
import {
  extractTaskRefsFromText,
  stripEncodedTaskReferenceMetadata,
} from '@renderer/utils/taskReferenceUtils';
import { parseStandaloneSlashCommand } from '@shared/utils/slashCommands';

import { type ManualQueueBinding, useManualMessageQueue } from './useManualMessageQueue';

import type { QueueItem } from '../../core/domain/queue';
import type { MemberMessageComposerProps } from '@renderer/components/team/messages/MessageComposer';
import type { UseComposerDraftResult } from '@renderer/hooks/useComposerDraft';
import type { ResolvedTeamMember } from '@shared/types';

export function useDirectMessageQueue(options: {
  teamName: string;
  recipient: string;
  members: readonly ResolvedTeamMember[];
  draft: UseComposerDraftResult;
  onSend: MemberMessageComposerProps['onSend'];
  disabled: boolean;
  isCrossTeam: boolean;
}): ManualQueueBinding {
  const { t } = useAppTranslation('team');
  const { draft } = options;
  const participant = normalizeConversationParticipant(options.recipient);
  const member = options.members.find(
    (candidate) => normalizeConversationParticipant(candidate.name) === participant
  );
  const route = {
    kind: 'direct' as const,
    participant,
    ...(member?.agentId ? { agentId: member.agentId } : {}),
    ...(member?.joinedAt !== undefined ? { joinedAt: member.joinedAt } : {}),
  };
  const unsupported =
    options.isCrossTeam ||
    draft.chips.length > 0 ||
    draft.attachments.length > 0 ||
    draft.actionMode === 'delegate' ||
    draft.editorContext.kind !== 'plain' ||
    draft.snapshot().restoredOrigin ||
    parseStandaloneSlashCommand(stripEncodedTaskReferenceMetadata(draft.text).trim()) !== null;
  const blockedReason = (item: QueueItem): string | null => {
    if (options.disabled || options.isCrossTeam)
      return String(t('messages.manualQueue.queueDisabled'));
    if (item.route.kind !== 'direct') return String(t('messages.manualQueue.recipientUnavailable'));
    const captured = item.route;
    const recipient = options.members.find(
      (candidate) => normalizeConversationParticipant(candidate.name) === captured.participant
    );
    return !recipient ||
      (item.route.agentId && recipient.agentId !== item.route.agentId) ||
      (item.route.joinedAt !== undefined && recipient.joinedAt !== item.route.joinedAt)
      ? String(t('messages.manualQueue.recipientUnavailable'))
      : null;
  };
  return useManualMessageQueue({
    teamName: options.teamName,
    route,
    unavailableReason: unsupported
      ? String(t('messages.manualQueue.richUnsupported'))
      : !draft.canSubmit || options.disabled
        ? String(t('messages.manualQueue.queueDisabled'))
        : draft.persistenceStatus === 'memory-only'
          ? String(t('messages.manualQueue.persistenceRequired'))
          : undefined,
    consume: async (commit) => {
      const snapshot = draft.snapshot();
      const expected = {
        addressKey: draft.addressKey,
        loadGeneration: draft.loadGeneration,
        localEditCounter: draft.localEditCounter,
      };
      await draft.flush();
      const loaded = await composerDraftRepository.loadWorking(draft.address);
      if (loaded.status !== 'durable') throw new Error('persistenceRequired');
      if (
        loaded.writeBlocked ||
        JSON.stringify(loaded.working.content) !== JSON.stringify(snapshot)
      )
        throw new Error('queue-conflict');
      const cleared = await commit(loaded.working);
      composerDraftRepository.acceptExternalWorkingCommit?.(cleared);
      draft.adoptWorking(cleared, expected);
    },
    blockedReason,
    prepare: (item, messageId) => {
      if (item.route.kind !== 'direct') throw new Error('queue-conflict');
      const text = stripEncodedTaskReferenceMetadata(item.text).trim();
      const prepared = buildPreparedSendRequest({
        attemptId: messageId,
        teamName: item.scope.teamName,
        selectedTeam: null,
        crossTeamRecipient: null,
        localRecipient: item.route.participant,
        text,
        summary: text,
        attachments: [],
        actionMode: item.actionMode,
        taskRefs: extractTaskRefsFromText(
          item.text,
          getTaskSuggestionsForTeamNow(item.scope.teamName)
        ),
      });
      if (prepared.kind !== 'local') throw new Error('queue-conflict');
      return { ...prepared.request, messageId, actionMode: item.actionMode };
    },
    transport: (item, request) => {
      if (item.route.kind !== 'direct') throw new Error('queue-conflict');
      return options.onSend(
        item.route.participant,
        request.text,
        request.summary,
        undefined,
        request.actionMode,
        request.taskRefs,
        request.messageId
      );
    },
    refresh: () => useStore.getState().refreshTeamData(options.teamName),
  });
}
