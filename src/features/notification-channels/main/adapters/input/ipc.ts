import { NOTIFICATION_CHANNELS_IPC } from '../../../contracts';

import type { NotificationChannelsFeatureFacade } from '../../composition/createNotificationChannelsFeature';
import type { IpcMain } from 'electron';

export function registerNotificationChannelsIpc(
  ipc: Pick<IpcMain, 'handle'>,
  feature: NotificationChannelsFeatureFacade
): void {
  ipc.handle(NOTIFICATION_CHANNELS_IPC.list, () => feature.list());
  ipc.handle(NOTIFICATION_CHANNELS_IPC.save, (_event, request: unknown) =>
    feature.save(request as Parameters<typeof feature.save>[0])
  );
  ipc.handle(NOTIFICATION_CHANNELS_IPC.remove, (_event, id: string) => feature.remove(id));
  ipc.handle(NOTIFICATION_CHANNELS_IPC.test, (_event, id: string) => feature.test(id));
}

export function removeNotificationChannelsIpc(ipc: Pick<IpcMain, 'removeHandler'>): void {
  Object.values(NOTIFICATION_CHANNELS_IPC).forEach((channel) => ipc.removeHandler(channel));
}
