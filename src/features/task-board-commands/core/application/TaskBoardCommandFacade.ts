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
  create(input: Record<string, unknown>): TeamTask;
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

export class TaskBoardCommandFacade {
  constructor(private readonly runner: ApplicationCommandRunner) {}

  async createTask(command: TaskBoardCreateTaskCommand): Promise<TaskBoardCreateTaskCommandResult> {
    if (!looksLikeCanonicalTaskId(command.identity.commandId)) {
      throw new TypeError('Task create commandId must be a UUID');
    }
    const payload = toJsonObject(command.payload);
    const run = await this.runner.run<JsonObject, typeof CREATE_TASK_OPERATION>(
      {
        namespace: TASK_BOARD_COMMAND_NAMESPACE,
        scopeKey: command.teamName,
        commandId: command.identity.commandId,
        idempotencyKey: command.identity.idempotencyKey,
        operation: CREATE_TASK_OPERATION,
        payload,
        classifyError: classifyCreateTaskError,
        reconcile: (record) => {
          const existing = command.destination.findById(record.commandId);
          if (!existing) {
            return Promise.resolve({
              outcome: 'not_applied',
              message: 'Task destination does not contain the command task id',
            });
          }
          assertMatchingTask(existing, record.commandId, payload);
          return Promise.resolve({
            outcome: 'applied',
            result: makeStoredResult(existing, false),
          });
        },
      },
      async (record) => {
        const existing = command.destination.findById(record.commandId);
        if (existing) {
          assertMatchingTask(existing, record.commandId, payload);
          return makeStoredResult(existing, false);
        }

        try {
          const task = command.destination.create({
            ...payload,
            id: record.commandId,
          });
          return makeStoredResult(task, true);
        } catch (error) {
          let recovered: TeamTask | null;
          try {
            recovered = command.destination.findById(record.commandId);
          } catch (reconciliationError) {
            throw new TaskBoardCreateOutcomeUnknownError(error, reconciliationError);
          }
          if (recovered) {
            assertMatchingTask(recovered, record.commandId, payload);
            return makeStoredResult(recovered, true);
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

function classifyCreateTaskError(error: unknown): { failureKind: ApplicationCommandFailureKind } {
  if (error instanceof TaskBoardCreateOutcomeUnknownError) {
    return { failureKind: ApplicationCommandFailureKind.UnknownAfterTimeout };
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
    message.startsWith('Circular dependency:') ||
    message.startsWith('Task not found:') ||
    message.includes('task owner')
  );
}

function assertMatchingTask(task: TeamTask, expectedId: string, payload: JsonObject): void {
  if (task.id !== expectedId) {
    throw new Error(`Task command destination id conflict: ${task.id}`);
  }
  if (typeof payload.subject !== 'string' || task.subject !== payload.subject.trim()) {
    throw new Error(`Task command destination payload conflict: ${task.id}`);
  }
}

function makeStoredResult(task: TeamTask, created: boolean): JsonObject {
  return {
    task: toJsonValue(task),
    created,
  };
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
