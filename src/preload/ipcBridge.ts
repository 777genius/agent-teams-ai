import { toTeamDefinitionEditRefusal } from '@shared/utils/teamDefinitionEditRefusal';
import { ipcRenderer } from 'electron';

import type { IpcResult } from '@shared/types';
import type { TeamDefinitionEditRefusal } from '@shared/types/teamDefinitionEdit';

export interface IpcFileChangePayload {
  type: 'add' | 'change' | 'unlink';
  path: string;
  projectId?: string;
  sessionId?: string;
  isSubagent: boolean;
}

function unwrapIpcResult<T>(result: IpcResult<T>): T {
  if (!result.success) {
    throw Object.assign(new Error(result.error ?? 'Unknown error'), { failure: result.failure });
  }
  return result.data as T;
}

export async function invokeIpcWithResult<T>(channel: string, ...args: unknown[]): Promise<T> {
  return unwrapIpcResult((await ipcRenderer.invoke(channel, ...args)) as IpcResult<T>);
}

export async function invokeDefinitionEdit<T>(
  channel: string,
  ...args: unknown[]
): Promise<T | TeamDefinitionEditRefusal> {
  const result = (await ipcRenderer.invoke(channel, ...args)) as IpcResult<T>;
  if (!result.success) {
    const refusal = toTeamDefinitionEditRefusal(result.error ?? 'Unknown error', result.failure);
    if (refusal) return refusal;
  }
  return unwrapIpcResult(result);
}
