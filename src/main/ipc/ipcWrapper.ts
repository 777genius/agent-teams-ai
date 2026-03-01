/**
 * Generic IPC handler wrapper — standardizes error handling and logging.
 *
 * Creates a domain-specific wrapper that catches errors, logs them,
 * and returns IpcResult<T> for consistent renderer-side handling.
 */

import { createLogger } from '@shared/utils/logger';

import type { IpcResult } from '@shared/types/ipc';

export function createIpcWrapper(logPrefix: string) {
  const log = createLogger(logPrefix);

  return async function wrap<T>(operation: string, fn: () => Promise<T>): Promise<IpcResult<T>> {
    try {
      const data = await fn();
      return { success: true, data };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error(`handler error [${operation}]:`, message);
      return { success: false, error: message };
    }
  };
}
