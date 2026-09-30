import { createMemberLogStreamBridge } from '@features/member-log-stream/preload';

import type { IpcRenderer } from 'electron';

export function createElectronMemberLogStreamBridge(ipcRenderer: IpcRenderer) {
  return createMemberLogStreamBridge({
    invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  });
}
