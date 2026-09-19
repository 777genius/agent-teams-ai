import {
  WORKSPACE_TRUST_GET_LAUNCH_STATUS,
  WORKSPACE_TRUST_GET_PROJECT_STATUS,
  type WorkspaceTrustElectronApi,
} from '../contracts';

interface WorkspaceTrustIpcRendererPort {
  invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T>;
}

export function createWorkspaceTrustBridge(
  ipcRenderer: WorkspaceTrustIpcRendererPort
): WorkspaceTrustElectronApi {
  return {
    workspaceTrust: {
      getLaunchStatus: (request) => ipcRenderer.invoke(WORKSPACE_TRUST_GET_LAUNCH_STATUS, request),
      getProjectStatus: (request) =>
        ipcRenderer.invoke(WORKSPACE_TRUST_GET_PROJECT_STATUS, request),
    },
  };
}
