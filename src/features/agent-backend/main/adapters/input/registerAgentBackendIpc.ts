import { AGENT_BACKEND_INVOKE_CHANNEL } from '../../../contracts/operations';

import type {
  BackendOperationRequest,
  BackendOperationResult,
} from '../../../contracts/operations';
import type { BackendRequestGuard } from '../../application/backendBinding';
import type { BackendOperationsFacade } from './BackendOperationsFacade';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

/** Shell must validate the captured sender/handle authority; renderer fields are not principals. */
export function registerAgentBackendIpc(
  ipc: Pick<IpcMain, 'handle' | 'removeHandler'>,
  facade: BackendOperationsFacade,
  authorize: (
    event: IpcMainInvokeEvent,
    request: BackendOperationRequest
  ) => boolean | BackendRequestGuard | Promise<boolean | BackendRequestGuard>
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
      let guard: BackendRequestGuard | undefined;
      try {
        const authorized = await authorize(event, request);
        if (authorized !== true) {
          if (
            !authorized ||
            typeof authorized !== 'object' ||
            typeof authorized.isCurrent !== 'function'
          )
            return { ok: false, code: 'forbidden', outcome: 'not-dispatched' };
          guard = Object.freeze({ isCurrent: authorized.isCurrent.bind(authorized) });
        }
      } catch {
        return { ok: false, code: 'forbidden', outcome: 'not-dispatched' };
      }
      return facade.invoke(request, guard);
    }
  );
  return () => ipc.removeHandler(AGENT_BACKEND_INVOKE_CHANNEL);
}
