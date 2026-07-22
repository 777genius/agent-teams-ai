import {
  ApplicationCommandFailureKind,
  type ApplicationCommandJsonValue,
  type ApplicationCommandRunner,
  ApplicationCommandRunOutcome,
} from '@features/application-command-ledger';
import { looksLikeCanonicalTaskId } from '@shared/utils/taskIdentity';

import type { ApplicationCommandRequestIdentity, TeamTask } from '@shared/types/team';

const TASK_BOARD_COMMAND_NAMESPACE = 'task-board';
const CREATE_TASK_OPERATION = 'task.create';

type JsonObject = Record<string, ApplicationCommandJsonValue>;

export interface TaskBoardCreateTaskDestination {
  findById(taskId: string): TeamTask | null;
  findByIdempotencyKey(idempotencyKey: string): TeamTask[];
  create(input: Record<string, unknown>): TeamTask | Promise<TeamTask>;
  reconcile(input: Record<string, unknown>): TeamTask | null | Promise<TeamTask | null>;
}

export interface TaskBoardCreateTaskCommand {
  teamName: string;
  identity: ApplicationCommandRequestIdentity;
  payload: Record<string, unknown>;
  destination: TaskBoardCreateTaskDestination;
}

export interface TaskBoardCreateTaskCommandResult {
  task: TeamTask;
  outcome: ApplicationCommandRunOutcome;
  createdInAttempt: boolean;
}

export interface TaskBoardCommandFacadeOptions {
  /**
   * Durable commands require the SQLite-backed application-command ledger.
   * When internal storage selected its JSON fallback, preserve the legacy
   * task-create path instead of calling the unavailable SQLite worker.
   */
  isDurableStorageAvailable?: () => Promise<boolean>;
  hashPayload?: (payload: JsonObject) => string;
}

interface TaskCreationRecord {
  namespace: string;
  scopeKey: string;
  operation: string;
  commandId: string;
  idempotencyKey: string;
  payloadHash: string;
}

export class TaskBoardCommandFacade {
  private readonly nonDurableTeamQueues = new Map<string, Promise<void>>();

  constructor(
    private readonly runner: ApplicationCommandRunner | null,
    private readonly options: TaskBoardCommandFacadeOptions = {}
  ) {}

  async createTask(command: TaskBoardCreateTaskCommand): Promise<TaskBoardCreateTaskCommandResult> {
    if (!looksLikeCanonicalTaskId(command.identity.commandId)) {
      throw new TypeError('Task create commandId must be a UUID');
    }
    const payload = toJsonObject(command.payload);
    if (
      !this.runner ||
      (this.options.isDurableStorageAvailable && !(await this.options.isDurableStorageAvailable()))
    ) {
      return this.enqueueNonDurableCreate(command.teamName, () =>
        this.createTaskWithoutDurableLedger(command, payload)
      );
    }
    const run = await this.runner.run<JsonObject, typeof CREATE_TASK_OPERATION>(
      {
        namespace: TASK_BOARD_COMMAND_NAMESPACE,
        scopeKey: command.teamName,
        commandId: command.identity.commandId,
        idempotencyKey: command.identity.idempotencyKey,
        operation: CREATE_TASK_OPERATION,
        payload,
        classifyError: classifyCreateTaskError,
        reconcile: async (record) => {
          try {
            const existing = findExistingDestination(command.destination, record);
            if (!existing) {
              return {
                outcome: 'not_applied',
                message: 'Task destination does not contain the logical command task',
              };
            }
            const reconciled = await reconcileDestination(
              command.destination,
              existing.record,
              payload
            );
            return {
              outcome: 'applied',
              result: makeStoredResult(reconciled, false),
            };
          } catch (error) {
            if (error instanceof TaskBoardCreateDestinationConflictError) {
              return {
                outcome: 'not_applied',
                message: error.message,
              };
            }
            throw error;
          }
        },
      },
      async (record) => {
        const existing = findExistingDestination(command.destination, record);
        if (existing) {
          const reconciled = await reconcileDestination(
            command.destination,
            existing.record,
            payload
          );
          return makeStoredResult(reconciled, false);
        }

        const destinationInput = makeDestinationInput(record, payload);
        try {
          await command.destination.create(destinationInput);
          const reconciled = await reconcileDestination(command.destination, record, payload);
          return makeStoredResult(reconciled, true);
        } catch (error) {
          let recovered: ResolvedDestination | null;
          try {
            recovered = findExistingDestination(command.destination, record);
          } catch (reconciliationError) {
            throw new TaskBoardCreateOutcomeUnknownError(error, reconciliationError);
          }
          if (recovered) {
            try {
              const reconciled = await reconcileDestination(
                command.destination,
                recovered.record,
                payload
              );
              return makeStoredResult(reconciled, true);
            } catch (reconciliationError) {
              if (reconciliationError instanceof TaskBoardCreateDestinationConflictError) {
                throw reconciliationError;
              }
              throw new TaskBoardCreateOutcomeUnknownError(error, reconciliationError);
            }
          }
          throw error;
        }
      }
    );

    const stored = readStoredResult(run.result);
    return {
      task: stored.task,
      outcome: run.outcome,
      createdInAttempt:
        stored.created &&
        (run.outcome === ApplicationCommandRunOutcome.Executed ||
          run.outcome === ApplicationCommandRunOutcome.Retried),
    };
  }

  private async createTaskWithoutDurableLedger(
    command: TaskBoardCreateTaskCommand,
    payload: JsonObject
  ): Promise<TaskBoardCreateTaskCommandResult> {
    if (!this.options.hashPayload) {
      throw new Error('Non-durable task commands require a payload hasher');
    }
    const commandRecord = {
      namespace: TASK_BOARD_COMMAND_NAMESPACE,
      scopeKey: command.teamName,
      operation: CREATE_TASK_OPERATION,
      commandId: command.identity.commandId,
      idempotencyKey: command.identity.idempotencyKey,
      payloadHash: this.options.hashPayload(payload),
    };
    const destinationInput = makeDestinationInput(commandRecord, payload);
    const existing = findExistingDestination(command.destination, commandRecord);
    if (existing) {
      const reconciled = await reconcileDestination(command.destination, existing.record, payload);
      return {
        task: toExternalTask(reconciled),
        outcome: ApplicationCommandRunOutcome.Replayed,
        createdInAttempt: false,
      };
    }

    try {
      await command.destination.create(destinationInput);
      const reconciled = await reconcileDestination(command.destination, commandRecord, payload);
      return {
        task: toExternalTask(reconciled),
        outcome: ApplicationCommandRunOutcome.Executed,
        createdInAttempt: true,
      };
    } catch (error) {
      const recovered = findExistingDestination(command.destination, commandRecord);
      if (!recovered) {
        throw error;
      }
      const reconciled = await reconcileDestination(command.destination, recovered.record, payload);
      return {
        task: toExternalTask(reconciled),
        outcome: ApplicationCommandRunOutcome.Executed,
        createdInAttempt: true,
      };
    }
  }

  private async enqueueNonDurableCreate<T>(
    teamName: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const previous = this.nonDurableTeamQueues.get(teamName) ?? Promise.resolve();
    const result = previous.then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined
    );
    this.nonDurableTeamQueues.set(teamName, tail);
    try {
      return await result;
    } finally {
      if (this.nonDurableTeamQueues.get(teamName) === tail) {
        this.nonDurableTeamQueues.delete(teamName);
      }
    }
  }
}

interface ResolvedDestination {
  record: TaskCreationRecord;
}

function findExistingDestination(
  destination: TaskBoardCreateTaskDestination,
  record: TaskCreationRecord
): ResolvedDestination | null {
  const byCommandId = destination.findById(record.commandId);
  const logicalMatches = [
    ...new Map(
      destination.findByIdempotencyKey(record.idempotencyKey).map((task) => [task.id, task])
    ).values(),
  ];
  if (logicalMatches.length > 1) {
    throw new TaskBoardCreateDestinationConflictError(
      new Error('Task creation idempotency key matches multiple destination tasks')
    );
  }
  const byIdempotencyKey = logicalMatches[0] ?? null;
  if (byCommandId && byIdempotencyKey && byCommandId.id !== byIdempotencyKey.id) {
    throw new TaskBoardCreateDestinationConflictError(
      new Error('Task creation command id and idempotency key match different destination tasks')
    );
  }
  const task = byCommandId ?? byIdempotencyKey;
  return task ? { record: { ...record, commandId: task.id } } : null;
}

class TaskBoardCreateOutcomeUnknownError extends Error {
  constructor(
    readonly createError: unknown,
    readonly reconciliationError: unknown
  ) {
    super('Task creation failed and the destination could not be reconciled');
    this.name = 'TaskBoardCreateOutcomeUnknownError';
  }
}

class TaskBoardCreateDestinationConflictError extends Error {
  constructor(readonly destinationError: unknown) {
    super('Task creation conflicts with an existing destination task');
    this.name = 'TaskBoardCreateDestinationConflictError';
  }
}

function classifyCreateTaskError(error: unknown): { failureKind: ApplicationCommandFailureKind } {
  if (error instanceof TaskBoardCreateOutcomeUnknownError) {
    return { failureKind: ApplicationCommandFailureKind.UnknownAfterTimeout };
  }
  if (error instanceof TaskBoardCreateDestinationConflictError) {
    return { failureKind: ApplicationCommandFailureKind.Terminal };
  }
  if (isTerminalCreateTaskError(error)) {
    return { failureKind: ApplicationCommandFailureKind.Terminal };
  }
  return { failureKind: ApplicationCommandFailureKind.Retryable };
}

function isTerminalCreateTaskError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message === 'Missing subject' ||
    message.startsWith('Task creation command conflict:') ||
    message.startsWith('Circular dependency:') ||
    message.startsWith('Task not found:') ||
    message.includes('task owner')
  );
}

async function reconcileDestination(
  destination: TaskBoardCreateTaskDestination,
  record: TaskCreationRecord,
  payload: JsonObject
): Promise<TeamTask> {
  let task: TeamTask | null;
  try {
    task = await destination.reconcile(makeDestinationInput(record, payload));
  } catch (error) {
    if (isDestinationConflictError(error)) {
      throw new TaskBoardCreateDestinationConflictError(error);
    }
    throw error;
  }
  if (!task) {
    throw new Error(`Task disappeared during command reconciliation: ${record.commandId}`);
  }
  assertMatchingTask(task, record);
  return task;
}

function makeDestinationInput(
  record: TaskCreationRecord,
  payload: JsonObject
): Record<string, unknown> {
  return {
    ...payload,
    id: record.commandId,
    creationCommand: {
      namespace: record.namespace,
      scopeKey: record.scopeKey,
      operation: record.operation,
      commandId: record.commandId,
      payloadHash: record.payloadHash,
      idempotencyKey: record.idempotencyKey,
    },
  };
}

function assertMatchingTask(
  task: TeamTask,
  expected: {
    namespace: string;
    scopeKey: string;
    operation: string;
    commandId: string;
    payloadHash: string;
    idempotencyKey: string;
  }
): void {
  const creationCommand = (
    task as TeamTask & {
      creationCommand?: {
        namespace?: unknown;
        scopeKey?: unknown;
        operation?: unknown;
        commandId?: unknown;
        payloadHash?: unknown;
        idempotencyKey?: unknown;
      };
    }
  ).creationCommand;
  if (task.id !== expected.commandId) {
    throw new TaskBoardCreateDestinationConflictError(
      new Error(`Task command destination id conflict: ${task.id}`)
    );
  }
  if (
    !creationCommand ||
    creationCommand.namespace !== expected.namespace ||
    creationCommand.scopeKey !== expected.scopeKey ||
    creationCommand.operation !== expected.operation ||
    creationCommand.commandId !== expected.commandId ||
    creationCommand.payloadHash !== expected.payloadHash ||
    (creationCommand.idempotencyKey !== undefined &&
      creationCommand.idempotencyKey !== expected.idempotencyKey)
  ) {
    throw new TaskBoardCreateDestinationConflictError(
      new Error(`Task command destination provenance conflict: ${task.id}`)
    );
  }
}

function isDestinationConflictError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('Task creation command conflict:');
}

function makeStoredResult(task: TeamTask, created: boolean): JsonObject {
  return {
    task: toJsonValue(toExternalTask(task)),
    created,
  };
}

function toExternalTask(task: TeamTask): TeamTask {
  const { creationCommand: _creationCommand, ...externalTask } = task as TeamTask & {
    creationCommand?: unknown;
  };
  return externalTask;
}

function toJsonValue(value: unknown): ApplicationCommandJsonValue {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError('Task command result is not JSON serializable');
  }
  return JSON.parse(serialized) as ApplicationCommandJsonValue;
}

function toJsonObject(value: Record<string, unknown>): JsonObject {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new TypeError('Task create command payload must be a JSON object');
  }
  return value as JsonObject;
}

function readStoredResult(value: JsonObject): { task: TeamTask; created: boolean } {
  const task = value.task;
  if (
    !task ||
    Array.isArray(task) ||
    typeof task !== 'object' ||
    typeof task.id !== 'string' ||
    typeof task.subject !== 'string' ||
    typeof task.status !== 'string' ||
    typeof value.created !== 'boolean'
  ) {
    throw new TypeError('Stored task command result is invalid');
  }
  return { task: task as unknown as TeamTask, created: value.created };
}
