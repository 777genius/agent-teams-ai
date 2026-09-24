import React, { act, cloneElement } from 'react';
import { createRoot } from 'react-dom/client';

import { DndContext } from '@dnd-kit/core';
import { SortableContext } from '@dnd-kit/sortable';
import { ChatListRow } from '@features/team-direct-chats/renderer/ui/ChatListRow';
import { SortableChatListRow } from '@features/team-direct-chats/renderer/ui/SortableChatListRow';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChatListViewItem } from '@features/team-direct-chats/renderer/view-models/chatListViewModel';

const aliceItem: ChatListViewItem = {
  scope: { kind: 'direct', participant: 'alice' },
  displayName: 'alice',
  member: { name: 'alice' },
  unreadCount: 0,
  attentionCount: 0,
  previewText: 'hello',
  previewFrom: 'alice',
  previewTimestamp: null,
};

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({
    t: (key: string, vars?: { name?: string }) => {
      if (key === 'messages.chats.rowAria') {
        return `row:${vars?.name ?? ''}`;
      }
      if (key === 'messages.chats.pin') {
        return 'Pin chat';
      }
      if (key === 'messages.chats.unpin') {
        return 'Unpin chat';
      }
      return key;
    },
  }),
}));

vi.mock('@features/team-direct-chats/renderer/hooks/useChatMemberIdentity', () => ({
  useChatMemberIdentity: () => ({
    name: 'alice',
    color: 'blue',
    avatarUrl: '',
    presenceClass: '',
    presenceLabel: 'offline',
    avatarUrlFor: () => '',
  }),
}));

vi.mock('@renderer/components/team/members/MemberIdentityAvatar', () => ({
  MemberIdentityAvatar: () => React.createElement('span', { 'data-avatar': 'member' }),
}));

vi.mock('@features/team-direct-chats/renderer/ui/ChatPreviewLine', () => ({
  ChatPreviewLine: ({ text }: { text: string }) => React.createElement('span', null, text),
}));

vi.mock('@features/team-direct-chats/renderer/ui/ChatUnreadBadges', () => ({
  ChatUnreadBadges: () => null,
}));

afterEach(() => {
  document.body.innerHTML = '';
});

async function renderNode(node: React.ReactElement): Promise<HTMLDivElement> {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(node);
    await Promise.resolve();
  });
  return host;
}

describe('ChatListRow context menu slot contract', () => {
  it.each([NaN, Infinity, 8.64e15 + 1, 'invalid'])(
    'keeps a draft visible with invalid updatedAt %s',
    async (updatedAt) => {
      const host = await renderNode(
        <ChatListRow
          item={{
            ...aliceItem,
            draft: {
              preview: 'Unsaved text',
              updatedAt: updatedAt as number,
              attachmentCount: 0,
              chipCount: 0,
              editorKind: 'plain',
            },
          }}
          teamName="robots"
          onOpen={() => undefined}
        />
      );
      expect(host.textContent).toContain('Unsaved text');
      expect(host.querySelector('button')).not.toBeNull();
    }
  );

  it('forwards Radix-style cloned context menu handlers onto the row button', async () => {
    const onContextMenu = vi.fn((event: Event) => {
      event.preventDefault();
    });
    const host = await renderNode(
      cloneElement(<ChatListRow item={aliceItem} teamName="robots" onOpen={() => undefined} />, {
        onContextMenu,
        'data-context-menu-trigger': 'true',
      })
    );

    const button = host.querySelector('button');
    expect(button).not.toBeNull();
    expect(button?.getAttribute('data-context-menu-trigger')).toBe('true');

    await act(async () => {
      button?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });

    expect(onContextMenu).toHaveBeenCalledTimes(1);
  });
});

describe('SortableChatListRow pin menu', () => {
  it('opens the pin action from a right-click on the chat row', async () => {
    const onTogglePin = vi.fn();
    const host = await renderNode(
      <DndContext>
        <SortableContext items={['direct:alice']}>
          <SortableChatListRow
            item={aliceItem}
            teamName="robots"
            pinned={false}
            onOpen={() => undefined}
            onTogglePin={onTogglePin}
          />
        </SortableContext>
      </DndContext>
    );

    const button = host.querySelector('button');
    expect(button).not.toBeNull();

    await act(async () => {
      button?.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 24,
          clientY: 24,
        })
      );
      await Promise.resolve();
    });

    const pinItem = Array.from(document.querySelectorAll('[role="menuitem"]')).find((item) =>
      item.textContent?.includes('Pin chat')
    );
    expect(pinItem).toBeDefined();

    await act(async () => {
      pinItem?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });

    expect(onTogglePin).toHaveBeenCalledWith('direct:alice');
  });
});
