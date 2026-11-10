import { contextBridge, ipcRenderer } from 'electron';
import { installSentryRendererIpcBridge } from '../../../src/preload/installSentryRendererIpcBridge.js';
import type { FixtureBridge } from './contract.js';
installSentryRendererIpcBridge();
const bridge: FixtureBridge = {
  failure: (message) => ipcRenderer.send('fixture.failure', message),
  snapshot: (stage, event) => ipcRenderer.send('fixture.snapshot', { stage, event }),
};
contextBridge.exposeInMainWorld('fixtureCapture', bridge);
