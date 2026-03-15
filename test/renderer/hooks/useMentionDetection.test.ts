import { describe, expect, it } from 'vitest';

import { findMentionTrigger } from '@renderer/hooks/useMentionDetection';

describe('findMentionTrigger', () => {
  it('detects @query at start of text', () => {
    const result = findMentionTrigger('@ali', 4);
    expect(result).toEqual({ triggerIndex: 0, triggerChar: '@', query: 'ali' });
  });

  it('detects @query after space', () => {
    const result = findMentionTrigger('hello @bo', 9);
    expect(result).toEqual({ triggerIndex: 6, triggerChar: '@', query: 'bo' });
  });

  it('returns null for email-like @ (no space before)', () => {
    const result = findMentionTrigger('email@test', 10);
    expect(result).toBeNull();
  });

  it('returns null when space follows @ query (mention already complete)', () => {
    const result = findMentionTrigger('@alice ', 7);
    expect(result).toBeNull();
  });

  it('returns empty query for bare @', () => {
    const result = findMentionTrigger('@', 1);
    expect(result).toEqual({ triggerIndex: 0, triggerChar: '@', query: '' });
  });

  it('detects @ after newline', () => {
    const result = findMentionTrigger('text\n@ca', 8);
    expect(result).toEqual({ triggerIndex: 5, triggerChar: '@', query: 'ca' });
  });

  it('returns null for empty text', () => {
    const result = findMentionTrigger('', 0);
    expect(result).toBeNull();
  });

  it('detects @ after tab', () => {
    const result = findMentionTrigger('hello\t@bob', 10);
    expect(result).toEqual({ triggerIndex: 6, triggerChar: '@', query: 'bob' });
  });

  it('returns null when cursor is at position 0', () => {
    const result = findMentionTrigger('@test', 0);
    expect(result).toBeNull();
  });

  it('detects @ with empty query after space', () => {
    const result = findMentionTrigger('hello @', 7);
    expect(result).toEqual({ triggerIndex: 6, triggerChar: '@', query: '' });
  });

  it('handles multiple @ signs - picks nearest valid one', () => {
    const result = findMentionTrigger('@alice hello @bo', 16);
    expect(result).toEqual({ triggerIndex: 13, triggerChar: '@', query: 'bo' });
  });

  it('returns null for @ in middle of word', () => {
    const result = findMentionTrigger('test@domain', 11);
    expect(result).toBeNull();
  });

  it('detects @ after carriage return', () => {
    const result = findMentionTrigger('text\r\n@ca', 9);
    expect(result).toEqual({ triggerIndex: 6, triggerChar: '@', query: 'ca' });
  });
});
