import {
  type HostedLifecycleCurrentAuthorityGateway,
  isHostedLifecycleWriterEpochCurrent,
  sameHostedLifecycleAuthorityEpoch,
} from '@features/internal-storage/contracts';
import { parseDeploymentId } from '@shared/contracts/hosted';

import {
  type HostedTaskBoardDirectoryDescriptor,
  readHostedTaskBoardFile,
} from './hostedTaskBoardDescriptorFs';
import {
  abortUnpublishedHostedTaskBoardMutationWal,
  type HostedTaskBoardMutationWal,
  type HostedTaskBoardMutationWalHandle,
  recoverHostedTaskBoardMutationWal,
} from './hostedTaskBoardMutationTransaction';

import type { ProductTaskRunPin } from './hostedTaskBoardMutationGrantAuthority';
import type { HostedTaskBoardMutationFence } from './hostedTaskBoardMutationLedger';

/** Product's deployment authority row: the same source Writer (W) currency decides from. */
export type HostedTaskBoardWriterEpochAuthority = Pick<
  HostedLifecycleCurrentAuthorityGateway,
  'lookupAuthority'
>;

/** True only when Product's current authority row is our epoch and no longer the WAL's. */
async function isWalWriterSuperseded(
  writerEpochs: HostedTaskBoardWriterEpochAuthority,
  walPin: ProductTaskRunPin,
  currentPin: ProductTaskRunPin
): Promise<boolean> {
  if (
    walPin.deploymentId !== currentPin.deploymentId ||
    sameHostedLifecycleAuthorityEpoch(walPin, currentPin)
  )
    return false;
  const authority = await writerEpochs.lookupAuthority(parseDeploymentId(walPin.deploymentId));
  // An absent row keeps every epoch current under W, so it can never prove supersession.
  return (
    authority !== null &&
    isHostedLifecycleWriterEpochCurrent(authority, currentPin) &&
    !isHostedLifecycleWriterEpochCurrent(authority, walPin)
  );
}

async function hasPublicationStarted(
  wal: HostedTaskBoardMutationWal,
  directories: Readonly<{
    teamDirectory: HostedTaskBoardDirectoryDescriptor;
    tasksDirectory: HostedTaskBoardDirectoryDescriptor;
  }>,
  assertStillActive: () => void
): Promise<boolean> {
  for (const target of wal.targets) {
    const observed = await readHostedTaskBoardFile(
      target.parent === 'team' ? directories.teamDirectory : directories.tasksDirectory,
      target.name,
      target.maximumBytes,
      { optional: true, assertStillActive }
    );
    if (observed.exists !== target.preimage.exists) return true;
    if (observed.exists && target.preimage.exists && observed.text !== target.preimage.text)
      return true;
  }
  return false;
}

/**
 * Resolves a prepared Product WAL left by a writer epoch that Product has since superseded,
 * so a crash followed by an epoch change cannot block the board forever. The caller must hold
 * the board fence (and, under Product, the shared task-write lock). A WAL from the same epoch,
 * another deployment, or without a run pin stays untouched: its writer may still be live, or its
 * authority cannot be proven stale. An unpublished WAL is aborted without touching board files;
 * one whose publication already began is rolled forward from its own recorded postimages.
 * Returns false when the WAL was left untouched, so the caller keeps failing closed.
 */
export async function takeOverSupersededHostedTaskBoardMutationWal(input: {
  readonly handle: HostedTaskBoardMutationWalHandle;
  readonly teamDirectory: HostedTaskBoardDirectoryDescriptor;
  readonly tasksDirectory: HostedTaskBoardDirectoryDescriptor;
  readonly fence: HostedTaskBoardMutationFence;
  readonly assertStillActive: () => void;
  readonly currentPin: ProductTaskRunPin | undefined;
  readonly writerEpochs: HostedTaskBoardWriterEpochAuthority | undefined;
  /** Rechecks the caller's own Product currency, as at every publication boundary. */
  readonly beforeCommitBoundary: () => Promise<void>;
}): Promise<boolean> {
  const walPin = input.handle.wal.productGrant?.runPin;
  if (input.handle.wal.phase !== 'prepared' || !walPin || !input.currentPin || !input.writerEpochs)
    return false;
  await input.beforeCommitBoundary();
  if (!(await isWalWriterSuperseded(input.writerEpochs, walPin, input.currentPin))) return false;
  const recovery = {
    handle: input.handle,
    teamDirectory: input.teamDirectory,
    tasksDirectory: input.tasksDirectory,
    fence: input.fence,
    assertStillActive: input.assertStillActive,
  };
  if (!(await hasPublicationStarted(input.handle.wal, input, input.assertStillActive))) {
    // A superseded writer's unpublished intent must never be committed on its behalf.
    return (await abortUnpublishedHostedTaskBoardMutationWal(recovery)).aborted;
  }
  await recoverHostedTaskBoardMutationWal({
    ...recovery,
    beforeCommitBoundary: input.beforeCommitBoundary,
  });
  return true;
}
