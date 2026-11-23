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

  it('sends a Microsoft Teams Workflow adaptive card on 202 Accepted', async () => {
    const send = vi.fn(async (url: string, options: RequestInit) =>
      new Response('', { status: 202 })
    );
    vi.stubGlobal('fetch', send);
    const secret = 'https://sample.logic.azure.com/workflows/example/triggers/manual/paths/invoke?sig=private';
    const result = await new ThinwrapDeliverySender().send(
      makeChannel('ms-teams'), secret, 'Agent Teams: Review requested.'
    );
    expect(result).toEqual({ success: true });
    expect(send).toHaveBeenCalledOnce();
    const [, request] = send.mock.calls[0]!;
    expect(request.redirect).toBe('error');
    expect(String(request.body)).toContain('application/vnd.microsoft.card.adaptive');
    expect(String(request.body)).not.toContain('private');
  });

  it('sends a Google Chat webhook without changing its signed query', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ name: 'spaces/AAA/messages/BBB' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }));
    const secret = 'https://chat.googleapis.com/v1/spaces/AAA/messages?key=key123&token=token123';
    expect(await new ThinwrapDeliverySender().send(
      makeChannel('google-chat'), secret, 'Agent Teams: Task blocked.'
    )).toEqual({ success: true });
    expect(urls).toEqual([secret]);
  });

  it('reports Telegram 429 without exposing token or retry metadata', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: false, error_code: 429, description: 'Too Many Requests',
      parameters: { retry_after: 5 },
    }), { status: 429, headers: { 'content-type': 'application/json' } })));
    const result = await new ThinwrapDeliverySender().send(
      makeChannel('telegram'), TELEGRAM, 'Agent Teams: Message for you.'
    );
    expect(result).toEqual({ success: false, code: 'rate_limited' });
    expect(JSON.stringify(result)).not.toContain(TELEGRAM);
  });

  it('preserves Telegram blocked-recipient classification without leaking secrets', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ ok: false, error_code: 403, description: 'Forbidden: bot blocked by the user' }),
      { status: 403, headers: { 'content-type': 'application/json' } }
    )));
    expect(await new ThinwrapDeliverySender().send(
      makeChannel('telegram'), TELEGRAM, 'Agent Teams: Message for you.'
    )).toEqual({ success: false, code: 'invalid_recipient' });
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
      const remoteRead = await app.inject({
        method: 'GET', url, headers: { host: 'example.com:3456' },
      });
      expect(remoteRead.statusCode).toBe(403);
      expect(remoteRead.body).not.toContain('safe');

      const forgedOriginRead = await app.inject({
        method: 'GET', url,
        headers: { host: '127.0.0.1:3456', origin: 'https://evil.example' },
      });
      expect(forgedOriginRead.statusCode).toBe(403);
      expect(list).toHaveBeenCalledOnce();

      expect(response.body).not.toContain('do-not-echo');
    } finally {
      await app.close();
    }
  });
});
