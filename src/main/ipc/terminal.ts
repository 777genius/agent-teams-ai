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
import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent } from 'electron';

const logger = createLogger('IPC:terminal');
const MAX_TERMINAL_DIMENSION = 32_767;

let service: PtyTerminalService;

interface TerminalHandlerRegistration {
  write: (event: IpcMainEvent, ptyId: string, data: string) => void;
  resize: (event: IpcMainEvent, ptyId: string, cols: unknown, rows: unknown) => void;
  kill: (event: IpcMainEvent, ptyId: string) => void;
}

const terminalHandlerRegistrations = new WeakMap<IpcMain, TerminalHandlerRegistration>();

function isValidTerminalDimension(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= MAX_TERMINAL_DIMENSION
  );
}

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
  if (terminalHandlerRegistrations.has(ipcMain)) {
    return;
  }

  const registration: TerminalHandlerRegistration = {
    write: (_event, ptyId, data) => {
      try {
        service.write(ptyId, data);
      } catch (err) {
        logger.warn('terminal:write error:', getErrorMessage(err));
      }
    },
    resize: (_event, ptyId, cols, rows) => {
      try {
        if (!isValidTerminalDimension(cols) || !isValidTerminalDimension(rows)) {
          logger.warn('terminal:resize rejected invalid dimensions');
          return;
        }
        service.resize(ptyId, cols, rows);
      } catch (err) {
        logger.warn('terminal:resize error:', getErrorMessage(err));
      }
    },
    kill: (_event, ptyId) => {
      try {
        service.kill(ptyId);
      } catch (err) {
        logger.warn('terminal:kill error:', getErrorMessage(err));
      }
    },
  };

  // spawn uses handle (needs response with pty ID)
  ipcMain.handle(TERMINAL_SPAWN, handleSpawn);

  // write, resize, kill are fire-and-forget (hot path, latency-sensitive)
  // Wrapped in try/catch: node-pty can throw if the PTY dies between Map.get() and .write()
  ipcMain.on(TERMINAL_WRITE, registration.write);
  ipcMain.on(TERMINAL_RESIZE, registration.resize);
  ipcMain.on(TERMINAL_KILL, registration.kill);
  terminalHandlerRegistrations.set(ipcMain, registration);

  logger.info('Terminal handlers registered');
}

/**
 * Removes all terminal IPC handlers.
 */
export function removeTerminalHandlers(ipcMain: IpcMain): void {
  const registration = terminalHandlerRegistrations.get(ipcMain);
  if (!registration) {
    return;
  }

  terminalHandlerRegistrations.delete(ipcMain);
  ipcMain.removeHandler(TERMINAL_SPAWN);
  ipcMain.removeListener(TERMINAL_WRITE, registration.write);
  ipcMain.removeListener(TERMINAL_RESIZE, registration.resize);
  ipcMain.removeListener(TERMINAL_KILL, registration.kill);

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
