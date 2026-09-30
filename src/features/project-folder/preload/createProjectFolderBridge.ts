import {
  PROJECT_FOLDER_CREATE,
  PROJECT_FOLDER_GET_STATE,
  type ProjectFolderCreateResult,
  type ProjectFolderElectronApi,
  type ProjectFolderRequest,
  type ProjectFolderStateResult,
} from '../contracts';

interface ProjectFolderIpcInvoker {
  invoke(channel: string, request: ProjectFolderRequest): Promise<unknown>;
}

export function createProjectFolderBridge(
  ipcRenderer: ProjectFolderIpcInvoker
): ProjectFolderElectronApi {
  return {
    projectFolder: {
      getState: async (request) =>
        (await ipcRenderer.invoke(PROJECT_FOLDER_GET_STATE, request)) as ProjectFolderStateResult,
      create: async (request) =>
        (await ipcRenderer.invoke(PROJECT_FOLDER_CREATE, request)) as ProjectFolderCreateResult,
    },
  };
}
