import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerNotificationChannelsHttp } from '@features/notification-channels/main/adapters/input/http';
import { ThinwrapDeliverySender } from '@features/notification-channels/main/adapters/output/ThinwrapDeliverySender';

import type { StoredDeliveryChannel } from '@features/notification-channels/core/application/NotificationChannelsService';
import type { NotificationChannelsFeatureFacade } from '@features/notification-channels/main';

const TELEGRAM = '123456789:abcdefghijklmnopqrstuvwxyz_0123456789';

function makeChannel(provider: StoredDeliveryChannel['provider']): StoredDeliveryChannel {
  return {
    id: 'ab84b487-0c13-4bd8-9b4a-57c9947efcd0',
    credentialId: 'key-1',
    provider,
    name: 'test channel',
    enabled: true,
    events: ['user_inbox'],
    chatId: '123456',
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('Thinwrap transport adapter', () => {
  it('sends a Telegram message through the library with bounded HTTPS fetch', async () => {
    const calls: { url: string; options: RequestInit }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => {
      calls.push({ url: String(url), options });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 123 } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }));
    const result = await new ThinwrapDeliverySender().send(
      makeChannel('telegram'), TELEGRAM, 'Agent Teams: Message for you.'
    );
    expect(result).toEqual({ success: true });
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0].url).hostname).toBe('api.telegram.org');
    expect(calls[0].options.redirect).toBe('error');
    expect(calls[0].options.signal).toBeDefined();
  });

  it('sends Discord and Slack with their own webhook response contracts', async () => {
    const sender = new ThinwrapDeliverySender();
    const url = 'https://discord.com/api/webhooks/123/abcdefghijklmnopqrstuvwxyz';
    const discordFetch = vi.fn(async () => new Response(
      JSON.stringify({ id: '456' }), { status: 200, headers: { 'content-type': 'application/json' } }
    ));
    vi.stubGlobal('fetch', discordFetch);
    expect(await sender.send(makeChannel('discord'), url, 'Agent Teams: Task blocked.'))
      .toEqual({ success: true });
    expect(discordFetch).toHaveBeenCalledOnce();

    vi.stubGlobal('fetch', vi.fn(async () => new Response('ok', { status: 200 })));
    expect(await sender.send(makeChannel('slack'),
      'https://hooks.slack.com/services/T123/B123/abcdefgh',
      'Agent Teams: Task blocked.')).toEqual({ success: true });
  });

  it('refuses local/webhook impostors without making a request', async () => {
    const network = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', network);
    const result = await new ThinwrapDeliverySender().send(makeChannel('slack'),
      'https://localhost/services/a/b/c', 'hello');
    expect(result.success).toBe(false);
    expect(network).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('localhost');
  });
});

describe('Notification Channels HTTP boundary', () => {
  it('only allows local same-origin writes; read responses contain no credentials', async () => {
    const save = vi.fn(async () => ({ id: 'safe', hasCredential: true }));
    const list = vi.fn(async () => [{ id: 'safe', hasCredential: true }]);
    const app = Fastify();
    registerNotificationChannelsHttp(app, {
      save, list, remove: vi.fn(), test: vi.fn(), dispatch: vi.fn(),
    } as unknown as NotificationChannelsFeatureFacade);
    try {
      const url = '/api/notification-channels';
      const bad = await app.inject({
        method: 'POST', url, headers: {
          host: '127.0.0.1:3456', origin: 'https://evil.example',
        },
        payload: { secret: 'do-not-echo' },
      });
      expect(bad.statusCode).toBe(403);
      expect(save).not.toHaveBeenCalled();

      const good = await app.inject({
        method: 'POST', url, headers: {
          host: '127.0.0.1:3456', origin: 'http://127.0.0.1:3456',
        },
        payload: { provider: 'telegram' },
      });
      expect(good.statusCode).toBe(200);
      expect(save).toHaveBeenCalledOnce();
      const response = await app.inject({ method: 'GET', url });
      expect(response.json()).toEqual([{ id: 'safe', hasCredential: true }]);
      expect(response.body).not.toContain('do-not-echo');
    } finally {
      await app.close();
    }
  });
});
