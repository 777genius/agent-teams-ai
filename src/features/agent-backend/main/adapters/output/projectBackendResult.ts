import type {
  BackendCheckpoint,
  BackendCommandReceipt,
  BackendComment,
  BackendOperationRequest,
  BackendOperationResult,
  BackendRuntimeSnapshot,
  BackendTask,
  BackendTaskRef,
} from '../../../contracts/operations';

function row(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid host projection');
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid host projection');
  return value;
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('Invalid host projection');
  return value;
}
function oneOf<T extends string>(value: unknown, values: readonly T[]): T {
  if (!values.includes(value as T)) throw new Error('Invalid host projection');
  return value as T;
}
function array<T>(value: unknown, project: (entry: unknown) => T): T[] {
  if (!Array.isArray(value)) throw new Error('Invalid host projection');
  return value.map(project);
}
function refs(value: unknown): BackendTaskRef[] {
  return array(value, (entry) => {
    const ref = row(entry);
    return {
      taskId: string(ref.taskId),
      displayId: string(ref.displayId),
      teamName: string(ref.teamName),
    };
  });
}
function optionalStrings(
  source: Record<string, unknown>,
  keys: readonly string[]
): Record<string, string> {
  return Object.fromEntries(
    keys.filter((key) => source[key] !== undefined).map((key) => [key, string(source[key])])
  );
}
function comment(value: unknown): BackendComment {
  const source = row(value);
  return {
    id: string(source.id),
    ...optionalStrings(source, ['author', 'text', 'createdAt', 'type']),
    ...(source.taskRefs === undefined ? {} : { taskRefs: refs(source.taskRefs) }),
  };
}
function task(value: unknown): BackendTask {
  const source = row(value);
  const result: BackendTask = {
    id: string(source.id),
    status: string(source.status),
    ...optionalStrings(source, ['subject', 'description', 'displayId', 'owner']),
  };
  for (const key of ['blocks', 'blockedBy', 'related'] as const) {
    if (source[key] !== undefined) result[key] = array(source[key], string);
  }
  if (source.descriptionTaskRefs !== undefined)
    result.descriptionTaskRefs = refs(source.descriptionTaskRefs);
  if (source.comments !== undefined) result.comments = array(source.comments, comment);
  return result;
}
function receipt(value: unknown, request: BackendOperationRequest): BackendCommandReceipt {
  const source = row(value);
  const operation = oneOf(row(source.command).operation, [
    'task.create',
    'task.update',
    'task.assign',
    'task.lifecycle',
    'task.comment',
    'message.send',
  ] as const);
  if (
    source.commandId !== request.commandId ||
    (request.operation !== 'command.lookup' && operation !== request.operation)
  )
    throw new Error('Wrong receipt');
  const result: BackendCommandReceipt = {
    commandId: request.commandId,
    operation,
    phase: oneOf(source.phase, ['prepared', 'applying', 'completed', 'rejected', 'held'] as const),
  };
  if (source.result !== undefined) {
    const applied = row(source.result);
    if (operation === 'message.send') {
      result.messageId = string(applied.messageId);
      if (applied.deliveryId !== undefined) result.deliveryId = string(applied.deliveryId);
    } else if (operation === 'task.comment') {
      if (applied.task !== undefined) result.task = task(applied.task);
      result.comment = comment(applied.comment);
    } else result.task = task(applied);
  }
  return result;
}
function runtime(value: unknown, request: BackendOperationRequest): BackendRuntimeSnapshot {
  const source = row(value);
  if (!('memberId' in request.payload) || source.memberId !== request.payload.memberId)
    throw new Error('Wrong member');
  const result: BackendRuntimeSnapshot = {
    memberId: string(source.memberId),
    phase: oneOf(source.phase, ['unopened', 'opening', 'allocated', 'closing', 'closed', 'held']),
    sealed: boolean(source.sealed),
    custody: oneOf(source.custody, ['owned', 'released', 'unknown']),
    nativeReady: boolean(source.nativeReady),
    attached: boolean(source.attached),
    inputs: array(source.inputs, (entry) => {
      const input = row(entry);
      return {
        inputId: string(input.inputId),
        phase: oneOf(input.phase, [
          'admitted',
          'claimed',
          'consumed',
          'terminal',
          'cancelled',
          'rejected',
          'not-sent',
          'unknown',
        ]),
        ...(input.terminal === undefined
          ? {}
          : { terminal: oneOf(input.terminal, ['succeeded', 'failed', 'cancelled'] as const) }),
      };
    }),
    interactions: array(source.interactions, (entry) => {
      const interaction = row(entry);
      if (typeof interaction.expiresAt !== 'number' || !Number.isFinite(interaction.expiresAt))
        throw new Error('Invalid expiry');
      return {
        interactionRef: string(interaction.interactionRef),
        inputId: string(interaction.inputId),
        kind: oneOf(interaction.kind, ['permission', 'question'] as const),
        expiresAt: interaction.expiresAt,
        phase: oneOf(interaction.phase, ['pending', 'responding', 'resolved', 'unknown']),
      };
    }),
  };
  if (source.diagnostic !== undefined)
    result.diagnostic = oneOf(source.diagnostic, [
      'open-unknown',
      'observe-ended',
      'observe-failed',
      'readiness-unavailable',
      'close-unknown',
    ]);
  return result;
}
function checkpoint(value: unknown, request: BackendOperationRequest): BackendCheckpoint {
  const source = row(value);
  if (
    request.operation !== 'runtime.checkpoint' ||
    source.checkpointId !== request.payload.checkpointId
  )
    throw new Error('Wrong checkpoint');
  const result: BackendCheckpoint = {
    checkpointId: string(source.checkpointId),
    status: oneOf(source.status, ['published', 'unsupported', 'held']),
  };
  if (source.reference !== undefined) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,255}$/.test(string(source.reference)))
      throw new Error('Invalid reference');
    result.reference = string(source.reference);
  }
  return result;
}

/** Allowlist response projection; raw receipts/config/native identities never reach transports. */
export function projectBackendResult(
  request: BackendOperationRequest,
  raw: unknown
): BackendOperationResult {
  const source = row(raw);
  if (source.ok === false)
    return {
      ok: false,
      code: oneOf(source.code, ['invalid', 'conflict', 'forbidden', 'hold', 'busy']),
      outcome: oneOf(source.outcome, ['rejected', 'unknown']),
    };
  if (source.ok !== true) throw new Error('Invalid result');
  if (request.operation === 'task.get') return { ok: true, value: task(source.value) };
  if (request.operation === 'tasks.list') return { ok: true, value: array(source.value, task) };
  if (request.operation === 'command.lookup' && source.value === null)
    return { ok: true, value: null };
  if (request.operation === 'runtime.checkpoint')
    return { ok: true, value: checkpoint(source.value, request) };
  if (request.operation.startsWith('runtime.'))
    return { ok: true, value: runtime(source.value, request) };
  return { ok: true, value: receipt(source.value, request) };
}
