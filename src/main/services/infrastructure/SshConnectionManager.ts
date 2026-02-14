/**
 * SshConnectionManager - Manages SSH connection lifecycle.
 *
 * Responsibilities:
 * - Connect/disconnect SSH sessions
 * - Manage SFTP channel
 * - Provide FileSystemProvider (local or SSH) to services
 * - Emit connection state events for UI updates
 * - Handle reconnection on errors
 */

import { createLogger } from '@shared/utils/logger';
import { execFile } from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client, type ConnectConfig, type SFTPWrapper } from 'ssh2';

import { LocalFileSystemProvider } from './LocalFileSystemProvider';
import { SshConfigParser } from './SshConfigParser';
import { SshFileSystemProvider } from './SshFileSystemProvider';

import type { FileSystemProvider } from './FileSystemProvider';
import type { SshConfigHostEntry } from '@shared/types';

const logger = createLogger('Infrastructure:SshConnectionManager');

// =============================================================================
// Types
// =============================================================================

export type SshConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

export type SshAuthMethod = 'password' | 'privateKey' | 'agent' | 'auto';

export interface SshConnectionConfig {
  host: string;
  port: number;
  username: string;
  authMethod: SshAuthMethod;
  password?: string;
  privateKeyPath?: string;
}

export interface SshConnectionStatus {
  state: SshConnectionState;
  host: string | null;
  error: string | null;
  remoteProjectsPath: string | null;
}

// =============================================================================
// Connection Manager
// =============================================================================

export class SshConnectionManager extends EventEmitter {
  private client: Client | null = null;
  private provider: FileSystemProvider;
  private localProvider: LocalFileSystemProvider;
  private configParser: SshConfigParser;
  private state: SshConnectionState = 'disconnected';
  private connectedHost: string | null = null;
  private lastError: string | null = null;
  private remoteProjectsPath: string | null = null;

  constructor() {
    super();
    this.localProvider = new LocalFileSystemProvider();
    this.provider = this.localProvider;
    this.configParser = new SshConfigParser();
  }

  /**
   * Returns the current FileSystemProvider (local or SSH).
   */
  getProvider(): FileSystemProvider {
    return this.provider;
  }

  /**
   * Returns the current connection status.
   */
  getStatus(): SshConnectionStatus {
    return {
      state: this.state,
      host: this.connectedHost,
      error: this.lastError,
      remoteProjectsPath: this.remoteProjectsPath,
    };
  }

  /**
   * Returns the remote projects directory path.
   * Used by services to know where to scan on the remote machine.
   */
  getRemoteProjectsPath(): string | null {
    return this.remoteProjectsPath;
  }

  /**
   * Returns whether we're in SSH mode.
   */
  isRemote(): boolean {
    return this.state === 'connected' && this.provider.type === 'ssh';
  }

  /**
   * Returns all SSH config host entries from ~/.ssh/config.
   */
  async getConfigHosts(): Promise<SshConfigHostEntry[]> {
    return this.configParser.getHosts();
  }

  /**
   * Resolves a host alias from ~/.ssh/config.
   */
  async resolveHostConfig(alias: string): Promise<SshConfigHostEntry | null> {
    return this.configParser.resolveHost(alias);
  }

  /**
   * Connect to a remote SSH host.
   */
  async connect(config: SshConnectionConfig): Promise<void> {
    // Disconnect existing connection first
    if (this.client) {
      this.disconnect();
    }

    this.setState('connecting');
    this.connectedHost = config.host;

    try {
      const client = new Client();
      this.client = client;

      const connectConfig = await this.buildConnectConfig(config);

      await new Promise<void>((resolve, reject) => {
        client.on('ready', () => resolve());
        client.on('error', (err) => reject(err));
        client.connect(connectConfig);
      });

      // Open SFTP channel
      const sftpChannel = await new Promise<SFTPWrapper>((resolve, reject) => {
        client.sftp((err, channel) => {
          if (err) {
            reject(err);
            return;
          }
          resolve(channel);
        });
      });

      // Create SSH provider
      this.provider = new SshFileSystemProvider(sftpChannel);

      // Resolve remote ~/.claude/projects/ path
      this.remoteProjectsPath = await this.resolveRemoteProjectsPath(config.username);

      // Set up disconnect handler
      client.on('end', () => {
        logger.info('SSH connection ended');
        this.handleDisconnect();
      });

      client.on('close', () => {
        logger.info('SSH connection closed');
        this.handleDisconnect();
      });

      client.on('error', (err) => {
        logger.error('SSH connection error:', err);
        this.lastError = err.message;
        this.setState('error');
      });

      this.setState('connected');
      logger.info(`SSH connected to ${config.host}:${config.port}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`SSH connection failed: ${message}`);
      this.lastError = message;
      this.setState('error');
      this.cleanup();
      throw err;
    }
  }

  /**
   * Test a connection without switching to SSH mode.
   */
  async testConnection(config: SshConnectionConfig): Promise<{ success: boolean; error?: string }> {
    const testClient = new Client();

    try {
      const connectConfig = await this.buildConnectConfig(config);

      await new Promise<void>((resolve, reject) => {
        testClient.on('ready', () => resolve());
        testClient.on('error', (err) => reject(err));
        testClient.connect(connectConfig);
      });

      // Try to open SFTP to verify full access
      await new Promise<void>((resolve, reject) => {
        testClient.sftp((err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      });

      testClient.end();
      return { success: true };
    } catch (err) {
      testClient.end();
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  }

  /**
   * Disconnect and switch back to local mode.
   */
  disconnect(): void {
    this.cleanup();
    this.provider = this.localProvider;
    this.connectedHost = null;
    this.lastError = null;
    this.remoteProjectsPath = null;
    this.setState('disconnected');
    logger.info('Switched to local mode');
  }

  /**
   * Dispose of all resources.
   */
  dispose(): void {
    this.cleanup();
    this.localProvider.dispose();
    this.removeAllListeners();
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  private async buildConnectConfig(config: SshConnectionConfig): Promise<ConnectConfig> {
    // Resolve SSH config for the given host (alias or hostname)
    const sshConfig = await this.configParser.resolveHost(config.host);

    const connectConfig: ConnectConfig = {
      host: sshConfig?.hostName ?? config.host,
      port: config.port !== 22 ? config.port : (sshConfig?.port ?? config.port),
      username: config.username || sshConfig?.user || os.userInfo().username,
      readyTimeout: 10000,
    };

    switch (config.authMethod) {
      case 'password':
        connectConfig.password = config.password;
        break;

      case 'privateKey': {
        const keyPath = config.privateKeyPath ?? path.join(os.homedir(), '.ssh', 'id_rsa');
        try {
          const keyData = await fs.promises.readFile(keyPath, 'utf8');
          connectConfig.privateKey = keyData;
        } catch (err) {
          throw new Error(`Cannot read private key at ${keyPath}: ${(err as Error).message}`);
        }
        break;
      }

      case 'agent': {
        const agentSocket = await this.discoverAgentSocket();
        if (!agentSocket) {
          throw new Error(
            'SSH agent socket not found. Ensure ssh-agent is running or SSH_AUTH_SOCK is set.'
          );
        }
        connectConfig.agent = agentSocket;
        break;
      }

      case 'auto': {
        // Auto: try identity file from config -> agent -> default keys
        const resolved = await this.resolveAutoAuth(sshConfig);
        if (resolved.privateKey) {
          connectConfig.privateKey = resolved.privateKey;
        } else if (resolved.agent) {
          connectConfig.agent = resolved.agent;
        }
        break;
      }
    }

    return connectConfig;
  }

  /**
   * Discovers the SSH agent socket path.
   * Handles macOS GUI apps not inheriting SSH_AUTH_SOCK from shell.
   */
  private async discoverAgentSocket(): Promise<string | null> {
    // 1. Check SSH_AUTH_SOCK env var
    if (process.env.SSH_AUTH_SOCK) {
      try {
        await fs.promises.access(process.env.SSH_AUTH_SOCK);
        return process.env.SSH_AUTH_SOCK;
      } catch {
        // Socket path set but not accessible
      }
    }

    // 2. macOS: ask launchctl for the socket (GUI apps don't inherit shell env)
    if (process.platform === 'darwin') {
      try {
        const sock = await new Promise<string | null>((resolve) => {
          execFile('/bin/launchctl', ['getenv', 'SSH_AUTH_SOCK'], (err, stdout) => {
            if (err || !stdout.trim()) {
              resolve(null);
              return;
            }
            resolve(stdout.trim());
          });
        });
        if (sock) {
          try {
            await fs.promises.access(sock);
            return sock;
          } catch {
            // Not accessible
          }
        }
      } catch {
        // launchctl not available
      }
    }

    // 3. Try known socket paths
    const knownPaths = [
      // 1Password SSH agent
      path.join(
        os.homedir(),
        'Library',
        'Group Containers',
        '2BUA8C4S2C.com.1password',
        'agent.sock'
      ),
      path.join(os.homedir(), '.1password', 'agent.sock'),
      // Common user agent socket
      path.join(os.homedir(), '.ssh', 'agent.sock'),
    ];

    // Linux: add system paths
    if (process.platform === 'linux') {
      const uid = process.getuid?.();
      if (uid !== undefined) {
        knownPaths.push(`/run/user/${uid}/ssh-agent.socket`);
        knownPaths.push(`/run/user/${uid}/keyring/ssh`);
      }
    }

    for (const socketPath of knownPaths) {
      try {
        await fs.promises.access(socketPath);
        return socketPath;
      } catch {
        // Not accessible
      }
    }

    return null;
  }

  /**
   * Resolves authentication automatically by trying:
   * 1. IdentityFile from SSH config
   * 2. SSH agent
   * 3. Default key files (id_ed25519, id_rsa)
   */
  private async resolveAutoAuth(
    sshConfig: SshConfigHostEntry | null
  ): Promise<{ privateKey?: string; agent?: string }> {
    // Try SSH config identity file
    if (sshConfig?.hasIdentityFile) {
      const resolved = await this.configParser.resolveHost(sshConfig.alias);
      if (resolved) {
        // The config parser already told us there's an identity file.
        // Try common identity file locations from config
        const configKeyPaths = [
          path.join(os.homedir(), '.ssh', 'id_ed25519'),
          path.join(os.homedir(), '.ssh', 'id_rsa'),
        ];
        for (const keyPath of configKeyPaths) {
          try {
            const keyData = await fs.promises.readFile(keyPath, 'utf8');
            return { privateKey: keyData };
          } catch {
            // Try next
          }
        }
      }
    }

    // Try SSH agent
    const agentSocket = await this.discoverAgentSocket();
    if (agentSocket) {
      return { agent: agentSocket };
    }

    // Try default key files
    const defaultKeys = [
      path.join(os.homedir(), '.ssh', 'id_ed25519'),
      path.join(os.homedir(), '.ssh', 'id_rsa'),
      path.join(os.homedir(), '.ssh', 'id_ecdsa'),
    ];

    for (const keyPath of defaultKeys) {
      try {
        const keyData = await fs.promises.readFile(keyPath, 'utf8');
        return { privateKey: keyData };
      } catch {
        // Try next
      }
    }

    return {};
  }

  private async resolveRemoteProjectsPath(username: string): Promise<string> {
    // Prefer remote $HOME when available, then fall back to common paths.
    const remoteHome = await this.resolveRemoteHomeDirectory();
    const candidates = [
      ...(remoteHome ? [path.posix.join(remoteHome, '.claude', 'projects')] : []),
      `/home/${username}/.claude/projects`,
      `/Users/${username}/.claude/projects`,
      `/root/.claude/projects`,
    ];

    for (const candidate of [...new Set(candidates)]) {
      if (await this.provider.exists(candidate)) {
        return candidate;
      }
    }

    // Fallback to inferred home-based path when we could resolve $HOME.
    if (remoteHome) {
      return path.posix.join(remoteHome, '.claude', 'projects');
    }

    // Final fallback: Linux convention.
    return `/home/${username}/.claude/projects`;
  }

  /**
   * Resolve remote user's home directory by querying `$HOME` over SSH.
   */
  private async resolveRemoteHomeDirectory(): Promise<string | null> {
    if (!this.client) {
      return null;
    }

    try {
      const home = await this.execRemoteCommand('printf %s "$HOME"');
      const normalized = home.trim();
      return normalized.startsWith('/') ? normalized : null;
    } catch {
      return null;
    }
  }

  /**
   * Execute a command on the connected SSH host and return stdout.
   */
  private async execRemoteCommand(command: string): Promise<string> {
    const client = this.client;
    if (!client) {
      throw new Error('SSH client is not connected');
    }

    return new Promise<string>((resolve, reject) => {
      client.exec(command, (err, stream) => {
        if (err) {
          reject(err);
          return;
        }

        let stdout = '';
        let stderr = '';

        stream.on('data', (chunk: Buffer | string) => {
          stdout += chunk.toString();
        });

        stream.stderr.on('data', (chunk: Buffer | string) => {
          stderr += chunk.toString();
        });

        stream.on('close', (code: number | null) => {
          if (code === 0) {
            resolve(stdout);
            return;
          }
          const exitCode = code === null ? 'unknown' : String(code);
          reject(new Error(stderr.trim() || `Remote command failed with exit code ${exitCode}`));
        });
      });
    });
  }

  private handleDisconnect(): void {
    if (this.state === 'disconnected') return;

    this.provider = this.localProvider;
    this.remoteProjectsPath = null;
    this.setState('disconnected');
  }

  private cleanup(): void {
    if (this.provider.type === 'ssh') {
      this.provider.dispose();
    }
    if (this.client) {
      try {
        this.client.end();
      } catch {
        // Ignore cleanup errors
      }
      this.client = null;
    }
  }

  private setState(state: SshConnectionState): void {
    this.state = state;
    this.emit('state-change', this.getStatus());
  }
}
