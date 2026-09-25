import {
  type HostedTaskBoardDirectoryDescriptor,
  type HostedTaskBoardFileSnapshot,
  listHostedTaskBoardDirectoryNames,
  readHostedTaskBoardFile,
} from './hostedTaskBoardDescriptorFs';
import { taskStageArtifactNames } from './hostedTaskBoardMutationWalMembership';
import { sameHostedTaskBoardWalDirectory } from './hostedTaskBoardMutationWalTargetLayout';

import type { HostedTaskBoardMutationWalHandle } from './hostedTaskBoardMutationTransaction';

const KANBAN_STATE_FILE = 'kanban-state.json';

export interface HostedTaskBoardCommittedTaskFile {
  readonly fileName: string;
  readonly rawTaskId: string;
  readonly text: string;
}

export interface HostedTaskBoardCommittedFiles {
  /** The real task directory listing and its budget, for the caller's final membership check. */
  readonly listedTaskNames: readonly string[];
  readonly listingBudget: number;
  readonly taskFiles: readonly HostedTaskBoardCommittedTaskFile[];
  readonly kanbanText: string | null;
  /** Every real file this read depended on; the caller revalidates them with the WAL snapshot. */
  readonly observed: readonly HostedTaskBoardFileSnapshot[];
}

/**
 * Reads the last committed board. Without a prepared WAL that is simply the files on disk. With
 * one, each WAL target must still hold its preimage, its postimage, or (mid-publication) nothing
 * where a preimage existed, and the board is projected from the recorded preimages: an
 * uncommitted transaction is never visible, whether it is live or was left by a crash. Any other
 * target content is a foreign edit and fails closed. This never writes and takes no lock, so a
 * stuck WAL keeps the board readable while recovery stays with the next real mutation.
 */
export async function readHostedTaskBoardCommittedFiles(input: {
  readonly wal: HostedTaskBoardMutationWalHandle | null;
  readonly teamDirectory: HostedTaskBoardDirectoryDescriptor;
  readonly tasksDirectory: HostedTaskBoardDirectoryDescriptor;
  readonly taskFilePattern: RegExp;
  readonly maxTaskFiles: number;
  readonly maxTaskFileBytes: number;
  readonly maxTaskSnapshotBytes: number;
  readonly maxKanbanBytes: number;
  readonly assertStillActive: () => void;
}): Promise<HostedTaskBoardCommittedFiles> {
  const { assertStillActive } = input;
  const prepared = input.wal?.wal.phase === 'prepared' ? input.wal.wal : null;
  const observed: HostedTaskBoardFileSnapshot[] = [];
  const committedTasks = new Map<string, string | null>();
  let committedKanban: string | null | undefined;
  if (prepared) {
    if (
      !sameHostedTaskBoardWalDirectory(prepared.scope.teamDirectory, input.teamDirectory) ||
      !sameHostedTaskBoardWalDirectory(prepared.scope.tasksDirectory, input.tasksDirectory)
    ) {
      throw new Error('hosted-task-board-read-wal-scope-substituted');
    }
    for (const target of prepared.targets) {
      const current = await readHostedTaskBoardFile(
        target.parent === 'team' ? input.teamDirectory : input.tasksDirectory,
        target.name,
        target.maximumBytes,
        { optional: true, assertStillActive }
      );
      observed.push(current);
      const atPreimage =
        current.exists === target.preimage.exists &&
        (!current.exists || !target.preimage.exists || current.text === target.preimage.text);
      const atPostimage = current.exists && current.text === target.postimage;
      const detached = target.preimage.exists && !current.exists;
      if (!atPreimage && !atPostimage && !detached) {
        throw new Error('hosted-task-board-read-wal-target-foreign');
      }
      const committed = target.preimage.exists ? target.preimage.text : null;
      if (target.kind === 'kanban') {
        if (target.parent !== 'team' || target.name !== KANBAN_STATE_FILE) {
          throw new Error('hosted-task-board-read-wal-target-invalid');
        }
        committedKanban = committed;
      } else if (target.kind === 'task') {
        if (target.parent !== 'tasks') throw new Error('hosted-task-board-read-wal-target-invalid');
        committedTasks.set(target.name, committed);
      }
    }
  }

  // Stage artifacts never match the task file pattern; they only widen the listing budget.
  const listingBudget =
    input.maxTaskFiles + (prepared ? taskStageArtifactNames(prepared).length : 0);
  const listedTaskNames = await listHostedTaskBoardDirectoryNames(
    input.tasksDirectory,
    listingBudget,
    assertStillActive
  );
  const names = new Set(listedTaskNames);
  for (const [name, committed] of committedTasks) {
    if (committed === null) names.delete(name);
    else names.add(name);
  }
  const taskFiles: HostedTaskBoardCommittedTaskFile[] = [];
  let totalBytes = 0;
  for (const fileName of [...names].sort((left, right) => left.localeCompare(right))) {
    const matched = input.taskFilePattern.exec(fileName);
    if (matched === null) continue;
    let text = committedTasks.get(fileName);
    if (typeof text !== 'string') {
      const snapshot = await readHostedTaskBoardFile(
        input.tasksDirectory,
        fileName,
        input.maxTaskFileBytes,
        { assertStillActive }
      );
      if (!snapshot.exists) throw new Error('hosted-task-board-read-task-raced');
      observed.push(snapshot);
      text = snapshot.text;
    }
    totalBytes += Buffer.byteLength(text, 'utf8');
    if (totalBytes > input.maxTaskSnapshotBytes) {
      throw new Error('hosted-task-board-read-source-budget-exceeded');
    }
    taskFiles.push(Object.freeze({ fileName, rawTaskId: matched[1], text }));
  }

  let kanbanText = committedKanban;
  if (kanbanText === undefined) {
    const kanban = await readHostedTaskBoardFile(
      input.teamDirectory,
      KANBAN_STATE_FILE,
      input.maxKanbanBytes,
      { optional: true, assertStillActive }
    );
    observed.push(kanban);
    kanbanText = kanban.exists ? kanban.text : null;
  }
  return Object.freeze({
    listedTaskNames,
    listingBudget,
    taskFiles: Object.freeze(taskFiles),
    kanbanText,
    observed: Object.freeze(observed),
  });
}
