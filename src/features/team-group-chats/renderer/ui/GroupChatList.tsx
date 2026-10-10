import { useAppTranslation } from '@features/localization/renderer';
import {
  ChatUnreadBadges,
  type ConversationScope,
  countUniqueUnread,
  GroupChatAvatar,
} from '@features/team-direct-chats/renderer';
import { toMessageKey } from '@renderer/utils/teamMessageKey';
import { Archive, Plus } from 'lucide-react';

import type { TeamGroupChatDTO } from '../../contracts';
import type { InboxMessage } from '@shared/types';

export const GroupChatList = ({
  groups,
  messages,
  readSet,
  selectedScope,
  onOpen,
  onCreate,
  error,
}: {
  groups: readonly TeamGroupChatDTO[];
  messages: readonly InboxMessage[];
  readSet: ReadonlySet<string>;
  selectedScope?: ConversationScope;
  onOpen: (scope: ConversationScope) => void;
  onCreate: () => void;
  error: string | null;
}) => {
  const { t } = useAppTranslation('team');
  const active = groups.filter((group) => !group.archivedAt);
  const archived = groups.filter((group) => group.archivedAt);
  const row = (group: TeamGroupChatDTO) => {
    const history = messages.filter(
      (message) => message.groupChatId === group.id && message.messageId === message.groupMessageId
    );
    const unread = countUniqueUnread(history, readSet, toMessageKey);
    return (
      <button
        type="button"
        key={group.id}
        data-group-chat-id={group.id}
        data-archived={!!group.archivedAt}
        aria-pressed={selectedScope?.kind === 'group' && selectedScope.groupChatId === group.id}
        className={`flex w-full items-center gap-2.5 rounded px-2 py-2 text-left hover:bg-[var(--color-surface-raised)] ${group.archivedAt ? 'opacity-50' : ''}`}
        onClick={() => onOpen({ kind: 'group', groupChatId: group.id })}
      >
        <GroupChatAvatar />
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
          <span className="block truncate text-xs text-[var(--color-text-muted)]">
            {history.at(-1)?.text || t('messages.chats.emptyPreview')}
          </span>
        </span>
        <ChatUnreadBadges {...unread} />
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
