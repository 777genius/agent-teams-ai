import {
  WORKSPACE_TRUST_GET_LAUNCH_STATUS,
  WORKSPACE_TRUST_GET_PROJECT_STATUS,
  type WorkspaceTrustElectronApi,
} from '../contracts';

import type { IpcRenderer } from 'electron';

export function createWorkspaceTrustBridge(ipcRenderer: IpcRenderer): WorkspaceTrustElectronApi {
  return {
    workspaceTrust: {
      getLaunchStatus: (request) => ipcRenderer.invoke(WORKSPACE_TRUST_GET_LAUNCH_STATUS, request),
      getProjectStatus: (request) =>
        ipcRenderer.invoke(WORKSPACE_TRUST_GET_PROJECT_STATUS, request),
    },
  };
}
