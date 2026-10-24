import path from 'node:path';

import { setSkillsMutationAdmission } from '@main/ipc/skills';
import { app, ipcMain } from 'electron';

import { registerExtensionManagementIpc } from '../adapters/input/registerExtensionManagementIpc';

import { createAppExtensionManagement } from './createAppExtensionManagement';

import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';

type Dependencies = Omit<Parameters<typeof createAppExtensionManagement>[0], 'resourceRoot'> & {
  getMainWindow(): BrowserWindow | null;
};

export function createElectronExtensionManagement(deps: Dependencies) {
  const runtime = createAppExtensionManagement({
    ...deps,
    resourceRoot: path.join(
      app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'resources'),
      'uap'
    ),
  });
  const admits = (event: IpcMainInvokeEvent) => {
    const window = deps.getMainWindow();
    return Boolean(
      window &&
      event.sender === window.webContents &&
      event.senderFrame === window.webContents.mainFrame
    );
  };
  const unregister = registerExtensionManagementIpc(ipcMain, runtime.feature, admits);
  const releaseSkills = setSkillsMutationAdmission(admits);
  const close = runtime.feature.close;
  runtime.feature.close = async () => {
    unregister();
    releaseSkills();
    await close();
  };
  return runtime;
}
