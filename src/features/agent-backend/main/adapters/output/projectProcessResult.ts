import {
  assertOriginalProcessStop,
  isProcessRef,
  readBackendProcesses,
} from '../../../contracts/processes';

import type { BackendOperationRequest } from '../../../contracts/operations';
import type { BackendProcessReceipt } from '../../../contracts/processes';
function object(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid process projection');
  return value as Record<string, unknown>;
}
export function projectProcessResult(request: BackendOperationRequest, value: unknown) {
  if (request.operation === 'process.list') return readBackendProcesses(value);
  if (request.operation === 'process.pending.read') {
    if (!Array.isArray(value) || value.length > 64)
      throw new Error('Invalid original stop inventory');
    return value.map((value) => {
      const row = object(value),
        state = object(row.state);
      if (
        typeof row.commandId !== 'string' ||
        !row.commandId ||
        row.commandId.length > 256 ||
        !isProcessRef(row.originalProcessRef) ||
        state.phase !== 'requested' ||
        (state.native !== 'unknown' && state.native !== 'accepted')
      )
        throw new Error('Invalid original stop');
      return {
        commandId: row.commandId,
        originalProcessRef: row.originalProcessRef,
        state: { phase: 'requested', native: state.native } as const,
      };
    });
  }
  if (request.operation !== 'process.lookup' && request.operation !== 'process.terminate')
    throw new Error('Invalid process request');
  if (value === null && request.operation === 'process.lookup') return null;
  const row = object(value),
    commandId =
      request.operation === 'process.lookup'
        ? request.payload.originalCommandId
        : request.commandId;
  if (
    row.commandId !== commandId ||
    row.operation !== 'terminate' ||
    !isProcessRef(row.originalProcessRef)
  )
    throw new Error('Wrong original process receipt');
  const observed = assertOriginalProcessStop(row, {
    commandId,
    processRef:
      request.operation === 'process.terminate'
        ? request.payload.processRef
        : row.originalProcessRef,
  });
  const result: BackendProcessReceipt = {
    commandId: observed.commandId,
    operation: observed.operation,
    phase: observed.phase,
    originalProcessRef: row.originalProcessRef,
    state: { ...observed.state },
  };
  if (observed.result !== undefined)
    result.result = Array.isArray(observed.result)
      ? readBackendProcesses(observed.result)
      : readBackendProcesses([observed.result])[0]!;
  return result;
}
