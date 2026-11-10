import { useAppTranslation } from '@features/localization/renderer';
import {
  type ChatListDraftPreview,
  ChatPreviewLine,
  ChatUnreadBadges,
  type ConversationScope,
  conversationScopeKey,
  countUniqueUnread,
  getChatMessagePreview,
  GroupChatAvatar,
  projectChatPreview,
} from '@features/team-direct-chats/renderer';
import { formatActivityTimestamp } from '@renderer/components/team/activity/activityTimestamp';
import {
  buildMemberAvatarMap,
  displayMemberName,
  resolveMemberAvatarUrl,
} from '@renderer/utils/memberHelpers';
import { toMessageKey } from '@renderer/utils/teamMessageKey';
import { Archive, Plus } from 'lucide-react';

import type { TeamGroupChatDTO } from '../../contracts';
import type { InboxMessage, ResolvedTeamMember } from '@shared/types';

export const GroupChatList = ({
  groups,
  members,
  messages,
  readSet,
  draftsByScope,
  selectedScope,
  onOpen,
  onCreate,
  error,
}: {
  groups: readonly TeamGroupChatDTO[];
  members: readonly ResolvedTeamMember[];
  messages: readonly InboxMessage[];
  readSet: ReadonlySet<string>;
  draftsByScope?: ReadonlyMap<string, ChatListDraftPreview>;
  selectedScope?: ConversationScope;
  onOpen: (scope: ConversationScope) => void;
  onCreate: () => void;
  error: string | null;
}) => {
  const { t } = useAppTranslation('team');
  const avatarMap = buildMemberAvatarMap(members);
  const active = groups.filter((group) => !group.archivedAt);
  const archived = groups.filter((group) => group.archivedAt);
  const row = (group: TeamGroupChatDTO) => {
    const history = messages.filter(
      (message) => message.groupChatId === group.id && message.messageId === message.groupMessageId
    );
    const unread = countUniqueUnread(history, readSet, toMessageKey);
    const latestMessage = history.reduce<InboxMessage | undefined>(
      (latest, message) =>
        !latest || Date.parse(message.timestamp) > Date.parse(latest.timestamp) ? message : latest,
      undefined
    );
    const draft = draftsByScope?.get(
      conversationScopeKey({ kind: 'group', groupChatId: group.id })
    );
    const preview = projectChatPreview(
      {
        ...getChatMessagePreview(latestMessage ?? null, t('messages.chats.emptyPreview')),
        previewTimestamp: latestMessage?.timestamp ?? null,
      },
      draft
    );
    const time = preview.previewTimestamp ? formatActivityTimestamp(preview.previewTimestamp) : '';
    return (
      <button
        type="button"
        key={group.id}
        data-group-chat-id={group.id}
        data-archived={!!group.archivedAt}
        aria-label={`${group.name}, ${t('messages.chats.activityUnread', { count: unread.unreadCount })}, ${t('messages.groups.mentions', { count: unread.attentionCount })}`}
        aria-pressed={selectedScope?.kind === 'group' && selectedScope.groupChatId === group.id}
        className={`flex w-full items-start gap-2.5 overflow-visible rounded px-2 py-2 text-left hover:bg-[var(--color-surface-raised)] ${group.archivedAt ? 'opacity-50' : ''}`}
        onClick={() => onOpen({ kind: 'group', groupChatId: group.id })}
      >
        <GroupChatAvatar
          members={members
            .filter((member) => !member.removedAt && group.memberNames.includes(member.name))
            .map((member) => ({
              name: member.name,
              displayName: displayMemberName(member.name),
              avatarUrl: resolveMemberAvatarUrl(member, avatarMap),
            }))}
        />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-sm font-medium">{group.name}</span>
            {group.archivedAt ? (
              <Archive
                size={12}
                className="shrink-0 text-[var(--color-text-muted)]"
                aria-hidden="true"
              />
            ) : null}
          </span>
          <ChatPreviewLine
            from={preview.previewFrom}
            text={preview.previewText}
            avatarUrl={
              preview.previewFrom
                ? resolveMemberAvatarUrl(
                    members.find((member) => member.name === preview.previewFrom) ?? {
                      name: preview.previewFrom,
                    },
                    avatarMap
                  )
                : undefined
            }
            draft={draft}
          />
        </span>
        <span className="mt-0.5 flex shrink-0 flex-col items-end gap-1 overflow-visible">
          {time ? (
            <span className="text-[10px] tabular-nums text-[var(--color-text-muted)]">{time}</span>
          ) : null}
          <ChatUnreadBadges
            {...unread}
            attentionLabel={t('messages.groups.mentions', { count: unread.attentionCount })}
          />
        </span>
      </button>
    );
  };
  return (
    <div className="px-1 pb-3" data-testid="group-chat-list">
      {active.map(row)}
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded border border-dashed border-[var(--color-border)] px-3 py-2 text-xs text-[var(--color-text-muted)] hover:bg-[var(--color-surface-raised)]"
        onClick={onCreate}
      >
        <GroupChatAvatar />
        {t('messages.groups.create')}
        <Plus size={14} className="ml-auto shrink-0" aria-hidden="true" />
      </button>
      {error ? (
        <p role="alert" className="p-2 text-xs text-red-400">
          {error}
        </p>
      ) : null}
      {archived.length ? (
        <div className="mt-5 border-t border-[var(--color-border)] pt-2">
          <p className="px-2 py-1 text-[10px] text-[var(--color-text-muted)]">
            {t('messages.groups.archived')}
          </p>
          {archived.map(row)}
        </div>
      ) : null}
    </div>
  );
};
