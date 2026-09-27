import { describe, expect, it } from 'vitest';

import {
  buildWideChatAvatarContinuationFlags,
  buildWideChatContinuationFlags,
} from './wideChatTimelinePresentation';

import type { TimelineRow } from './timelineRows';

const messageRow = (index: number, from: string, to: string): TimelineRow => ({
  kind: 'message-row',
  key: `message-${index}`,
  itemIndex: index,
  message: {
    from,
    to,
    text: `Message ${index}`,
    timestamp: '2026-09-27T12:00:00.000Z',
    read: true,
  },
});

describe('wide chat avatar continuation', () => {
  it('groups one agent avatar across recipients without hiding each recipient route', () => {
    const rows = [
      messageRow(0, 'lead', 'atlas'),
      messageRow(1, 'lead', 'echo'),
      messageRow(2, 'lead', 'user'),
      messageRow(3, 'atlas', 'user'),
    ];
    const args = {
      appearance: 'wide-chat' as const,
      rows,
      teamName: 'sandbox-team',
      isCollapsed: () => false,
    };

    expect(buildWideChatContinuationFlags(args)).toEqual([false, false, false, false]);
    expect(buildWideChatAvatarContinuationFlags(args)).toEqual([false, true, true, false]);
  });

  it('breaks an avatar run at another author or a non-message row', () => {
    const rows: TimelineRow[] = [
      messageRow(0, 'lead', 'atlas'),
      messageRow(1, 'atlas', 'user'),
      messageRow(2, 'lead', 'echo'),
      { kind: 'session-separator', key: 'session' },
      messageRow(4, 'lead', 'nova'),
    ];

    expect(
      buildWideChatAvatarContinuationFlags({
        appearance: 'wide-chat',
        rows,
        teamName: 'sandbox-team',
        isCollapsed: () => false,
      })
    ).toEqual([false, false, false, false, false]);
  });
});
