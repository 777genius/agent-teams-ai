import {
  TERMINAL_WORKSPACE_GET_BOOTSTRAP,
  TERMINAL_WORKSPACE_STOP_TEAM,
  type TerminalWorkspaceBootstrap,
  type TerminalWorkspaceBootstrapRequest,
  type TerminalWorkspaceElectronApi,
} from '../contracts';

import type { IpcRenderer } from 'electron';

export function createTerminalWorkspaceBridge(
  ipcRenderer: IpcRenderer
): TerminalWorkspaceElectronApi {
  return {
    getBootstrap: (request: TerminalWorkspaceBootstrapRequest) =>
      ipcRenderer.invoke(
        TERMINAL_WORKSPACE_GET_BOOTSTRAP,
        request
      ) as Promise<TerminalWorkspaceBootstrap>,
    stopTeamRuntime: (teamName: string) =>
      ipcRenderer.invoke(TERMINAL_WORKSPACE_STOP_TEAM, teamName) as Promise<void>,
  };
}
