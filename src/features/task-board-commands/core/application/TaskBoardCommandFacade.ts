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

export class TaskBoardCommandFacade {
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
      return this.createTaskWithoutDurableLedger(command, payload);
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
          const existing = command.destination.findById(record.commandId);
          if (!existing) {
            return {
              outcome: 'not_applied',
              message: 'Task destination does not contain the command task id',
            };
          }
          let reconciled: TeamTask;
          try {
            reconciled = await reconcileDestination(command.destination, record, payload);
          } catch (error) {
            if (error instanceof TaskBoardCreateDestinationConflictError) {
              return {
                outcome: 'not_applied',
                message: error.message,
              };
            }
            throw error;
          }
          return {
            outcome: 'applied',
            result: makeStoredResult(reconciled, false),
          };
        },
      },
      async (record) => {
        const existing = command.destination.findById(record.commandId);
        if (existing) {
          const reconciled = await reconcileDestination(command.destination, record, payload);
          return makeStoredResult(reconciled, false);
        }

        const destinationInput = makeDestinationInput(record, payload);
        try {
          await command.destination.create(destinationInput);
          const reconciled = await reconcileDestination(command.destination, record, payload);
          return makeStoredResult(reconciled, true);
        } catch (error) {
          let recovered: TeamTask | null;
          try {
            recovered = command.destination.findById(record.commandId);
          } catch (reconciliationError) {
            throw new TaskBoardCreateOutcomeUnknownError(error, reconciliationError);
          }
          if (recovered) {
            try {
              const reconciled = await reconcileDestination(command.destination, record, payload);
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
      payloadHash: this.options.hashPayload(payload),
    };
    const destinationInput = makeDestinationInput(commandRecord, payload);
    const existing = command.destination.findById(command.identity.commandId);
    if (existing) {
      const reconciled = await reconcileDestination(command.destination, commandRecord, payload);
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
      const recovered = command.destination.findById(command.identity.commandId);
      if (!recovered) {
        throw error;
      }
      const reconciled = await reconcileDestination(command.destination, commandRecord, payload);
      return {
        task: toExternalTask(reconciled),
        outcome: ApplicationCommandRunOutcome.Executed,
        createdInAttempt: true,
      };
    }
  }
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
  record: {
    namespace: string;
    scopeKey: string;
    operation: string;
    commandId: string;
    payloadHash: string;
  },
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
  record: {
    namespace: string;
    scopeKey: string;
    operation: string;
    commandId: string;
    payloadHash: string;
  },
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
    creationCommand.payloadHash !== expected.payloadHash
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
