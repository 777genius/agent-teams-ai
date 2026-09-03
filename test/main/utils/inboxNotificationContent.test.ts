import { describe, expect, it } from 'vitest';

import { extractNotificationContent } from '@main/utils/inboxNotificationContent';

describe('extractNotificationContent', () => {
  it('truncates plain text into the summary and keeps the full body', () => {
    const text = 'a'.repeat(120);
    expect(extractNotificationContent(text)).toEqual({
      summary: 'a'.repeat(80),
      body: text,
    });
  });

  it('prefers the serialized summary and content fields', () => {
    const text = JSON.stringify({
      type: 'message',
      content: 'Full message body',
      summary: 'Short summary',
    });
    expect(extractNotificationContent(text)).toEqual({
      summary: 'Short summary',
      body: 'Full message body',
    });
  });

  it('falls back to the content when no summary is present', () => {
    const text = JSON.stringify({ type: 'message', content: 'b'.repeat(120) });
    expect(extractNotificationContent(text)).toEqual({
      summary: 'b'.repeat(80),
      body: 'b'.repeat(120),
    });
  });

  it('falls back to the message field when content is missing', () => {
    const text = JSON.stringify({ type: 'message', message: 'Message field' });
    expect(extractNotificationContent(text)).toEqual({
      summary: 'Message field',
      body: 'Message field',
    });
  });

  it('treats non-JSON payloads as plain text', () => {
    expect(extractNotificationContent('{ not json')).toEqual({
      summary: '{ not json',
      body: '{ not json',
    });
  });
});
