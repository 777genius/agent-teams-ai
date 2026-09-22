import {
  OPEN_CODE_STARTUP_CLEANUP_RETRY,
  OPEN_CODE_STARTUP_CLEANUP_STATUS,
} from '@shared/types/openCodeStartupCleanup';

import type { OpenCodeStartupCleanupRecoveryAPI } from '@shared/types/openCodeStartupCleanup';
import type { IpcRenderer } from 'electron';

export function createOpenCodeStartupCleanupAPI(
  ipc: Pick<IpcRenderer, 'invoke'>
): OpenCodeStartupCleanupRecoveryAPI {
  return {
    getOpenCodeCleanupStatus: () => ipc.invoke(OPEN_CODE_STARTUP_CLEANUP_STATUS),
    retryOpenCodeCleanup: () => ipc.invoke(OPEN_CODE_STARTUP_CLEANUP_RETRY),
  };
}
