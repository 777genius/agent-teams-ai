export interface TerminalWorkspaceBootstrapRequest {
  teamName: string;
  teamDisplayName?: string | null;
  projectPath?: string | null;
}

export interface TerminalWorkspaceBootstrap {
  teamName: string;
  runtimeSlug: string;
  controlPlaneUrl: string;
  sessionStreamUrl: string;
  projectPath: string | null;
  defaultShell: string;
}

export interface TerminalWorkspaceElectronApi {
  getBootstrap(request: TerminalWorkspaceBootstrapRequest): Promise<TerminalWorkspaceBootstrap>;
  stopTeamRuntime(teamName: string): Promise<void>;
}
