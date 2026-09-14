/**
 * SSH IPC Handlers - Manages SSH connection lifecycle from renderer requests.
 *
 * Channels:
 * - ssh:connect - Connect to SSH host, create new context
 * - ssh:disconnect - Disconnect and switch back to local context
 * - ssh:getState - Get current connection state
 * - ssh:test - Test connection without switching
 */

import { createLogger } from '@shared/utils/logger';

// Channel constants (mirrored from preload/constants/ipcChannels.ts to respect module boundaries)
const SSH_CONNECT = 'ssh:connect';
const SSH_DISCONNECT = 'ssh:disconnect';
const SSH_GET_STATE = 'ssh:getState';
const SSH_TEST = 'ssh:test';
const SSH_GET_CONFIG_HOSTS = 'ssh:getConfigHosts';
const SSH_RESOLVE_HOST = 'ssh:resolveHost';
const SSH_SAVE_LAST_CONNECTION = 'ssh:saveLastConnection';
const SSH_GET_LAST_CONNECTION = 'ssh:getLastConnection';
import * as path from 'path';

import { configManager, ServiceContext } from '../services';

import type {
  ServiceContextRegistry,
  SshConnectionConfig,
  SshConnectionManager,
  SshConnectionStatus,
} from '../services';
import type { SshLastConnection } from '@shared/types';
import type { IpcMain } from 'electron';

const logger = createLogger('IPC:ssh');

// =============================================================================
// Module State
// =============================================================================

let connectionManager: SshConnectionManager;
let registry: ServiceContextRegistry;
let onContextRewire: (context: ServiceContext) => void;

// =============================================================================
// Initialization
// =============================================================================

/**
 * Initialize SSH handlers with required services.
 * @param manager - The SSH connection manager instance
 * @param contextRegistry - The service context registry
 * @param onRewire - Rewire-only callback (no renderer notification) for renderer-initiated switches
 */
export function initializeSshHandlers(
  manager: SshConnectionManager,
  contextRegistry: ServiceContextRegistry,
  onRewire: (context: ServiceContext) => void
): void {
  connectionManager = manager;
  registry = contextRegistry;
  onContextRewire = onRewire;
}

// =============================================================================
// Handler Registration
// =============================================================================

export function registerSshHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(SSH_CONNECT, async (_event, config: SshConnectionConfig) => {
    try {
      // Connect to SSH host
      await connectionManager.connect(config);

      // Get provider and remote path
      const provider = connectionManager.getProvider();
      const remoteProjectsPath = connectionManager.getRemoteProjectsPath() ?? undefined;
      const remoteTodosPath = remoteProjectsPath
        ? path.join(path.dirname(remoteProjectsPath), 'todos')
        : undefined;

      // Generate context ID
      const contextId = `ssh-${config.host}`;

      // Destroy existing SSH context if any (reconnection case)
      if (registry.has(contextId)) {
        logger.info(`Destroying existing SSH context: ${contextId}`);
        registry.destroy(contextId);
      }

      // Create new SSH context
      const sshContext = new ServiceContext({
        id: contextId,
        type: 'ssh',
        fsProvider: provider,
        projectsDir: remoteProjectsPath,
        todosDir: remoteTodosPath,
        getCustomProjectPaths: () => configManager.getCustomProjectPaths(),
        shouldIncludeSubagentErrors: () =>
          configManager.getConfig().notifications.includeSubagentErrors,
      });

      // Register and start SSH context
      registry.registerContext(sshContext);
      sshContext.start();

      // Switch to SSH context
      registry.switch(contextId);

      // Re-wire file watcher events only (renderer's connectSsh() handles state)
      onContextRewire(sshContext);

      return { success: true, data: connectionManager.getStatus() };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('SSH connect failed:', message);
      return { success: false, error: message };
    }
  });

  ipcMain.handle(SSH_DISCONNECT, async () => {
    try {
      // Get current SSH context ID before disconnecting
      const currentContextId = registry.getActiveContextId();
      const isSshContext = currentContextId.startsWith('ssh-');

      // Disconnect from SSH
      connectionManager.disconnect();

      // If we were on an SSH context, destroy it
      if (isSshContext) {
        // Switch back to local first (this also starts local file watcher)
        registry.switch('local');

        // Destroy the SSH context
        registry.destroy(currentContextId);

        // Re-wire file watcher events only (renderer's disconnectSsh() handles state)
        const localContext = registry.getActive();
        onContextRewire(localContext);
      }

      return { success: true, data: connectionManager.getStatus() };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('SSH disconnect failed:', message);
      return { success: false, error: message };
    }
  });

  ipcMain.handle(SSH_GET_STATE, async (): Promise<SshConnectionStatus> => {
    return connectionManager.getStatus();
  });

  ipcMain.handle(SSH_TEST, async (_event, config: SshConnectionConfig) => {
    try {
      const result = await connectionManager.testConnection(config);
      return { success: true, data: result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  });

  ipcMain.handle(SSH_GET_CONFIG_HOSTS, async () => {
    try {
      const hosts = await connectionManager.getConfigHosts();
      return { success: true, data: hosts };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('Failed to get SSH config hosts:', message);
      return { success: true, data: [] };
    }
  });

  ipcMain.handle(SSH_RESOLVE_HOST, async (_event, alias: string) => {
    try {
      const entry = await connectionManager.resolveHostConfig(alias);
      return { success: true, data: entry };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`Failed to resolve SSH host "${alias}":`, message);
      return { success: true, data: null };
    }
  });

  ipcMain.handle(SSH_SAVE_LAST_CONNECTION, async (_event, config: SshLastConnection) => {
    try {
      configManager.updateConfig('ssh', {
        lastConnection: {
          host: config.host,
          port: config.port,
          username: config.username,
          authMethod: config.authMethod,
          privateKeyPath: config.privateKeyPath,
        },
      });
      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('Failed to save SSH connection:', message);
      return { success: false, error: message };
    }
  });

  ipcMain.handle(SSH_GET_LAST_CONNECTION, async () => {
    try {
      const config = configManager.getConfig();
      return { success: true, data: config.ssh.lastConnection };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('Failed to get last SSH connection:', message);
      return { success: true, data: null };
    }
  });

  logger.info('SSH handlers registered');
}

export function removeSshHandlers(ipcMain: IpcMain): void {
  ipcMain.removeHandler(SSH_CONNECT);
  ipcMain.removeHandler(SSH_DISCONNECT);
  ipcMain.removeHandler(SSH_GET_STATE);
  ipcMain.removeHandler(SSH_TEST);
  ipcMain.removeHandler(SSH_GET_CONFIG_HOSTS);
  ipcMain.removeHandler(SSH_RESOLVE_HOST);
  ipcMain.removeHandler(SSH_SAVE_LAST_CONNECTION);
  ipcMain.removeHandler(SSH_GET_LAST_CONNECTION);
}
