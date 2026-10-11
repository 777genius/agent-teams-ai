import { useAppTranslation } from '@features/localization/renderer';
import { api } from '@renderer/api';
import { getTaskSuggestionsForTeamNow } from '@renderer/hooks/useTaskSuggestions';
import {
  extractTaskRefsFromText,
  stripEncodedTaskReferenceMetadata,
} from '@renderer/utils/taskReferenceUtils';
import { parseStandaloneSlashCommand } from '@shared/utils/slashCommands';

import { type ManualQueueBinding, useManualMessageQueue } from './useManualMessageQueue';

import type { QueueItem } from '../../core/domain/queue';
import type { TeamGroupChatDTO } from '@features/team-group-chats/contracts';
import type { useGroupChatComposer } from '@features/team-group-chats/renderer';

export function useGroupMessageQueue(options: {
  teamName: string;
  groupChatId: string;
  group?: TeamGroupChatDTO;
  composer: ReturnType<typeof useGroupChatComposer>;
  refresh: () => Promise<void>;
  fallbackCanSend?: boolean;
}): ManualQueueBinding {
  const { t } = useAppTranslation('team');
  const { composer, group } = options;
  const blockedReason = (item: QueueItem): string | null => {
    if (
      item.route.kind !== 'group' ||
      (group ? !!group.archivedAt || group.memberNames.length < 2 : !options.fallbackCanSend)
    )
      return String(t('messages.manualQueue.recipientUnavailable'));
    return item.route.recipientName === null
      ? (group ? !group.canSend : !options.fallbackCanSend)
        ? String(t('messages.groups.restartHint'))
        : null
      : !group?.memberNames.includes(item.route.recipientName) ||
          !group.availableRecipientNames.includes(item.route.recipientName)
        ? String(t('messages.manualQueue.recipientUnavailable'))
        : null;
  };
  return useManualMessageQueue({
    teamName: options.teamName,
    route: {
      kind: 'group',
      groupChatId: options.groupChatId,
      recipientName: composer.recipientName,
    },
    text: composer.text,
    unavailableReason:
      parseStandaloneSlashCommand(stripEncodedTaskReferenceMetadata(composer.text).trim()) !== null
        ? String(t('messages.manualQueue.richUnsupported'))
        : !composer.ready || composer.pending || composer.attemptId || group?.archivedAt
          ? String(t('messages.manualQueue.queueDisabled'))
          : undefined,
    consume: composer.consumeForQueue,
    blockedReason,
    prepare: (item, messageId) => ({
      messageId,
      text: stripEncodedTaskReferenceMetadata(item.text).trim(),
      actionMode: 'do',
      taskRefs: extractTaskRefsFromText(
        item.text,
        getTaskSuggestionsForTeamNow(item.scope.teamName)
      ),
    }),
    transport: (item, request) => {
      if (item.route.kind !== 'group') throw new Error('queue-conflict');
      return api.teamGroupChats.send({
        teamName: item.scope.teamName,
        groupChatId: item.route.groupChatId,
        messageId: request.messageId,
        text: request.text,
        taskRefs: request.taskRefs,
        ...(item.route.recipientName === null ? {} : { recipientName: item.route.recipientName }),
      });
    },
    refresh: options.refresh,
  });
}
