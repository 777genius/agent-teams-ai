export function parseHostedTaskBoardMutationRelationships(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > 100) {
    throw new TypeError('hosted-task-board-mutation-relationship-invalid');
  }
  const entries = value.map((entry) => {
    if (typeof entry !== 'string' || entry.length < 1 || entry.length > 128) {
      throw new TypeError('hosted-task-board-mutation-relationship-invalid');
    }
    return entry;
  });
  if (new Set(entries).size !== entries.length) {
    throw new TypeError('hosted-task-board-mutation-relationship-invalid');
  }
  return Object.freeze(entries);
}

interface RelatedTask {
  readonly rawTaskId: string;
  readonly blockedBy: readonly string[];
  readonly blocks: readonly string[];
  readonly related: readonly string[];
}

export function assertHostedTaskBoardMutationRelationships<T extends RelatedTask>(
  documents: Iterable<T>
): void {
  const tasks = [...documents];
  const byRawTaskId = new Map(tasks.map((task) => [task.rawTaskId, task]));
  for (const task of tasks) {
    for (const otherId of task.blockedBy) {
      if (
        otherId === task.rawTaskId ||
        !byRawTaskId.get(otherId)?.blocks.includes(task.rawTaskId)
      ) {
        throw new TypeError('hosted-task-board-mutation-relationship-asymmetric');
      }
    }
    for (const otherId of task.blocks) {
      if (
        otherId === task.rawTaskId ||
        !byRawTaskId.get(otherId)?.blockedBy.includes(task.rawTaskId)
      ) {
        throw new TypeError('hosted-task-board-mutation-relationship-asymmetric');
      }
    }
    for (const otherId of task.related) {
      if (
        otherId === task.rawTaskId ||
        !byRawTaskId.get(otherId)?.related.includes(task.rawTaskId)
      ) {
        throw new TypeError('hosted-task-board-mutation-relationship-asymmetric');
      }
    }
  }
}
