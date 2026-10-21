import { AGENT_BACKEND_INVOKE_CHANNEL } from '../../../contracts/operations';

import type {
  BackendOperationRequest,
  BackendOperationResult,
} from '../../../contracts/operations';
import type { BackendOperationsFacade } from './BackendOperationsFacade';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

/** Shell must validate the captured sender/handle authority; renderer fields are not principals. */
export function registerAgentBackendIpc(
  ipc: Pick<IpcMain, 'handle' | 'removeHandler'>,
  facade: BackendOperationsFacade,
  authorize: (
    event: IpcMainInvokeEvent,
    request: BackendOperationRequest
  ) => boolean | Promise<boolean>
): () => void {
  ipc.handle(
    AGENT_BACKEND_INVOKE_CHANNEL,
    async (event, value: unknown): Promise<BackendOperationResult> => {
      let request: BackendOperationRequest;
      try {
        request = facade.validate(value);
      } catch {
        return { ok: false, code: 'invalid', outcome: 'not-dispatched' };
      }
      try {
        if (!(await authorize(event, request)))
          return { ok: false, code: 'forbidden', outcome: 'not-dispatched' };
      } catch {
        return { ok: false, code: 'forbidden', outcome: 'not-dispatched' };
      }
      return facade.invoke(request);
    }
  );
  return () => ipc.removeHandler(AGENT_BACKEND_INVOKE_CHANNEL);
}
