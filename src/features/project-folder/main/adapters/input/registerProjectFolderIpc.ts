import { PROJECT_FOLDER_CREATE, PROJECT_FOLDER_GET_STATE } from '../../../contracts';

import type { ProjectFolderFeatureFacade } from '../../composition/createProjectFolderFeature';
import type { IpcMain } from 'electron';

export function registerProjectFolderIpc(
  ipcMain: IpcMain,
  feature: ProjectFolderFeatureFacade
): void {
  ipcMain.handle(PROJECT_FOLDER_GET_STATE, async (_event, input: unknown) => {
    try {
      return await feature.getState(input);
    } catch {
      return { state: 'unknown' };
    }
  });
  ipcMain.handle(PROJECT_FOLDER_CREATE, async (_event, input: unknown) => {
    try {
      return await feature.create(input);
    } catch {
      return { state: 'unknown', error: 'failed' };
    }
  });
}

export function removeProjectFolderIpc(ipcMain: IpcMain): void {
  ipcMain.removeHandler(PROJECT_FOLDER_GET_STATE);
  ipcMain.removeHandler(PROJECT_FOLDER_CREATE);
}
