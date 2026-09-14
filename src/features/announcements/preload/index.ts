import {
  ANNOUNCEMENTS_CHANNELS as channels,
  type AnnouncementsApi,
  type AnnouncementsSnapshot,
} from '@features/announcements/contracts';
import { ipcRenderer } from 'electron';

export function createAnnouncementsBridge(): AnnouncementsApi {
  return {
    getSnapshot: () => ipcRenderer.invoke(channels.getSnapshot),
    refresh: () => ipcRenderer.invoke(channels.refresh),
    prepareAuto: () => ipcRenderer.invoke(channels.prepareAuto),
    claimAuto: (input) => ipcRenderer.invoke(channels.claimAuto, input),
    openManual: (id) => ipcRenderer.invoke(channels.openManual, id),
    loadCover: (id, requestId) => ipcRenderer.invoke(channels.loadCover, id, requestId),
    cancelCover: (requestId) => ipcRenderer.invoke(channels.cancelCover, requestId),
    loadAsset: (url, requestId) => ipcRenderer.invoke(channels.loadAsset, url, requestId),
    cancelAsset: (requestId) => ipcRenderer.invoke(channels.cancelAsset, requestId),
    dismiss: (id) => ipcRenderer.invoke(channels.dismiss, id),
    onStateChanged: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, snapshot: AnnouncementsSnapshot): void =>
        listener(snapshot);
      ipcRenderer.on(channels.stateChanged, handler);
      return () => {
        ipcRenderer.removeListener(channels.stateChanged, handler);
      };
    },
  };
}
