import {
  type HostedTaskBoardDirectoryDescriptor,
  type HostedTaskBoardFileSnapshot,
  listHostedTaskBoardDirectoryNames,
  readHostedTaskBoardFile,
} from './hostedTaskBoardDescriptorFs';

const KANBAN_STATE_FILE = 'kanban-state.json';

export interface HostedTaskBoardTaskFile {
  readonly fileName: string;
  readonly rawTaskId: string;
  readonly text: string;
}

export interface HostedTaskBoardFiles {
  /** The task directory listing and its budget, for the caller's final membership check. */
  readonly listedTaskNames: readonly string[];
  readonly listingBudget: number;
  readonly taskFiles: readonly HostedTaskBoardTaskFile[];
  readonly kanbanText: string | null;
  /** Every file this read depended on; the caller revalidates them before answering. */
  readonly observed: readonly HostedTaskBoardFileSnapshot[];
}

/**
 * Reads the board files as they are on disk, like desktop. Every writer (the hosted task command
 * and the agents) changes them through the controller under its board-state lock, one atomic
 * file at a time; the caller's final revalidation turns a read that raced a write into a retry.
 */
export async function readHostedTaskBoardFiles(input: {
  readonly teamDirectory: HostedTaskBoardDirectoryDescriptor;
  readonly tasksDirectory: HostedTaskBoardDirectoryDescriptor;
  readonly taskFilePattern: RegExp;
  readonly maxTaskFiles: number;
  readonly maxTaskFileBytes: number;
  readonly maxTaskSnapshotBytes: number;
  readonly maxKanbanBytes: number;
  readonly assertStillActive: () => void;
}): Promise<HostedTaskBoardFiles> {
  const { assertStillActive } = input;
  const observed: HostedTaskBoardFileSnapshot[] = [];
  const listingBudget = input.maxTaskFiles;
  const listedTaskNames = await listHostedTaskBoardDirectoryNames(
    input.tasksDirectory,
    listingBudget,
    assertStillActive
  );
  const taskFiles: HostedTaskBoardTaskFile[] = [];
  let totalBytes = 0;
  for (const fileName of [...listedTaskNames].sort((left, right) => left.localeCompare(right))) {
    const matched = input.taskFilePattern.exec(fileName);
    if (matched === null) continue;
    const snapshot = await readHostedTaskBoardFile(
      input.tasksDirectory,
      fileName,
      input.maxTaskFileBytes,
      { assertStillActive }
    );
    if (!snapshot.exists) throw new Error('hosted-task-board-read-task-raced');
    observed.push(snapshot);
    totalBytes += Buffer.byteLength(snapshot.text, 'utf8');
    if (totalBytes > input.maxTaskSnapshotBytes) {
      throw new Error('hosted-task-board-read-source-budget-exceeded');
    }
    taskFiles.push(Object.freeze({ fileName, rawTaskId: matched[1], text: snapshot.text }));
  }
  const kanban = await readHostedTaskBoardFile(
    input.teamDirectory,
    KANBAN_STATE_FILE,
    input.maxKanbanBytes,
    { optional: true, assertStillActive }
  );
  observed.push(kanban);
  return Object.freeze({
    listedTaskNames,
    listingBudget,
    taskFiles: Object.freeze(taskFiles),
    kanbanText: kanban.exists ? kanban.text : null,
    observed: Object.freeze(observed),
  });
}
