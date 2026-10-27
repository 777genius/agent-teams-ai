import { parseBackendOperation } from '../input/validateBackendOperation';

import type {
  BackendCommandReceipt,
  BackendOperationRequest,
  BackendTaskSubmissionCommand,
} from '../../../contracts/operations';
function row(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid task receipt');
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new Error('Invalid task receipt');
  return value;
}
/** Original command and canonical effect identities, projected from actual Host ledger data. */
export function projectTaskSubmission(
  source: Record<string, unknown>,
  request: BackendOperationRequest
): Pick<BackendCommandReceipt, 'taskSubmission' | 'taskSubmissionNoEffect'> {
  const raw = row(source.command);
  if (Object.keys(raw).some((key) => !['commandId', 'operation', 'payload'].includes(key)))
    throw new Error('Invalid original task command');
  const original = parseBackendOperation({
    handle: request.handle,
    commandId: raw.commandId,
    operation: raw.operation,
    payload: raw.payload,
  });
  if (
    original.commandId !== request.commandId ||
    source.commandId !== original.commandId ||
    (original.operation !== 'task.create' && original.operation !== 'task.comment')
  )
    throw new Error('Wrong original task command');
  if (source.phase === 'completed') {
    const applied = row(source.result),
      effects = row(source.effects);
    if (original.operation === 'task.create') {
      if (string(applied.id) !== string(effects.taskId)) throw new Error('Wrong task effect');
    } else {
      if (string(row(applied.comment).id) !== string(effects.commentId))
        throw new Error('Wrong comment effect');
      if (applied.task !== undefined && string(row(applied.task).id) !== original.payload.taskId)
        throw new Error('Wrong comment task');
    }
  }
  if (source.phase === 'rejected') {
    const marker = row(source.result);
    if (Object.keys(marker).length !== 2 || marker.rejected !== true || marker.reason !== 'policy')
      throw new Error('Invalid task refusal proof');
  }
  return {
    taskSubmission: {
      commandId: original.commandId,
      operation: original.operation,
      payload: original.payload,
    } as BackendTaskSubmissionCommand,
    ...(source.phase === 'rejected' ? { taskSubmissionNoEffect: true as const } : {}),
  };
}
