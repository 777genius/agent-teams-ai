import { useCallback, useMemo } from 'react';

import { closestCenter, DndContext, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { useAppTranslation } from '@features/localization/renderer';

import { conversationScopeKey } from '../../core/domain/conversationScope';
import { applyPinnedChatOrder } from '../../core/domain/pinnedChatOrder';
import { usePinnedChats } from '../hooks/usePinnedChats';

import { SortableChatListRow } from './SortableChatListRow';

import type { ConversationScope } from '../../core/domain/conversationScope';
import type { ChatListViewItem } from '../view-models/chatListViewModel';
import type { DragEndEvent } from '@dnd-kit/core';
import type { JSX } from 'react';

interface ChatListProps {
  items: readonly ChatListViewItem[];
  teamName: string;
  onOpen: (scope: ConversationScope) => void;
  selectedScope?: ConversationScope;
}

export const ChatList = ({
  items,
  teamName,
  onOpen,
  selectedScope,
}: ChatListProps): JSX.Element => {
  const { t } = useAppTranslation('team');
  const { pinnedKeys, togglePin, reorderPinned } = usePinnedChats(teamName);
  const pinnedSet = useMemo(() => new Set(pinnedKeys), [pinnedKeys]);
  const orderedItems = useMemo(() => applyPinnedChatOrder(items, pinnedKeys), [items, pinnedKeys]);
  const sortableIds = useMemo(
    () => orderedItems.map((item) => conversationScopeKey(item.scope)),
    [orderedItems]
  );
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    })
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const overId = event.over?.id;
      if (!overId || event.active.id === overId) {
        return;
      }
      reorderPinned(String(event.active.id), String(overId));
    },
    [reorderPinned]
  );

  const handleTogglePin = useCallback(
    (key: string) => {
      togglePin(
        key,
        items.map((item) => item.scope)
      );
    },
    [items, togglePin]
  );

  if (items.length === 0) {
    return (
      <p className="px-3 py-6 text-center text-xs text-[var(--color-text-muted)]">
        {t('messages.chats.emptyList')}
      </p>
    );
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
        <div className="flex flex-col gap-0.5 overflow-visible px-1 pb-3">
          {orderedItems.map((item, index) => {
            const key = conversationScopeKey(item.scope);
            const pinned = pinnedSet.has(key);
            const next = orderedItems[index + 1];
            const showPinnedDivider =
              pinned && next !== undefined && !pinnedSet.has(conversationScopeKey(next.scope));
            return (
              <div key={key}>
                <SortableChatListRow
                  item={item}
                  teamName={teamName}
                  pinned={pinned}
                  selected={
                    selectedScope !== undefined &&
                    conversationScopeKey(selectedScope) === conversationScopeKey(item.scope)
                  }
                  onOpen={onOpen}
                  onTogglePin={handleTogglePin}
                />
                {showPinnedDivider ? (
                  <div className="mx-2 my-1 h-px bg-[var(--color-border)]" />
                ) : null}
              </div>
            );
          })}
        </div>
      </SortableContext>
    </DndContext>
  );
};
