/**
 * SSH API types — shared between main, preload, and renderer processes.
 *
 * Covers the remote-context connection surface: config-host discovery,
 * connection state and the preload-exposed `SshAPI`.
 */

/**
 * SSH connection state.
 */
export type SshConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

/**
 * SSH authentication method.
 */
export type SshAuthMethod = 'password' | 'privateKey' | 'agent' | 'auto';

/**
 * SSH config host entry resolved from ~/.ssh/config.
 */
export interface SshConfigHostEntry {
  alias: string;
  hostName?: string;
  user?: string;
  port?: number;
  hasIdentityFile: boolean;
}

/**
 * SSH connection configuration sent from renderer.
 */
export interface SshConnectionConfig {
  host: string;
  port: number;
  username: string;
  authMethod: SshAuthMethod;
  password?: string;
  privateKeyPath?: string;
}

/**
 * Saved SSH connection profile (no password stored).
 */
export interface SshConnectionProfile {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authMethod: SshAuthMethod;
  privateKeyPath?: string;
}

/**
 * SSH connection status returned from main process.
 */
export interface SshConnectionStatus {
  state: SshConnectionState;
  host: string | null;
  error: string | null;
  remoteProjectsPath: string | null;
}

/**
 * SSH API exposed via preload.
 */
/**
 * Saved SSH connection config (no password).
 */
export interface SshLastConnection {
  host: string;
  port: number;
  username: string;
  authMethod: SshAuthMethod;
  privateKeyPath?: string;
}

export interface SshAPI {
  connect: (config: SshConnectionConfig) => Promise<SshConnectionStatus>;
  disconnect: () => Promise<SshConnectionStatus>;
  getState: () => Promise<SshConnectionStatus>;
  test: (config: SshConnectionConfig) => Promise<{ success: boolean; error?: string }>;
  getConfigHosts: () => Promise<SshConfigHostEntry[]>;
  resolveHost: (alias: string) => Promise<SshConfigHostEntry | null>;
  saveLastConnection: (config: SshLastConnection) => Promise<void>;
  getLastConnection: () => Promise<SshLastConnection | null>;
  onStatus: (callback: (event: unknown, status: SshConnectionStatus) => void) => () => void;
}
