import type { IpcResult } from '@shared/types';

export function unwrapIpcResult<T>(result: IpcResult<T>): T {
  if (!result.success) {
    throw Object.assign(new Error(result.error ?? 'Unknown error'), { failure: result.failure });
  }
  return result.data as T;
}
