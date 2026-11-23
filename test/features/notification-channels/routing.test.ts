import { describe, expect, it } from 'vitest';

import {
  isDeliveryEvent,
  normalizeChannelInput,
  toOutboundNotification,
  validateProviderCredential,
} from '@features/notification-channels/core/domain/routing';

import type { DetectedError } from '@shared/types/notifications';

const base = {
  name: 'Telegram',
  provider: 'telegram',
  enabled: true,
  events: ['user_inbox', 'task_blocked'],
  chatId: '12345',
  secret: '123456789:abcdefghijklmnopqrstuvwxyz_0123456789',
};

describe('Notification Channels domain', () => {
  it('rejects unsupported event types and arbitrary providers', () => {
    expect(() => normalizeChannelInput({ ...base, events: ['text'] })).toThrow();
    expect(() => normalizeChannelInput({ ...base, provider: 'webhook' })).toThrow();
    expect(() => normalizeChannelInput({ ...base, provider: { toString: () => 'telegram' } })).toThrow();
    expect(isDeliveryEvent('user_inbox')).toBe(true);
    expect(isDeliveryEvent('tool_result')).toBe(false);
  });

  it('validates only official HTTPS destinations (SSRF protection)', () => {
    expect(() => validateProviderCredential('discord',
      'https://127.0.0.1/api/webhooks/123/secret')).toThrow();
    expect(() => validateProviderCredential('slack',
      'https://hooks.slack.com.evil.test/services/a/b/c')).toThrow();
    expect(() => validateProviderCredential('discord',
      'https://discord.com:444/api/webhooks/123/secret')).toThrow();
    expect(() => validateProviderCredential('discord',
      'https://discord.com/api/webhooks/123/token')).not.toThrow();
    expect(() => validateProviderCredential('slack',
      'https://hooks.slack.com/services/T/B/X')).not.toThrow();
    expect(() => validateProviderCredential('telegram', base.secret)).not.toThrow();
  });

  it('strips raw message content and team/private identifiers', () => {
    const notification = {
      category: 'team',
      teamEventType: 'user_inbox',
      isRead: false,
      message: 'password=do-not-disclose',
      target: { kind: 'team', teamName: 'private-team' },
    } as DetectedError;
    expect(toOutboundNotification(notification)).toEqual({
      event: 'user_inbox',
      message: 'Agent Teams: Message for you.',
    });
    expect(toOutboundNotification({ ...notification, isRead: true })).toBeNull();
    expect(toOutboundNotification({ ...notification, category: 'error' })).toBeNull();
    expect(toOutboundNotification({ ...notification, teamEventType: 'lead_inbox' })).toBeNull();
  });
});
