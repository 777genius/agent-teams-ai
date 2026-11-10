import {
  calculateConversationWindow,
  classifyConversationHead,
  projectTimelineRows,
} from '@renderer/components/team/activity/conversationWindow';
import { toMessageKey } from '@renderer/utils/teamMessageKey';
import { describe, expect, it } from 'vitest';

import type { InboxMessage } from '@shared/types';

const message = (id: number, thought = false): InboxMessage => ({
  messageId: String(id),
  from: 'team-lead',
  text: 'content',
  read: true,
  timestamp: '2026-09-20T10:00:00Z',
  source: thought ? 'lead_session' : 'inbox',
});
const feed = (newest: number, oldest: number) =>
  Array.from({ length: newest - oldest + 1 }, (_, i) => message(newest - i));
const keys = (messages: InboxMessage[]) => new Set(messages.map(toMessageKey));

describe('conversation committed window', () => {
  it('retains 30 plus 5 head, then Show more starts at the effective boundary', () => {
    const initial = calculateConversationWindow(feed(100, 1), 30);
    const next = calculateConversationWindow(feed(105, 1), 30, keys(initial.visibleMessages));
    expect(next.budget).toBe(35);
    expect(next.visibleMessages.at(-1)?.messageId).toBe('71');
    expect(
      calculateConversationWindow(
        feed(105, 1),
        next.budget + 30,
        keys(next.visibleMessages)
      ).visibleMessages.at(-1)?.messageId
    ).toBe('41');
  });
  it('does not count remote tail as head, including a simultaneous head update', () => {
    const previous = keys(feed(100, 41));
    expect(calculateConversationWindow(feed(100, -9), 60, previous).budget).toBe(60);
    expect(calculateConversationWindow(feed(102, -9), 60, previous).budget).toBe(62);
    expect([...classifyConversationHead(feed(102, -9), keys(feed(100, 1)))]).toEqual([
      '102',
      '101',
    ]);
  });
  it('ignores thought growth and repeated calculations; retains interleaved thoughts', () => {
    const previous = keys(feed(100, 71));
    const input = [
      message(105, true),
      message(104, true),
      ...feed(100, 71),
      message(70, true),
      ...feed(69, 1),
    ];
    const first = calculateConversationWindow(input, 30, previous);
    expect(first.budget).toBe(30);
    expect(first.visibleMessages.at(-1)?.messageId).toBe('70');
    expect(calculateConversationWindow(input, 30, keys(first.visibleMessages))).toEqual(first);
    expect(
      calculateConversationWindow([message(2, true), message(1, true)], 30).visibleMessages
    ).toHaveLength(2);
  });
  it('handles deletion, replacement and Infinity without keeping phantom slots', () => {
    const previous = keys(feed(100, 41));
    expect(
      calculateConversationWindow(
        feed(102, 1).filter((m) => m.messageId !== '41'),
        30,
        previous
      ).budget
    ).toBe(61);
    expect(calculateConversationWindow(feed(300, 201), 60, previous).budget).toBe(30);
    expect(
      calculateConversationWindow(feed(102, -9), Infinity, previous).visibleMessages
    ).toHaveLength(112);
    expect([...classifyConversationHead(feed(300, 201), previous)]).toEqual([]);
  });
  it('reverses atomic boundaries without mutating canonical indices or payloads', () => {
    const canonical = [
      { key: 'A-new', itemIndex: 0 },
      { key: 'A-B' },
      { key: 'B', itemIndex: 1 },
      { key: 'compact' },
      { key: 'B-A' },
      { key: 'A-old', itemIndex: 2 },
    ];
    expect(projectTimelineRows(canonical, 'conversation').map((row) => row.key)).toEqual([
      'A-old',
      'B-A',
      'compact',
      'B',
      'A-B',
      'A-new',
    ]);
    expect(projectTimelineRows(canonical, 'activity')).toBe(canonical);
    expect(canonical[0]).toEqual({ key: 'A-new', itemIndex: 0 });
  });
});
