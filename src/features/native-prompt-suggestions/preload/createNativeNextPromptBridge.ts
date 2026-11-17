import { NATIVE_NEXT_PROMPT_UPDATED } from '../contracts/channel';

import type { NativeNextPromptCandidate } from '../contracts';
import type { NativeNextPromptApi } from '../contracts/channel';
import type { IpcRenderer, IpcRendererEvent } from 'electron';

export function createNativeNextPromptBridge(ipc: Pick<IpcRenderer, 'on' | 'removeListener'>): NativeNextPromptApi {
  return {
    onUpdated(callback) {
      const listener = (_event: IpcRendererEvent, value: NativeNextPromptCandidate): void => {
        callback(value);
      };
      ipc.on(NATIVE_NEXT_PROMPT_UPDATED, listener);
      return () => ipc.removeListener(NATIVE_NEXT_PROMPT_UPDATED, listener);
    },
  };
}
