import { describe, expect, it, vi } from 'vitest';

import { createNotificationHistoryBridge } from '@preload/notificationHistoryBridge';

import type { IpcRenderer, IpcRendererEvent } from 'electron';

describe('Notification history preload compatibility bridge', () => {
  it('preserves IPC method names and event subscription cleanup', async () => {
    const listeners = new Map<string, (event: IpcRendererEvent, payload: unknown) => void>();
    const invoke = vi.fn(async (..._args: unknown[]) => ({ success: true }));
    const ipc = {
      invoke,
      on: vi.fn((channel: string, callback: (event: IpcRendererEvent, payload: unknown) => void) => {
        listeners.set(channel, callback);
      }),
      removeListener: vi.fn((channel: string) => {
        listeners.delete(channel);
      }),
    } as unknown as Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener'>;
    const { notifications } = createNotificationHistoryBridge(ipc);

    await notifications.get({ limit: 7, offset: 5 });
    expect(invoke).toHaveBeenCalledWith('notifications:get', { limit: 7, offset: 5 });
    await notifications.markRead('n1');
    expect(invoke).toHaveBeenCalledWith('notifications:markRead', 'n1');
    await notifications.testNotification();
    expect(invoke).toHaveBeenCalledWith('notifications:testNotification');

    const onNew = vi.fn();
    const onUpdated = vi.fn();
    const onClicked = vi.fn();
    const unsubNew = notifications.onNew(onNew);
    const unsubUpdated = notifications.onUpdated(onUpdated);
    const unsubClicked = notifications.onClicked(onClicked);

    const event = {} as IpcRendererEvent;
    listeners.get('notification:new')?.(event, { id: 'n1' });
    listeners.get('notification:updated')?.(event, { total: 2, unreadCount: 1 });
    listeners.get('notification:clicked')?.(event, { id: 'n1' });
    expect(onNew).toHaveBeenCalledWith(event, { id: 'n1' });
    expect(onUpdated).toHaveBeenCalledWith(event, { total: 2, unreadCount: 1 });
    expect(onClicked).toHaveBeenCalledWith(event, { id: 'n1' });

    unsubNew();
    unsubUpdated();
    unsubClicked();
    expect(listeners.size).toBe(0);
    expect(ipc.removeListener).toHaveBeenCalledTimes(3);
  });
});
