import { WORKSPACE_TRUST_GET_PROJECT_STATUS, type WorkspaceTrustElectronApi } from '../contracts';

import type { IpcRenderer } from 'electron';

export function createWorkspaceTrustBridge(ipcRenderer: IpcRenderer): WorkspaceTrustElectronApi {
  return {
    workspaceTrust: {
      getProjectStatus: (request) =>
        ipcRenderer.invoke(WORKSPACE_TRUST_GET_PROJECT_STATUS, request),
    },
  };
}
