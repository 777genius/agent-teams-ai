import {
  PROJECT_FOLDER_CREATE,
  PROJECT_FOLDER_GET_STATE,
  type ProjectFolderElectronApi,
} from '../contracts';

import type { IpcRenderer } from 'electron';

export function createProjectFolderBridge(ipcRenderer: IpcRenderer): ProjectFolderElectronApi {
  return {
    projectFolder: {
      getState: (request) => ipcRenderer.invoke(PROJECT_FOLDER_GET_STATE, request),
      create: (request) => ipcRenderer.invoke(PROJECT_FOLDER_CREATE, request),
    },
  };
}
