import { createAnnouncementsBridge } from '@features/announcements/preload';

import type { AnnouncementsSnapshot } from '@features/announcements/contracts';
import type { IpcRenderer, IpcRendererEvent } from 'electron';

export function createElectronAnnouncementsBridge(ipcRenderer: IpcRenderer) {
  return createAnnouncementsBridge({
    invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
    subscribe: (channel, listener) => {
      const wrapper = (_event: IpcRendererEvent, snapshot: AnnouncementsSnapshot): void => {
        listener(snapshot);
      };
      ipcRenderer.on(channel, wrapper);
      return () => ipcRenderer.removeListener(channel, wrapper);
    },
  });
}
