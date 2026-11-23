import { NOTIFICATION_CHANNELS_IPC } from '../contracts';

import type { NotificationChannelsApi } from '../contracts';
import type { IpcRenderer } from 'electron';

export function createNotificationChannelsBridge(
  ipc: Pick<IpcRenderer, 'invoke'>
): { notificationChannels: NotificationChannelsApi } {
  return {
    notificationChannels: {
      list: () => ipc.invoke(NOTIFICATION_CHANNELS_IPC.list),
      save: (request) => ipc.invoke(NOTIFICATION_CHANNELS_IPC.save, request),
      remove: (id) => ipc.invoke(NOTIFICATION_CHANNELS_IPC.remove, id),
      test: (id) => ipc.invoke(NOTIFICATION_CHANNELS_IPC.test, id),
    },
  };
}
