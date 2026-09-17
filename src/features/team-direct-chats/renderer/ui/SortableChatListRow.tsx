import { useEffect, useRef } from 'react';

import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useAppTranslation } from '@features/localization/renderer';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@renderer/components/ui/context-menu';
import { Pin, PinOff } from 'lucide-react';

import { conversationScopeKey } from '../../core/domain/conversationScope';

import { ChatListRow } from './ChatListRow';

import type { ConversationScope } from '../../core/domain/conversationScope';
import type { ChatListViewItem } from '../view-models/chatListViewModel';
import type { JSX } from 'react';

interface SortableChatListRowProps {
  item: ChatListViewItem;
  teamName: string;
  pinned: boolean;
  onOpen: (scope: ConversationScope) => void;
  onTogglePin: (key: string) => void;
}

export const SortableChatListRow = ({
  item,
  teamName,
  pinned,
  onOpen,
  onTogglePin,
}: SortableChatListRowProps): JSX.Element => {
  const { t } = useAppTranslation('team');
  const key = conversationScopeKey(item.scope);
  const skipOpenAfterDragRef = useRef(false);
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: key,
    disabled: !pinned,
  });

  useEffect(() => {
    if (isDragging) {
      skipOpenAfterDragRef.current = true;
    }
  }, [isDragging]);

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.55 : 1,
  };

  const dragListeners = pinned ? listeners : undefined;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={pinned ? 'cursor-grab active:cursor-grabbing' : undefined}
      {...dragListeners}
    >
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <ChatListRow
            item={item}
            teamName={teamName}
            pinned={pinned}
            onOpen={(scope) => {
              if (skipOpenAfterDragRef.current) {
                skipOpenAfterDragRef.current = false;
                return;
              }
              onOpen(scope);
            }}
          />
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem
            onSelect={() => {
              onTogglePin(key);
            }}
          >
            {pinned ? <PinOff size={12} /> : <Pin size={12} />}
            {pinned ? t('messages.chats.unpin') : t('messages.chats.pin')}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </div>
  );
};
