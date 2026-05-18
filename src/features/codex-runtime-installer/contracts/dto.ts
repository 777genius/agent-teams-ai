export type CodexRuntimeSource = 'app-managed' | 'path' | 'missing';

export type CodexRuntimeInstallerState =
  | 'idle'
  | 'checking'
  | 'downloading'
  | 'installing'
  | 'ready'
  | 'failed';

export interface CodexRuntimeInstallProgress {
  phase: CodexRuntimeInstallerState;
  downloadedBytes?: number;
  totalBytes?: number;
  percent?: number;
  detail?: string | null;
}

export interface CodexRuntimeStatus {
  installed: boolean;
  binaryPath?: string;
  version?: string;
  source: CodexRuntimeSource;
  state: CodexRuntimeInstallerState;
  progress?: CodexRuntimeInstallProgress;
  error?: string;
}
