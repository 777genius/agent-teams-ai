import { toMessageKey } from '@renderer/utils/teamMessageKey';
import { describe, expect, it } from 'vitest';

import {
  buildConversationNewItemKeys,
  buildTimelineItemKeys,
  buildZebraShadeSet,
} from './timelineItemPresentation';

import type { ActivityTimelineItem } from './composerOutboxTimeline';
import type { InboxMessage } from '@shared/types';

const message = (id: string): InboxMessage => ({
  from: 'lead',
  to: 'user',
  text: id,
  timestamp: `2026-09-27T12:00:0${id}.000Z`,
  messageId: id,
  read: true,
});

describe('timeline item presentation', () => {
  it('keeps zebra striping anchored to the newest card when an older card is prepended', () => {
    const items: ActivityTimelineItem[] = ['1', '2', '3'].map((id) => ({
      type: 'message',
      message: message(id),
    }));

    expect([...buildZebraShadeSet(items)]).toEqual([1]);
    expect([...buildZebraShadeSet([{ type: 'message', message: message('0') }, ...items])]).toEqual(
      [2, 0]
    );
  });

  it('marks a thought group fresh only when every thought is fresh', () => {
    const items: ActivityTimelineItem[] = [
      { type: 'message', message: message('1') },
      {
        type: 'lead-thoughts',
        group: { type: 'lead-thoughts', thoughts: [message('2'), message('3')] },
      },
    ];
    const keys = buildTimelineItemKeys(items);

    const first = toMessageKey(message('1'));
    const second = toMessageKey(message('2'));
    const third = toMessageKey(message('3'));
    expect([...buildConversationNewItemKeys(items, keys, new Set([first, second]))]).toEqual([
      keys[0],
    ]);
    expect([...buildConversationNewItemKeys(items, keys, new Set([first, second, third]))]).toEqual(
      keys
    );
  });
});
