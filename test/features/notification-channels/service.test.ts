import { beforeEach, describe, expect, it, vi } from 'vitest';

import { NotificationChannelsService } from '@features/notification-channels/core/application/NotificationChannelsService';

import type {
  DeliveryCredentials,
  StoredDeliveryChannel,
} from '@features/notification-channels/core/application/NotificationChannelsService';
import type { DetectedError } from '@shared/types/notifications';

const TOKEN = '123456789:abcdefghijklmnopqrstuvwxyz_0123456789';
const event = {
  category: 'team',
  teamEventType: 'user_inbox',
  isRead: false,
  message: 'sensitive-agent-message',
} as DetectedError;

describe('Notification Channels application', () => {
  let records: StoredDeliveryChannel[];
  let secrets: Map<string, string>;
  let sent: ReturnType<typeof vi.fn>;
  let service: NotificationChannelsService;
  let canDeliver: boolean;

  beforeEach(() => {
    records = [];
    secrets = new Map();
    sent = vi.fn(async () => ({ success: true }));
    canDeliver = true;
    let index = 0;
    const credentials: DeliveryCredentials = {
      create: async (_name, value) => {
        const id = 'secret-' + ++index;
        secrets.set(id, value);
        return id;
      },
      read: async (id) => secrets.get(id) ?? null,
      remove: async (id) => { secrets.delete(id); },
    };
    service = new NotificationChannelsService({
      repository: {
        read: async () => records.map((record) => ({ ...record, events: [...record.events] })),
        write: async (items) => { records = items.map((record) => ({ ...record })); },
      },
      credentials,
      sender: { send: sent },
      newId: () => 'f97bfa8d-5f66-4cd1-a789-12bda1097e28',
      now: () => '2026-11-23T12:00:00.000Z',
      canDeliver: () => canDeliver,
    });
  });

  async function add(enabled = false): Promise<string> {
    return (await service.save({
      name: 'My Telegram', provider: 'telegram', enabled,
      events: ['user_inbox'], chatId: '123456', secret: TOKEN,
    })).id;
  }

  it('stores secret only in credential port and returns redacted DTO', async () => {
    const id = await add();
    expect(records[0].credentialId).toBe('secret-1');
    expect(JSON.stringify(records)).not.toContain(TOKEN);
    expect(JSON.stringify(await service.list())).not.toContain(TOKEN);
    expect((await service.list())[0].enabled).toBe(false);
    expect(id).toBeTruthy();
  });

  it('honors the global disable/snooze policy, without suppressing manual test', async () => {
    const id = await add(true);
    canDeliver = false;
    await service.dispatch(event);
    expect(sent).not.toHaveBeenCalled();
    expect((await service.test(id)).success).toBe(true);
    expect(sent).toHaveBeenCalledOnce();
  });

  it('does not send unless explicitly enabled and selected', async () => {
    const id = await add();
    await service.dispatch(event);
    expect(sent).not.toHaveBeenCalled();
    await service.save({
      id, name: 'My Telegram', provider: 'telegram', enabled: true,
      events: ['task_blocked'], chatId: '123456',
    });
    await service.dispatch(event);
    expect(sent).not.toHaveBeenCalled();
    await service.save({
      id, name: 'My Telegram', provider: 'telegram', enabled: true,
      events: ['user_inbox'], chatId: '123456',
    });
    await service.dispatch(event);
    expect(sent).toHaveBeenCalledTimes(1);
    expect(sent.mock.calls[0]?.[2]).not.toContain('sensitive');
  });

  it('tests disabled channels, records health, and cleans up on delete', async () => {
    const id = await add();
    expect((await service.test(id)).success).toBe(true);
    expect((await service.list())[0].lastTest?.success).toBe(true);
    await service.remove(id);
    expect(await service.list()).toEqual([]);
    expect(secrets.size).toBe(0);
  });

  it('invalidates a previous successful test when Telegram chat ID changes', async () => {
    const id = await add();
    await service.test(id);
    expect((await service.list())[0].lastTest?.success).toBe(true);
    await service.save({
      id, name: 'My Telegram', provider: 'telegram', enabled: true,
      events: ['user_inbox'], chatId: '654321',
    });
    expect((await service.list())[0].lastTest).toBeUndefined();
  });

  it('rejects provider change without new credential', async () => {
    const id = await add();
    await expect(service.save({
      id, name: 'changed', provider: 'discord', enabled: true,
      events: ['user_inbox'],
    })).rejects.toThrow();
    expect(records[0].provider).toBe('telegram');
  });

  it('does not expose vendor secrets or throw on failed sends', async () => {
    const id = await add(true);
    sent.mockRejectedValue(new Error('token=' + TOKEN));
    const test = await service.test(id);
    expect(test).toEqual({
      at: '2026-11-23T12:00:00.000Z',
      success: false,
      code: 'delivery_failed',
    });
    expect(JSON.stringify(test)).not.toContain(TOKEN);
    await expect(service.dispatch(event)).resolves.toBeUndefined();
  });
});
