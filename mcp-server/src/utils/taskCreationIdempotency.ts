import { createHash } from 'node:crypto';

const MCP_TASK_CREATION_NAMESPACE = 'agent-teams-mcp';
export const CANONICAL_TASK_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface TaskCreationBoard {
  getTask?(taskId: string): unknown;
  createTask(input: Record<string, unknown>): unknown;
  reconcileTaskCreation(input: Record<string, unknown>): unknown;
}

export interface OptionalTaskCreateIdentity {
  teamName: string;
  commandId?: string;
  idempotencyKey?: string;
}

export function resolveOptionalTaskCreateCommandId(
  identity: OptionalTaskCreateIdentity
): string | undefined {
  const commandId = normalizeOptionalValue(identity.commandId);
  const idempotencyKey = normalizeOptionalValue(identity.idempotencyKey);
  if (!commandId && !idempotencyKey) {
    return undefined;
  }

  if (commandId && !CANONICAL_TASK_UUID_PATTERN.test(commandId)) {
    throw new Error('task_create commandId must be a canonical task UUID (version 1-5)');
  }
  const idempotencyCommandId = idempotencyKey
    ? CANONICAL_TASK_UUID_PATTERN.test(idempotencyKey)
      ? idempotencyKey.toLowerCase()
      : deriveUuid(['task_create', identity.teamName, idempotencyKey])
    : undefined;

  if (commandId && idempotencyCommandId && commandId.toLowerCase() !== idempotencyCommandId) {
    throw new Error('task_create commandId and idempotencyKey identify different requests');
  }
  return commandId?.toLowerCase() ?? idempotencyCommandId;
}

export function resolveMessageTaskCommandId(input: {
  teamName: string;
  messageId: string;
  requestKey?: string;
}): string | undefined {
  const requestKey = normalizeOptionalValue(input.requestKey);
  if (!requestKey) {
    return undefined;
  }
  return deriveUuid(['task_create_from_message', input.teamName, input.messageId, requestKey]);
}

export function createTaskWithOptionalIdempotency(input: {
  taskBoard: TaskCreationBoard;
  teamName: string;
  operation: 'task.create' | 'task.create_from_message';
  payload: Record<string, unknown>;
  commandId?: string;
  /** New mutable catalog admission runs only after existing keyed provenance is reconciled. */
  admitCreate?: () => Promise<void>;
}): unknown {
  if (!input.commandId) {
    return input.admitCreate
      ? input.admitCreate().then(() => input.taskBoard.createTask(input.payload))
      : input.taskBoard.createTask(input.payload);
  }

  const commandPayload = {
    ...input.payload,
    id: input.commandId,
    // MCP callers may choose their command id, so an unrelated legacy task
    // at that UUID must never be adopted as a retry of this request.
    allowLegacyAdoption: false,
    creationCommand: {
      namespace: MCP_TASK_CREATION_NAMESPACE,
      scopeKey: input.teamName,
      operation: input.operation,
      commandId: input.commandId,
      payloadHash: hashPayload(input.payload),
    },
  };

  if (input.admitCreate) {
    if (!input.taskBoard.getTask) throw new Error('Task creation admission requires task lookup');
    let exists = false;
    try {
      input.taskBoard.getTask(input.commandId);
      exists = true;
    } catch (error) {
      if ((error as { code?: string }).code !== 'TASK_NOT_FOUND') throw error;
    }
    if (exists)
      return withoutCreationCommand(input.taskBoard.reconcileTaskCreation(commandPayload));
  }
  const create = () => {
    try {
      return withoutCreationCommand(input.taskBoard.createTask(commandPayload));
    } catch (error) {
      if (!isExistingCommandTaskError(error, input.commandId!)) throw error;
      return withoutCreationCommand(input.taskBoard.reconcileTaskCreation(commandPayload));
    }
  };
  return input.admitCreate ? input.admitCreate().then(create) : create();
}

function normalizeOptionalValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function deriveUuid(parts: string[]): string {
  const hex = createHash('sha256').update(parts.join('\0')).digest('hex');
  const versioned = `${hex.slice(0, 12)}5${hex.slice(13, 16)}`;
  const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  const normalized = `${versioned}${variant}${hex.slice(17, 32)}`;
  return `${normalized.slice(0, 8)}-${normalized.slice(8, 12)}-${normalized.slice(12, 16)}-${normalized.slice(16, 20)}-${normalized.slice(20, 32)}`;
}

function hashPayload(payload: Record<string, unknown>): string {
  return `sha256:${createHash('sha256').update(stableJson(payload)).digest('hex')}`;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('Task creation payload must contain only finite numbers');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  throw new TypeError(`Task creation payload contains unsupported ${typeof value} value`);
}

function isExistingCommandTaskError(error: unknown, commandId: string): boolean {
  return error instanceof Error && error.message === `Task already exists: ${commandId}`;
}

function withoutCreationCommand(value: unknown): unknown {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    return value;
  }
  const { creationCommand: _creationCommand, ...task } = value as Record<string, unknown>;
  return task;
}
