import {
  getOpenCodeWindowsStartupCleanupStatus,
  retryOpenCodeWindowsStartupCleanup,
} from '@main/services/team/opencode/bridge/OpenCodeWindowsStartupCleanup';
import {
  OPEN_CODE_STARTUP_CLEANUP_RETRY,
  OPEN_CODE_STARTUP_CLEANUP_STATUS,
} from '@shared/types/openCodeStartupCleanup';

import type { IpcMain } from 'electron';

export function registerOpenCodeStartupCleanupHandlers(ipc: Pick<IpcMain, 'handle'>): void {
  const validate = (args: unknown[]): void => {
    if (args.length !== 0) throw new Error('Startup cleanup accepts no arguments');
    if (process.platform !== 'win32') throw new Error('Startup cleanup is Windows-only');
  };
  ipc.handle(OPEN_CODE_STARTUP_CLEANUP_STATUS, (_event, ...args: unknown[]) => {
    if (args.length !== 0) throw new Error('Startup cleanup accepts no arguments');
    return getOpenCodeWindowsStartupCleanupStatus();
  });
  ipc.handle(OPEN_CODE_STARTUP_CLEANUP_RETRY, async (_event, ...args: unknown[]) => {
    validate(args);
    return retryOpenCodeWindowsStartupCleanup();
  });
}
