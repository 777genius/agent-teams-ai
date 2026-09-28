import { describe, expect, it } from 'vitest';

import { requiresWideChatContent } from './wideChatMessageSizing';

describe('requiresWideChatContent', () => {
  it('keeps a short reply compact even when its transport wrapper is fenced', () => {
    const transportText =
      '```message_reply_for_agent\nReply on @atlas original message with text "Quick QA pass:", here is answer: "Thanks!"\n```';

    expect(requiresWideChatContent(transportText, 'Thanks!')).toBe(false);
  });

  it('widens genuinely long or structured visible answers', () => {
    expect(requiresWideChatContent('ignored transport text', 'x'.repeat(600))).toBe(true);
    expect(requiresWideChatContent('ignored transport text', '```ts\nconst ok = true;\n```')).toBe(
      true
    );
    expect(requiresWideChatContent('| Item | Status |\n| --- | --- |')).toBe(true);
  });

  it('keeps ordinary short messages compact', () => {
    expect(requiresWideChatContent('A short note')).toBe(false);
    expect(requiresWideChatContent(null)).toBe(false);
  });
});
