import type { IpcResult } from '@shared/types/ipc';

export type ReviewHistoryIpcHandlerWrapper = <T>(
  operationName: string,
  operation: () => Promise<T>
) => Promise<IpcResult<T>>;
