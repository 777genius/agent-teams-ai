/** Browser-safe existing Extension UI installed-state records. */
export type PluginInstallScope = 'user' | 'project' | 'local';
export interface InstalledPluginEntry {
  pluginId: string;
  scope: PluginInstallScope;
  version?: string;
  installedAt?: string;
  installPath?: string;
}
export interface InstalledMcpEntry {
  name: string;
  scope: 'local' | 'user' | 'project' | 'global';
  transport?: string;
  targetKey?: string;
}

export type McpServerHealthStatus = 'connected' | 'needs-authentication' | 'failed' | 'unknown';
export interface McpServerDiagnostic {
  name: string;
  target: string;
  scope?: 'local' | 'user' | 'project' | 'global' | 'dynamic' | 'managed';
  transport?: string;
  status: McpServerHealthStatus;
  statusLabel: string;
  rawLine: string;
  checkedAt: number;
}
