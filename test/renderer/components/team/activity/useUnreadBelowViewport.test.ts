import { getConversationVisibleBottom } from '@renderer/components/team/activity/conversationVisibleArea';
import {
  countUnreadBelowViewport,
  resolveVirtualRowBounds,
} from '@renderer/components/team/activity/useUnreadBelowViewport';
import { describe, expect, it, vi } from 'vitest';

import { msg } from '../../../../features/team-direct-chats/core/domain/fixtures';

import type { TimelineRow } from '@renderer/components/team/activity/timelineRows';

function messageRow(id: string, from: string, top: number, height = 20): [TimelineRow, number, number] {
  return [
    {
      kind: 'message-row',
      key: id,
      itemIndex: 0,
      message: msg({ messageId: id, from, to: 'user', text: id }),
    },
    top,
    top + height,
  ];
}

describe('unread messages below the viewport', () => {
  it('counts only unique incoming unread rows below the visible edge', () => {
    const entries = [
      messageRow('above', 'alice', 40),
      messageRow('visible', 'alice', 280),
      messageRow('covered-partly', 'alice', 290),
      messageRow('below', 'alice', 300),
      messageRow('sent', 'user', 350),
      messageRow('read', 'alice', 360),
      messageRow('below', 'alice', 370),
    ];
    const rows = entries.map(([row]) => row);
    expect(
      countUnreadBelowViewport(rows, new Set(['read']), 300, (_, index) => ({
        top: entries[index][1],
        bottom: entries[index][2],
      }))
    ).toBe(2);
  });

  it('uses the footer edge only while the footer overlaps the scroll viewport', () => {
    const layout = document.createElement('div');
    layout.dataset.messagesThreadLayout = 'wide';
    const scroll = document.createElement('div');
    const footer = document.createElement('div');
    footer.dataset.messagesThreadFooter = 'true';
    layout.append(scroll, footer);
    document.body.append(layout);
    const rect = (top: number, bottom: number): DOMRect =>
      ({ top, bottom } as DOMRect);
    vi.spyOn(scroll, 'getBoundingClientRect').mockReturnValue(rect(0, 400));
    vi.spyOn(footer, 'getBoundingClientRect').mockReturnValue(rect(300, 500));
    expect(getConversationVisibleBottom(scroll)).toBe(300);
    const fade = document.createElement('div');
    fade.dataset.messagesThreadFooterFade = 'true';
    layout.append(fade);
    vi.spyOn(fade, 'getBoundingClientRect').mockReturnValue(rect(272, 300));
    expect(getConversationVisibleBottom(scroll)).toBe(272);
    fade.remove();
    vi.spyOn(footer, 'getBoundingClientRect').mockReturnValue(rect(400, 500));
    expect(getConversationVisibleBottom(scroll)).toBe(400);
    vi.restoreAllMocks();
    layout.remove();
  });

  it('counts unmounted virtual rows after the mounted window without offset estimates', () => {
    const rows = [
      messageRow('before', 'alice', 0)[0],
      messageRow('mounted', 'alice', 280)[0],
      messageRow('unmounted-incoming', 'alice', 500)[0],
      messageRow('unmounted-outgoing', 'user', 520)[0],
    ];
    const mounted = new Map([
      ['mounted', { top: 280, bottom: 300 }],
    ]);
    expect(
      countUnreadBelowViewport(rows, new Set(), 300, (row, index) =>
        resolveVirtualRowBounds(row.key, index, mounted, 1, true)
      )
    ).toBe(1);
  });
});
