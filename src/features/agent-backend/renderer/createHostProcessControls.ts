import { assertOriginalProcessStop, isProcessRef } from '../contracts/processes';

import type {
  BackendProcessControlRequest,
  BackendProcessReceipt,
  ProcessStopSelection,
} from '../contracts/processes';

export class OriginalProcessStopUnknown extends Error {
  constructor(readonly original: { commandId: string; processRef: string }) {
    super('Original process stop remains unresolved; refresh queries the original command');
  }
}
/** No cache/journal/replay: cold rows expose original pending identity from the owner. */
export function createHostProcessControls(options: {
  backend: {
    invoke(
      request: BackendProcessControlRequest
    ): Promise<{ ok: boolean; value?: unknown; code?: string; outcome?: string }>;
  };
  captureScope(): () => boolean;
  resolve(
    selection: string,
    current: () => boolean
  ): Promise<{ handle: { handleId: string }; assertCurrent(): void }>;
  invalidateReads(handleId: string): void;
}) {
  return async (
    selection: string,
    _pidForDisplayConsistency: number,
    captured?: ProcessStopSelection
  ): Promise<void> => {
    if (
      !captured ||
      !isProcessRef(captured.processRef) ||
      (captured.originalCommandId !== undefined &&
        (!captured.originalCommandId ||
          captured.originalCommandId.length > 256 ||
          captured.originalCommandId.includes('\0')))
    )
      throw new Error('Captured process row required');
    // Capture before the first await. Reopened pending rows always query the owner's original command.
    const original = Object.freeze({
      commandId: captured.originalCommandId ?? crypto.randomUUID(),
      processRef: captured.processRef,
    });
    const queryOnly = captured.originalCommandId !== undefined;
    const current = options.captureScope();
    if (!current()) throw new Error('Team context changed');
    const target = await options.resolve(selection, current);
    const assertCurrent = () => {
      try {
        if (!current()) throw new Error('stale');
        target.assertCurrent();
      } catch {
        throw new OriginalProcessStopUnknown(original);
      }
    };
    assertCurrent();
    let receipt: BackendProcessReceipt | undefined;
    try {
      const request: BackendProcessControlRequest = queryOnly
        ? {
            handle: target.handle,
            commandId: original.commandId,
            operation: 'process.lookup',
            payload: { originalCommandId: original.commandId },
          }
        : {
            handle: target.handle,
            commandId: original.commandId,
            operation: 'process.terminate',
            payload: { processRef: original.processRef },
          };
      const result = await options.backend.invoke(request);
      assertCurrent();
      if (result.ok && result.value !== null)
        receipt = assertOriginalProcessStop(result.value, original);
      else if (!queryOnly && result.outcome === 'not-dispatched')
        throw new Error(`Host process stop ${result.code}`);
    } catch (error) {
      if (!current()) throw new OriginalProcessStopUnknown(original);
      // No fallback/reselection or fresh stop command after an uncertain dispatch.
      if (error instanceof Error && error.message.startsWith('Host process stop ')) throw error;
    } finally {
      if (current()) options.invalidateReads(target.handle.handleId);
    }
    if (receipt?.state.phase === 'completed') return;
    if (receipt?.state.phase === 'refused') throw new Error('Original process stop refused');
    if (queryOnly) throw new OriginalProcessStopUnknown(original);
    // One bounded read of the original command; never another terminate, even if result is missing.
    assertCurrent();
    let lookup: Awaited<ReturnType<typeof options.backend.invoke>>;
    try {
      lookup = await options.backend.invoke({
        handle: target.handle,
        commandId: crypto.randomUUID(),
        operation: 'process.lookup',
        payload: { originalCommandId: original.commandId },
      });
    } catch {
      throw new OriginalProcessStopUnknown(original);
    }
    assertCurrent();
    if (lookup.ok && lookup.value !== null) {
      const observed = assertOriginalProcessStop(lookup.value, original);
      if (observed.state.phase === 'completed') {
        options.invalidateReads(target.handle.handleId);
        return;
      }
      if (observed.state.phase === 'refused') throw new Error('Original process stop refused');
    }
    throw new OriginalProcessStopUnknown(original);
  };
}
