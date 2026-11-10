import { useAppTranslation } from '@features/localization/renderer';
import { agentAvatarUrl, displayMemberName } from '@renderer/utils/memberHelpers';

import type { ChatListDraftPreview } from '../view-models/chatListViewModel';
import type { JSX } from 'react';

interface ChatPreviewLineProps {
  from: string | null;
  text: string;
  avatarUrl?: string;
  draft?: ChatListDraftPreview;
}

export const ChatPreviewLine = ({
  from,
  text,
  avatarUrl,
  draft,
}: ChatPreviewLineProps): JSX.Element => {
  const { t } = useAppTranslation('team');
  if (draft) {
    const preview =
      text ||
      [
        draft.chipCount > 0 ? t('messages.chats.draftReferences', { count: draft.chipCount }) : '',
        draft.attachmentCount > 0
          ? t('messages.chats.draftAttachments', { count: draft.attachmentCount })
          : '',
      ]
        .filter(Boolean)
        .join(', ');
    return (
      <span className="mt-0.5 block truncate text-xs text-[var(--color-text-secondary)]">
        <span className="font-medium text-blue-400">{t('messages.chats.draft')}:</span> {preview}
      </span>
    );
  }
  if (!from) {
    return (
      <span className="mt-0.5 block truncate text-xs text-[var(--color-text-secondary)]">
        {text}
      </span>
    );
  }

  const senderLabel = from === 'user' ? t('messages.chats.you') : displayMemberName(from);
  const showAvatar = from !== 'user' && from !== 'system';

  return (
    <span className="mt-0.5 flex min-w-0 items-center gap-1 text-xs text-[var(--color-text-secondary)]">
      {showAvatar ? (
        <img
          src={avatarUrl ?? agentAvatarUrl(from, 16)}
          alt=""
          className="size-3.5 shrink-0 rounded-full bg-[var(--color-surface-raised)]"
          loading="lazy"
        />
      ) : null}
      <span className="min-w-0 truncate">
        {t('messages.chats.previewFrom', { name: senderLabel, text })}
      </span>
    </span>
  );
};
