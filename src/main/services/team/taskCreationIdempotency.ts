import type { TeamTask } from '@shared/types';

export function isControllerTaskNotFoundError(error: unknown, taskId: string): boolean {
  return error instanceof Error && error.message === `Task not found: ${taskId}`;
}

export function findTasksByCreationIdempotencyKey(
  activeTasks: readonly TeamTask[],
  deletedTasks: readonly TeamTask[],
  idempotencyKey: string
): TeamTask[] {
  return [...activeTasks, ...deletedTasks].filter(
    (task) =>
      (
        task as TeamTask & {
          creationCommand?: { idempotencyKey?: unknown };
        }
      ).creationCommand?.idempotencyKey === idempotencyKey
  );
}
