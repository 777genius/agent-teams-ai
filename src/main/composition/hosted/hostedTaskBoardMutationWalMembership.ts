import {
  type HostedTaskBoardDirectoryDescriptor,
  listHostedTaskBoardDirectoryNames,
} from './hostedTaskBoardDescriptorFs';
import {
  HOSTED_TASK_BOARD_MUTATION_MAX_DIRECTORY_ENTRIES,
  hostedTaskBoardMutationStageName,
  type HostedTaskBoardMutationWal,
} from './hostedTaskBoardMutationLedger';

export function taskStageArtifactNames(wal: HostedTaskBoardMutationWal): readonly string[] {
  const names = new Set<string>();
  wal.targets.forEach((target, index) => {
    if (target.parent !== 'tasks' || !target.preimage.exists) return;
    const stageName = hostedTaskBoardMutationStageName(wal.transactionId, index);
    names.add(stageName);
    names.add(`${stageName}.tmp`);
    names.add(`${stageName}.pin`);
  });
  return Object.freeze([...names].sort((left, right) => left.localeCompare(right)));
}

export async function stagedTaskNames(
  wal: HostedTaskBoardMutationWal,
  tasksDirectory: HostedTaskBoardDirectoryDescriptor,
  assertStillActive?: () => void
): Promise<readonly string[]> {
  const artifacts = taskStageArtifactNames(wal);
  if (artifacts.length === 0) return artifacts;
  const observed = await listHostedTaskBoardDirectoryNames(
    tasksDirectory,
    HOSTED_TASK_BOARD_MUTATION_MAX_DIRECTORY_ENTRIES + artifacts.length,
    assertStillActive
  );
  const known = new Set(artifacts);
  return Object.freeze(observed.filter((name) => known.has(name)));
}
