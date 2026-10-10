import { useAppTranslation } from '@features/localization/renderer';
import {
  GroupChatArchiveAction,
  useGroupChatComposer,
  useGroupChatHistory,
  useTeamGroupChats,
} from '@features/team-group-chats/renderer';

import { ThreadAwareMessageComposer } from './ThreadAwareMessageComposer';

import type { TextMessageComposerProps } from './TextMessageComposer';
import type { ConversationScope } from '@features/team-direct-chats/renderer';
import type { InboxMessage, ResolvedTeamMember } from '@shared/types';

/** Joins the group catalog, durable history and draft for one conversation. */
export function useMessagesGroupConversation(
  teamName: string,
  contextId: string,
  members: ResolvedTeamMember[],
  scope: ConversationScope,
  editorOptions: Pick<
    TextMessageComposerProps,
    'textareaRef' | 'autoFocusKey' | 'suggestionPlacement'
  >
) {
  const { t } = useAppTranslation('team');
  const groupId = scope.kind === 'group' ? scope.groupChatId : undefined;
  const catalog = useTeamGroupChats(teamName, contextId, members.map((m) => m.name).join('\0'));
  const history = useGroupChatHistory(teamName, contextId, groupId);
  const group = catalog.groups.find((item) => item.id === groupId);
  const composer = useGroupChatComposer(
    teamName,
    contextId,
    groupId ?? '',
    history.refresh,
    group?.name
  );
  const archiveAction = groupId ? (
    <GroupChatArchiveAction key={groupId} group={group} setArchived={catalog.setArchived} />
  ) : undefined;
  const saved = history.messages.findLast((message) => message.from === 'user');
  const lastResult =
    composer.result ??
    (saved?.messageId
      ? {
          deliverySummary: saved.groupDeliverySummary,
        }
      : undefined);
  const blocked = !group?.canSend || !!group.archivedAt;
  const renderComposer = (
    options: Pick<TextMessageComposerProps, 'layout' | 'widthMode' | 'cornerActionPrefix'> = {}
  ) => (
    <div data-testid="group-chat-composer">
      <ThreadAwareMessageComposer
        {...editorOptions}
        {...options}
        teamName={teamName}
        textInput={{
          label: group?.name ?? t('messages.groups.unavailable'),
          ariaLabel: t('messages.groups.message'),
          value: composer.text,
          readOnly: !!group?.archivedAt || composer.pending || !!composer.attemptId,
          disabled: !composer.ready,
          canSend: !blocked && composer.ready && !composer.pending && !!composer.text.trim(),
          sendLabel: composer.pending
            ? t('messages.groups.sending')
            : composer.attemptId
              ? t('messages.groups.retrySend')
              : t('messages.groups.send'),
          onChange: composer.change,
          onSend: () => void composer.send(),
        }}
        notice={
          <>
            {blocked ? (
              <p role="status" className="text-xs text-[var(--color-text-muted)]">
                {group?.archivedAt
                  ? t('messages.groups.archivedHint')
                  : t('messages.groups.restartHint')}
              </p>
            ) : null}
            {composer.error ? (
              <p role="alert" className="text-xs text-red-400">
                {composer.error}
              </p>
            ) : null}
            {lastResult ? (
              <p role="status" className="text-xs text-[var(--color-text-muted)]">
                {lastResult.deliverySummary?.recipients
                  .map(
                    (recipient) =>
                      `${recipient.memberName}: ${t(`messages.groups.delivery.${recipient.status}`)}`
                  )
                  .join(', ') || t('messages.groups.unknownDelivery')}
              </p>
            ) : null}
          </>
        }
      />
    </div>
  );
  const quote = (message: InboxMessage) => {
    if (composer.ready && !composer.attemptId && !composer.pending && !group?.archivedAt)
      composer.change(
        `${message.text
          .split('\n')
          .map((line) => `> ${line}`)
          .join('\n')}\n\n${composer.text}`
      );
  };
  return { groupId, group, catalog, history, composer, archiveAction, renderComposer, quote };
}
