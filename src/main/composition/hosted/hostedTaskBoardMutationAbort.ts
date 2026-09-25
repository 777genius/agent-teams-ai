import * as fs from 'node:fs';

import {
  descriptorChildPath,
  type HostedTaskBoardDirectoryDescriptor,
  type HostedTaskBoardFileSnapshot,
  readHostedTaskBoardFile,
  revalidateHostedTaskBoardSnapshots,
  syncHostedTaskBoardDirectory,
} from './hostedTaskBoardDescriptorFs';
import {
  hostedTaskBoardMutationStageName,
  type HostedTaskBoardMutationWal,
} from './hostedTaskBoardMutationLedger';

type ExistingSnapshot = Extract<HostedTaskBoardFileSnapshot, { readonly exists: true }>;
type Directories = Readonly<{
  teamDirectory: HostedTaskBoardDirectoryDescriptor;
  tasksDirectory: HostedTaskBoardDirectoryDescriptor;
}>;

function parentFor(
  parent: 'team' | 'tasks',
  directories: Directories
): HostedTaskBoardDirectoryDescriptor {
  return parent === 'team' ? directories.teamDirectory : directories.tasksDirectory;
}

/** Only a Product-fenced transaction with no published target can become aborted. */
export async function verifyAbortableProductTaskWal(
  wal: HostedTaskBoardMutationWal,
  directories: Directories,
  assertStillActive?: () => void
): Promise<{
  readonly stage: ExistingSnapshot | null;
  readonly parent: HostedTaskBoardDirectoryDescriptor;
} | null> {
  const first = wal.targets[0];
  // Targets publish in order, so only the first one can hold a stage while none is published.
  if (wal.phase !== 'prepared' || !wal.productGrant || first === undefined) return null;
  for (const target of wal.targets) {
    const observed = await readHostedTaskBoardFile(
      parentFor(target.parent, directories),
      target.name,
      target.maximumBytes,
      { optional: true, assertStillActive }
    );
    if (observed.exists !== target.preimage.exists) return null;
    if (observed.exists && target.preimage.exists) {
      const expected = target.preimage.stamp;
      const actual = observed.stamp;
      if (
        observed.text !== target.preimage.text ||
        actual.device.toString() !== expected.device ||
        actual.inode.toString() !== expected.inode ||
        actual.durableIdentity.dev !== expected.durableDevice ||
        actual.durableIdentity.ino !== expected.durableInode ||
        actual.durableIdentity.birthtimeMs !== expected.birthtimeMs
      )
        return null;
    }
  }
  const parent = parentFor(first.parent, directories);
  const stageName = hostedTaskBoardMutationStageName(wal.transactionId, 0);
  const [stage, pin, temporary] = await Promise.all([
    readHostedTaskBoardFile(parent, stageName, first.maximumBytes, {
      optional: true,
      assertStillActive,
    }),
    readHostedTaskBoardFile(parent, `${stageName}.pin`, first.maximumBytes, {
      optional: true,
      assertStillActive,
    }),
    readHostedTaskBoardFile(parent, `${stageName}.tmp`, first.maximumBytes, {
      optional: true,
      assertStillActive,
    }),
  ]);
  if (pin.exists || temporary.exists || (stage.exists && stage.text !== first.postimage))
    return null;
  return { stage: stage.exists ? stage : null, parent };
}

export async function discardAbortedProductTaskStage(
  stage: ExistingSnapshot | null,
  parent: HostedTaskBoardDirectoryDescriptor,
  assertStillActive?: () => void
): Promise<void> {
  if (!stage) return;
  await revalidateHostedTaskBoardSnapshots([parent], [stage], assertStillActive);
  await fs.promises.unlink(descriptorChildPath(parent, stage.name));
  await syncHostedTaskBoardDirectory(parent, assertStillActive);
}

export async function prepareAbortableProductTaskWal(
  wal: HostedTaskBoardMutationWal,
  directories: Directories,
  assertStillActive?: () => void
): Promise<boolean> {
  const first = await verifyAbortableProductTaskWal(wal, directories, assertStillActive);
  if (!first) return false;
  await discardAbortedProductTaskStage(first.stage, first.parent, assertStillActive);
  const final = await verifyAbortableProductTaskWal(wal, directories, assertStillActive);
  if (!final || final.stage) throw new Error('hosted-task-board-mutation-abort-raced');
  return true;
}
