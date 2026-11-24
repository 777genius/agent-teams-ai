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

  it('rejects invalid or orphaned expected-event guards', () => {
    expect(() => normalizeChannelInput({ ...base, expectedEvents: ['task_comment'] })).toThrow();
    expect(() => normalizeChannelInput({
      ...base, id: 'f97bfa8d-5f66-4cd1-a789-12bda1097e28', expectedEvents: ['invalid_event'],
    })).toThrow();
  });

  it('requires a valid existing channel guard for an expected enabled state', () => {
    expect(() => normalizeChannelInput({ ...base, expectedEnabled: false })).toThrow();
    expect(() => normalizeChannelInput({
      ...base, id: 'f97bfa8d-5f66-4cd1-a789-12bda1097e28',
      expectedEnabled: 'false' as never,
    })).toThrow();
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

  it('allows public HTTPS custom destinations and rejects unsafe URL shapes', () => {
    expect(() => validateProviderCredential('webhook',
      'https://hooks.example.org/events?signature=private')).not.toThrow();
    for (const target of [
      'http://hooks.example.org/events',
      'https://127.0.0.1/events',
      'https://localhost/events',
      'https://server.internal/events',
      'https://test.local/events',
      'https://hooks.example.org:444/events',
      'https://hooks.example.org/events#fragment',
      'https://user:pass@hooks.example.org/events',
      'https://192.168.1.1/events',
      'https://[::1]/events',
    ]) {
      expect(() => validateProviderCredential('webhook', target)).toThrow();
    }
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
    expect(toOutboundNotification({ ...notification, teamEventType: 'lead_inbox' })).toEqual({
      event: 'lead_inbox',
      message: 'Agent Teams: Team lead inbox message.',
    });
    expect(toOutboundNotification({ ...notification, teamEventType: 'api_error' })).toBeNull();
  });
});
