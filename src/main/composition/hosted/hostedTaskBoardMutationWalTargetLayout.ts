export const HOSTED_TASK_BOARD_MUTATION_LEDGER_FILE = 'hosted-task-board-mutation-ledger.v2.json';
const TASK_FILE = /^([A-Za-z0-9][A-Za-z0-9._-]{0,127})\.json$/;

interface WalTargetLayout {
  readonly kind: 'task' | 'kanban' | 'ledger';
  readonly parent: 'team' | 'tasks';
  readonly name: string;
}

export function sameHostedTaskBoardWalDirectory(
  expected: Readonly<{ canonicalPath: string; device: string; inode: string }>,
  actual: Readonly<{ identity: { canonicalPath: string; device: bigint; inode: bigint } }>
): boolean {
  return (
    expected.canonicalPath === actual.identity.canonicalPath &&
    expected.device === actual.identity.device.toString() &&
    expected.inode === actual.identity.inode.toString()
  );
}

export function sameHostedTaskBoardCreatedFileIdentity(
  snapshot: Readonly<{
    stamp: { durableIdentity: { dev: number; ino: number; birthtimeMs: number } };
  }>,
  created: Readonly<{ dev: number; ino: number; birthtimeMs?: number }>
): boolean {
  return (
    snapshot.stamp.durableIdentity.dev === created.dev &&
    snapshot.stamp.durableIdentity.ino === created.ino &&
    (created.birthtimeMs === undefined ||
      snapshot.stamp.durableIdentity.birthtimeMs === created.birthtimeMs)
  );
}

export function assertHostedTaskBoardMutationWalTargetLayout(
  targets: readonly WalTargetLayout[]
): void {
  if (targets.length < 2) {
    throw new TypeError('hosted-task-board-mutation-wal-target-layout-invalid');
  }
  const ledger = targets.at(-1);
  if (
    ledger === undefined ||
    ledger.kind !== 'ledger' ||
    ledger.parent !== 'team' ||
    ledger.name !== HOSTED_TASK_BOARD_MUTATION_LEDGER_FILE
  ) {
    throw new TypeError('hosted-task-board-mutation-wal-target-layout-invalid');
  }
  let sawKanban = false;
  let previousTaskName: string | null = null;
  for (const target of targets.slice(0, -1)) {
    if (target.kind === 'task') {
      if (
        sawKanban ||
        target.parent !== 'tasks' ||
        !TASK_FILE.test(target.name) ||
        (previousTaskName !== null && previousTaskName.localeCompare(target.name) >= 0)
      ) {
        throw new TypeError('hosted-task-board-mutation-wal-target-layout-invalid');
      }
      previousTaskName = target.name;
      continue;
    }
    if (
      target.kind !== 'kanban' ||
      sawKanban ||
      target.parent !== 'team' ||
      target.name !== 'kanban-state.json'
    ) {
      throw new TypeError('hosted-task-board-mutation-wal-target-layout-invalid');
    }
    sawKanban = true;
  }
}
