import { describe, expect, it } from 'vitest';

import { mergeComposerOutboxTimelineItems } from './composerOutboxTimeline';

import type { TimelineItem } from './LeadThoughtsGroup';
import type { ComposerOutboxItem } from '@renderer/services/composerOutbox';
import type { InboxMessage } from '@shared/types';

function message(id: string, timestamp: string): TimelineItem {
  return {
    type: 'message',
    message: { messageId: id, timestamp, text: id } as InboxMessage,
  };
}

function outbox(id: string, createdAt: number): ComposerOutboxItem {
  return {
    id,
    source: { kind: 'recovery', recoveryId: id },
    address: null,
    status: 'not-sent',
    createdAt,
    updatedAt: createdAt,
    displayText: id,
    attachments: [],
    attachmentCount: 0,
    chipCount: 0,
    duplicateRisk: false,
    persistenceStatus: 'durable',
  };
}

describe('mergeComposerOutboxTimelineItems', () => {
  it('stably merges newest-first without consuming canonical history budget', () => {
    const timestamp = Date.parse('2026-09-22T12:00:00.000Z');
    const result = mergeComposerOutboxTimelineItems(
      [
        message('canonical-new', new Date(timestamp + 100).toISOString()),
        message('canonical-equal', new Date(timestamp).toISOString()),
        message('canonical-old', new Date(timestamp - 100).toISOString()),
      ],
      [outbox('outbox-new', timestamp + 50), outbox('outbox-equal', timestamp)]
    );

    expect(
      result.map((item) =>
        item.type === 'composer-outbox'
          ? item.item.id
          : item.type === 'lead-thoughts'
            ? 'thought-group'
            : item.message.messageId
      )
    ).toEqual([
      'canonical-new',
      'outbox-new',
      'canonical-equal',
      'outbox-equal',
      'canonical-old',
    ]);
  });
});
