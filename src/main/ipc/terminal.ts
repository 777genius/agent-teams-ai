/**
 * IPC Handlers for Embedded Terminal Operations.
 *
 * Handlers:
 * - terminal:spawn: Spawn a new PTY process (returns pty ID)
 * - terminal:write: Write data to PTY stdin (fire-and-forget)
 * - terminal:resize: Resize PTY terminal (fire-and-forget)
 * - terminal:kill: Kill PTY process (fire-and-forget)
 * - terminal:data: PTY output events (main → renderer, not a handler)
 * - terminal:exit: PTY exit events (main → renderer, not a handler)
 */

import {
  TERMINAL_KILL,
  TERMINAL_RESIZE,
  TERMINAL_SPAWN,
  TERMINAL_WRITE,
  // eslint-disable-next-line boundaries/element-types -- IPC channel constants shared between main and preload
} from '@preload/constants/ipcChannels';
import { getErrorMessage } from '@shared/utils/errorHandling';
import { createLogger } from '@shared/utils/logger';

import type { PtyTerminalService } from '../services';
import type { IpcResult } from '@shared/types';
import type { PtySpawnOptions } from '@shared/types/terminal';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

const logger = createLogger('IPC:terminal');

let service: PtyTerminalService;

/**
 * Initializes terminal handlers with the service instance.
 */
export function initializeTerminalHandlers(terminalService: PtyTerminalService): void {
  service = terminalService;
}

/**
 * Registers all terminal IPC handlers.
 */
export function registerTerminalHandlers(ipcMain: IpcMain): void {
  // spawn uses handle (needs response with pty ID)
  ipcMain.handle(TERMINAL_SPAWN, handleSpawn);

  // write, resize, kill are fire-and-forget (hot path, latency-sensitive)
  // Wrapped in try/catch: node-pty can throw if the PTY dies between Map.get() and .write()
  ipcMain.on(TERMINAL_WRITE, (_event, ptyId: string, data: string) => {
    try {
      service.write(ptyId, data);
    } catch (err) {
      logger.warn('terminal:write error:', getErrorMessage(err));
    }
  });
  ipcMain.on(TERMINAL_RESIZE, (_event, ptyId: string, cols: number, rows: number) => {
    try {
      service.resize(ptyId, cols, rows);
    } catch (err) {
      logger.warn('terminal:resize error:', getErrorMessage(err));
    }
  });
  ipcMain.on(TERMINAL_KILL, (_event, ptyId: string) => {
    try {
      service.kill(ptyId);
    } catch (err) {
      logger.warn('terminal:kill error:', getErrorMessage(err));
    }
  });

  logger.info('Terminal handlers registered');
}

/**
 * Removes all terminal IPC handlers.
 */
export function removeTerminalHandlers(ipcMain: IpcMain): void {
  ipcMain.removeHandler(TERMINAL_SPAWN);
  ipcMain.removeAllListeners(TERMINAL_WRITE);
  ipcMain.removeAllListeners(TERMINAL_RESIZE);
  ipcMain.removeAllListeners(TERMINAL_KILL);

  logger.info('Terminal handlers removed');
}

// =============================================================================
// Handler Implementations
// =============================================================================

async function handleSpawn(
  _event: IpcMainInvokeEvent,
  options?: PtySpawnOptions
): Promise<IpcResult<string>> {
  try {
    const id = await service.spawn(options);
    return { success: true, data: id };
  } catch (error) {
    const msg = getErrorMessage(error);
    logger.error('Error in terminal:spawn:', msg);
    return { success: false, error: msg };
  }
}
