import { classifyActivityMessagePresentation } from '@renderer/components/team/activity/activityMessagePresentation';
import {
  buildWideChatContinuationFlags,
  getWideChatRowStyle,
} from '@renderer/components/team/activity/wideChatTimelinePresentation';
import { describe, expect, it } from 'vitest';

import type { TimelineRow } from '@renderer/components/team/activity/timelineRows';
import type { InboxMessage } from '@shared/types';

let messageSequence = 0;

function message(overrides: Partial<InboxMessage> = {}): InboxMessage {
  messageSequence += 1;
  return {
    from: 'alice',
    to: 'lead',
    text: 'Hello from the team',
    timestamp: '2026-09-21T10:00:00.000Z',
    read: true,
    source: 'inbox',
    messageId: `message-${messageSequence}`,
    ...overrides,
  };
}

function row(itemIndex: number, value: InboxMessage): TimelineRow {
  return {
    kind: 'message-row',
    key: value.messageId ?? `row-${itemIndex}`,
    itemIndex,
    message: value,
  };
}

describe('wide chat message presentation', () => {
  it('keeps only ordinary local user messages on the right', () => {
    expect(
      classifyActivityMessagePresentation(
        message({ from: 'user', source: 'user_sent', text: 'Normal reply' }),
        'demo'
      ).kind
    ).toBe('ordinary-user');
    expect(
      classifyActivityMessagePresentation(
        message({ from: 'user', source: 'user_sent', text: '/review' }),
        'demo'
      ).kind
    ).toBe('special');
    expect(
      classifyActivityMessagePresentation(
        message({ from: 'user', source: 'cross_team_sent', to: 'other.lead' }),
        'demo'
      ).kind
    ).toBe('special');
    expect(classifyActivityMessagePresentation(message({ from: 'system' }), 'demo').kind).toBe(
      'special'
    );
  });

  it('groups only adjacent expanded messages with the same exact author and route', () => {
    const rows: TimelineRow[] = [
      row(0, message({ messageId: 'a1' })),
      row(1, message({ messageId: 'a2' })),
      row(2, message({ messageId: 'a3', to: 'bob' })),
      row(3, message({ messageId: 'a4', to: 'bob' })),
      row(4, message({ messageId: 'u1', from: 'user', source: 'user_sent', to: 'bob' })),
      row(5, message({ messageId: 'u2', from: 'user', source: 'user_sent', to: 'bob' })),
      row(6, message({ messageId: 'special', from: 'system' })),
      row(7, message({ messageId: 'a5', to: 'bob' })),
    ];

    expect(
      buildWideChatContinuationFlags({
        appearance: 'wide-chat',
        rows,
        teamName: 'demo',
        isCollapsed: (key) => key === 'a4',
      })
    ).toEqual([false, true, false, false, false, true, false, false]);
    expect(
      buildWideChatContinuationFlags({
        appearance: 'compact',
        rows,
        teamName: 'demo',
        isCollapsed: () => false,
      })
    ).toEqual([]);
  });

  it('reserves the toolbar gutter and applies group spacing inside the measured row', () => {
    expect(getWideChatRowStyle('wide-chat', [false, true], 0)).toMatchObject({
      paddingInlineEnd: 40,
      paddingBlockStart: 0,
    });
    expect(getWideChatRowStyle('wide-chat', [false, true], 1)).toMatchObject({
      paddingInlineEnd: 40,
      paddingBlockStart: 4,
    });
    expect(getWideChatRowStyle('compact', [], 0)).toBeUndefined();
  });
});
