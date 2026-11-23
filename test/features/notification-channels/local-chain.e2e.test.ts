import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NotificationChannelsService } from '@features/notification-channels/core/application/NotificationChannelsService';
import { registerNotificationChannelsHttp } from '@features/notification-channels/main/adapters/input/http';
import { ThinwrapDeliverySender } from '@features/notification-channels/main/adapters/output/ThinwrapDeliverySender';
import { JsonDeliveryChannelRepository } from '@features/notification-channels/main/infrastructure/JsonDeliveryChannelRepository';

import type { DetectedError } from '@shared/types/notifications';

const TOKEN = '123456789:abcdefghijklmnopqrstuvwxyz_0123456789';
const HOST = '127.0.0.1:3456';
const HEADERS = { host: HOST, origin: 'http://' + HOST };
const ENDPOINT = '/api/notification-channels';

afterEach(() => vi.unstubAllGlobals());

describe('Notification Channels local end-to-end contract', () => {
  it('browser API → settings file/secret port → stored event → OSS vendor POST → test/remove', async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'notification-channels-e2e-'));
    const settingsPath = path.join(temp, 'channels.json');
    const vault = new Map<string, string>();
    const outbound: { url: string; body: string }[] = [];
    let credentialIndex = 0;
    const app = Fastify();
    const service = new NotificationChannelsService({
      repository: new JsonDeliveryChannelRepository(settingsPath),
      credentials: {
        create: async (_name, value) => {
          const id = 'key-' + ++credentialIndex;
          vault.set(id, value);
          return id;
        },
        read: async (id) => vault.get(id) ?? null,
        remove: async (id) => { vault.delete(id); },
      },
      sender: new ThinwrapDeliverySender(),
      newId: () => 'dadfb85b-78cf-41ce-bca7-1c8cf65c2b67',
      now: () => '2026-11-23T16:00:00.000Z',
    });
    vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => {
      outbound.push({ url: String(url), body: String(options.body ?? '') });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 991 } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }));

    registerNotificationChannelsHttp(app, service);
    try {
      const created = await app.inject({
        method: 'POST', url: ENDPOINT, headers: HEADERS,
        payload: {
          name: 'Team alerts',
          provider: 'telegram',
          enabled: true,
          events: ['user_inbox'],
          chatId: '123456',
          secret: TOKEN,
        },
      });
      expect(created.statusCode).toBe(200);
      expect(created.body).not.toContain(TOKEN);
      const id: string = created.json().id;
      expect(vault.size).toBe(1);
      expect((await fs.readFile(settingsPath, 'utf8'))).not.toContain(TOKEN);

      const list = await app.inject({ method: 'GET', url: ENDPOINT });
      expect(list.json()).toMatchObject([{
        id, provider: 'telegram', enabled: true, hasCredential: true,
      }]);
      expect(list.body).not.toContain(TOKEN);

      await service.dispatch({
        category: 'team',
        teamEventType: 'user_inbox',
        isRead: false,
        message: 'private prompt & secret API key',
        context: { projectName: 'secret team' },
      } as DetectedError);
      expect(outbound).toHaveLength(1);
      expect(outbound[0].url).toContain('/sendMessage');
      expect(outbound[0].body).toContain('Agent Teams: Message for you.');
      expect(outbound[0].body).not.toContain('private prompt');
      expect(outbound[0].body).not.toContain('secret team');

      const tested = await app.inject({
        method: 'POST', url: ENDPOINT + '/' + id + '/test', headers: HEADERS,
      });
      expect(tested.json()).toEqual({
        at: '2026-11-23T16:00:00.000Z', success: true,
      });
      expect(outbound).toHaveLength(2);

      const deleted = await app.inject({
        method: 'DELETE', url: ENDPOINT + '/' + id, headers: HEADERS,
      });
      expect(deleted.statusCode).toBe(200);
      expect(vault.size).toBe(0);
      expect((await app.inject({ method: 'GET', url: ENDPOINT })).json()).toEqual([]);
    } finally {
      await app.close();
      await fs.rm(temp, { force: true, recursive: true });
    }
  });
});
