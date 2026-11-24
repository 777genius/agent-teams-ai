import type { NotificationsAPI } from '@shared/types/api';
import type { IpcRenderer, IpcRendererEvent } from 'electron';

type IpcPort = Pick<IpcRenderer, 'invoke' | 'on' | 'removeListener'>;

/** Compatibility bridge for the existing notification-history API. */
export function createNotificationHistoryBridge(ipc: IpcPort): {
  notifications: NotificationsAPI;
} {
  function subscribe<T>(
    channel: string,
    callback: (event: unknown, payload: T) => void
  ): () => void {
    const listener = (event: IpcRendererEvent, payload: T): void => callback(event, payload);
    ipc.on(channel, listener);
    return () => ipc.removeListener(channel, listener);
  }

  return {
    notifications: {
      get: (options) => ipc.invoke('notifications:get', options),
      markRead: (id) => ipc.invoke('notifications:markRead', id),
      markAllRead: () => ipc.invoke('notifications:markAllRead'),
      setViewedTeam: (teamName) => ipc.invoke('notifications:setViewedTeam', teamName),
      delete: (id) => ipc.invoke('notifications:delete', id),
      clear: () => ipc.invoke('notifications:clear'),
      getUnreadCount: () => ipc.invoke('notifications:getUnreadCount'),
      testNotification: () => ipc.invoke('notifications:testNotification'),
      onNew: (callback) => subscribe('notification:new', callback),
      onUpdated: (callback) => subscribe('notification:updated', callback),
      onClicked: (callback) => subscribe('notification:clicked', callback),
    },
  };
}
