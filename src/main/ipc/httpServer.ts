/**
 * IPC Handlers for HTTP Server Operations.
 *
 * Handlers:
 * - httpServer:start: Start the HTTP sidecar server
 * - httpServer:stop: Stop the HTTP sidecar server
 * - httpServer:getStatus: Get HTTP server running status and port
 */

import { createLogger } from '@shared/utils/logger';
import { type IpcMain } from 'electron';

import { configManager } from '../services';
import { clearTeamControlApiState } from '../services/team/TeamControlApiState';

import type { HttpServer } from '../services/infrastructure/HttpServer';

const logger = createLogger('IPC:httpServer');

let httpServer: HttpServer;
let startServer: () => Promise<void>;

/**
 * Initializes HTTP server handlers with service instances.
 */
export function initializeHttpServerHandlers(
  server: HttpServer,
  startHttpServer: () => Promise<void>
): void {
  httpServer = server;
  startServer = startHttpServer;
}

/**
 * Registers all HTTP server IPC handlers.
 */
export function registerHttpServerHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('httpServer:start', handleStart);
  ipcMain.handle('httpServer:stop', handleStop);
  ipcMain.handle('httpServer:getStatus', handleGetStatus);

  logger.info('HTTP server handlers registered');
}

/**
 * Removes all HTTP server IPC handlers.
 */
export function removeHttpServerHandlers(ipcMain: IpcMain): void {
  ipcMain.removeHandler('httpServer:start');
  ipcMain.removeHandler('httpServer:stop');
  ipcMain.removeHandler('httpServer:getStatus');

  logger.info('HTTP server handlers removed');
}

// =============================================================================
// Handler Implementations
// =============================================================================

async function handleStart(): Promise<{
  success: boolean;
  data?: { running: boolean; port: number | null };
  error?: string;
}> {
  try {
    await startServer();
    configManager.updateConfig('httpServer', { enabled: true, port: httpServer.getPort() });
    return { success: true, data: { running: true, port: httpServer.getPort() } };
  } catch (error) {
    logger.error('Failed to start HTTP server via IPC:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to start server',
    };
  }
}

async function handleStop(): Promise<{
  success: boolean;
  data?: { running: boolean; port: number | null };
  error?: string;
}> {
  try {
    await httpServer.stop();
    await clearTeamControlApiState();
    configManager.updateConfig('httpServer', { enabled: false });
    return { success: true, data: { running: false, port: httpServer.getPort() } };
  } catch (error) {
    logger.error('Failed to stop HTTP server via IPC:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to stop server',
    };
  }
}

function handleGetStatus(): {
  success: boolean;
  data: { running: boolean; port: number | null };
} {
  return { success: true, data: { running: httpServer.isRunning(), port: httpServer.getPort() } };
}
