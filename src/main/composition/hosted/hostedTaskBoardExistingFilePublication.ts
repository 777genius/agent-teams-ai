import * as fs from 'node:fs';

import {
  descriptorChildPath,
  HostedTaskBoardDescriptorFsError,
  type HostedTaskBoardDirectoryDescriptor,
  type HostedTaskBoardFileSnapshot,
  type HostedTaskBoardPersistedFileStamp,
  isHostedTaskBoardChildName,
  matchesHostedTaskBoardPreimageAfterRename,
  readHostedTaskBoardFile,
  revalidateHostedTaskBoardDirectories,
  sameHostedTaskBoardFileStamp,
  serializeHostedTaskBoardPersistedFileStamp,
} from './hostedTaskBoardDescriptorFs';

export type HostedTaskBoardExistingFilePublicationCheckpoint =
  | 'existing_target_postimage_ready'
  | 'existing_target_precommit_validated'
  | 'existing_target_preimage_detached'
  | 'existing_target_replaced';

interface ExistingFilePublicationInput {
  readonly parent: HostedTaskBoardDirectoryDescriptor;
  readonly name: string;
  readonly stageName: string;
  readonly postimage: string;
  readonly maximumBytes: number;
  readonly assertStillActive?: () => void;
}

function optionalReader(input: ExistingFilePublicationInput) {
  return (name: string) =>
    readHostedTaskBoardFile(input.parent, name, input.maximumBytes, {
      optional: true,
      assertStillActive: input.assertStillActive,
    });
}

function samePersistedFileObject(
  expected: HostedTaskBoardPersistedFileStamp,
  actual: Extract<HostedTaskBoardFileSnapshot, { readonly exists: true }>['stamp']
): boolean {
  return (
    expected.device === actual.device.toString() &&
    expected.inode === actual.inode.toString() &&
    expected.durableDevice === actual.durableIdentity.dev &&
    expected.durableInode === actual.durableIdentity.ino &&
    expected.birthtimeMs === actual.durableIdentity.birthtimeMs
  );
}

function sameRuntimeFileObject(
  left: Extract<HostedTaskBoardFileSnapshot, { readonly exists: true }>['stamp'],
  right: Extract<HostedTaskBoardFileSnapshot, { readonly exists: true }>['stamp']
): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.durableIdentity.dev === right.durableIdentity.dev &&
    left.durableIdentity.ino === right.durableIdentity.ino &&
    left.durableIdentity.birthtimeMs === right.durableIdentity.birthtimeMs
  );
}

async function restorePinnedProviderWrite(input: {
  readonly publication: ExistingFilePublicationInput;
  readonly stage: Extract<HostedTaskBoardFileSnapshot, { readonly exists: true }>;
  readonly pin: Extract<HostedTaskBoardFileSnapshot, { readonly exists: true }>;
}): Promise<void> {
  const { publication, stage, pin } = input;
  const read = optionalReader(publication);
  const target = await read(publication.name);
  if (
    !target.exists ||
    target.text !== publication.postimage ||
    !sameRuntimeFileObject(stage.stamp, target.stamp)
  ) {
    throw new HostedTaskBoardDescriptorFsError('hosted-task-board-descriptor-file-raced');
  }
  const targetPath = descriptorChildPath(publication.parent, publication.name);
  let targetRemoved = false;
  try {
    await fs.promises.unlink(targetPath);
    targetRemoved = true;
    try {
      await fs.promises.link(descriptorChildPath(publication.parent, pin.name), targetPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      throw new HostedTaskBoardDescriptorFsError('hosted-task-board-descriptor-file-raced');
    }
    await publication.parent.handle.sync();
    targetRemoved = false;
    await Promise.all(
      [stage.name, pin.name].map((name) =>
        fs.promises.unlink(descriptorChildPath(publication.parent, name))
      )
    );
    await publication.parent.handle.sync();
  } catch (error) {
    if (targetRemoved) {
      await fs.promises
        .link(descriptorChildPath(publication.parent, stage.name), targetPath)
        .catch((restoreError: NodeJS.ErrnoException) => {
          if (restoreError.code !== 'EEXIST') throw restoreError;
        });
      await publication.parent.handle.sync().catch(() => undefined);
    }
    throw error;
  }
}

async function clearPublicationArtifacts(
  input: ExistingFilePublicationInput & {
    readonly preimage: {
      readonly text: string;
      readonly stamp: HostedTaskBoardPersistedFileStamp;
    };
  }
): Promise<void> {
  const read = optionalReader(input);
  const [stage, pin] = await Promise.all([read(input.stageName), read(`${input.stageName}.pin`)]);
  if (stage.exists && stage.text !== input.postimage) {
    throw new HostedTaskBoardDescriptorFsError('hosted-task-board-descriptor-stage-substituted');
  }
  if (
    pin.exists &&
    (pin.text !== input.preimage.text ||
      !matchesHostedTaskBoardPreimageAfterRename(input.preimage.stamp, pin.stamp))
  ) {
    if (!stage.exists || !samePersistedFileObject(input.preimage.stamp, pin.stamp)) {
      throw new HostedTaskBoardDescriptorFsError('hosted-task-board-descriptor-stage-substituted');
    }
    await restorePinnedProviderWrite({ publication: input, stage, pin });
    throw new HostedTaskBoardDescriptorFsError('hosted-task-board-descriptor-file-raced');
  }
  for (const artifact of [stage, pin]) {
    if (artifact.exists) await fs.promises.unlink(descriptorChildPath(input.parent, artifact.name));
  }
  if (stage.exists || pin.exists) await input.parent.handle.sync();
}

export async function recoverHostedTaskBoardExistingFilePublication(
  input: ExistingFilePublicationInput & {
    readonly preimage: {
      readonly text: string;
      readonly stamp: HostedTaskBoardPersistedFileStamp;
    };
  }
): Promise<void> {
  const read = optionalReader(input);
  const target = await read(input.name);
  if (target.exists && target.text === input.postimage) {
    await clearPublicationArtifacts(input);
    return;
  }
  const [stage, pin] = await Promise.all([read(input.stageName), read(`${input.stageName}.pin`)]);
  if (
    target.exists ||
    !stage.exists ||
    stage.text !== input.postimage ||
    !pin.exists ||
    pin.text !== input.preimage.text ||
    !matchesHostedTaskBoardPreimageAfterRename(input.preimage.stamp, pin.stamp)
  ) {
    throw new HostedTaskBoardDescriptorFsError('hosted-task-board-descriptor-stage-substituted');
  }
  try {
    await fs.promises.link(
      descriptorChildPath(input.parent, input.stageName),
      descriptorChildPath(input.parent, input.name)
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new HostedTaskBoardDescriptorFsError('hosted-task-board-descriptor-file-raced');
    }
    throw error;
  }
  await input.parent.handle.sync();
  const published = await read(input.name);
  if (!published.exists || published.text !== input.postimage) {
    throw new HostedTaskBoardDescriptorFsError('hosted-task-board-descriptor-stage-substituted');
  }
  await clearPublicationArtifacts(input);
}

export async function publishHostedTaskBoardExistingFile(
  input: ExistingFilePublicationInput & {
    readonly expected: Extract<HostedTaskBoardFileSnapshot, { readonly exists: true }>;
    readonly beforeFinalValidation?: () => Promise<void> | void;
    readonly beforeCommit: () => Promise<void>;
    readonly beforeTargetDetach?: () => Promise<void> | void;
    readonly beforeTargetLink?: () => Promise<void> | void;
    readonly onPublicationCheckpoint?: (
      checkpoint: HostedTaskBoardExistingFilePublicationCheckpoint
    ) => Promise<void> | void;
  }
): Promise<void> {
  if (
    !isHostedTaskBoardChildName(input.name) ||
    !isHostedTaskBoardChildName(input.stageName) ||
    input.expected.parent !== input.parent ||
    input.expected.name !== input.name ||
    !Number.isSafeInteger(input.maximumBytes) ||
    input.maximumBytes < 1 ||
    Buffer.byteLength(input.postimage, 'utf8') < 1 ||
    Buffer.byteLength(input.postimage, 'utf8') > input.maximumBytes
  ) {
    throw new HostedTaskBoardDescriptorFsError('hosted-task-board-descriptor-stage-invalid');
  }
  const temporaryName = `${input.stageName}.tmp`;
  const pinName = `${input.stageName}.pin`;
  if (!isHostedTaskBoardChildName(temporaryName)) {
    throw new HostedTaskBoardDescriptorFsError('hosted-task-board-descriptor-stage-invalid');
  }
  const childPath = (name: string) => descriptorChildPath(input.parent, name);
  const stagePath = childPath(input.stageName);
  const temporaryPath = childPath(temporaryName);
  const expectedStamp = serializeHostedTaskBoardPersistedFileStamp(input.expected.stamp);
  const readStage = optionalReader(input);
  const assertPostimage = (
    snapshot: HostedTaskBoardFileSnapshot
  ): Extract<HostedTaskBoardFileSnapshot, { readonly exists: true }> => {
    if (!snapshot.exists || snapshot.text !== input.postimage) {
      throw new HostedTaskBoardDescriptorFsError('hosted-task-board-descriptor-stage-substituted');
    }
    return snapshot;
  };
  const discard = async (name: string) => {
    await revalidateHostedTaskBoardDirectories([input.parent], input.assertStillActive);
    try {
      const artifact = await fs.promises.lstat(childPath(name), { bigint: true });
      if (artifact.isDirectory()) {
        throw new HostedTaskBoardDescriptorFsError(
          'hosted-task-board-descriptor-stage-substituted'
        );
      }
      await fs.promises.unlink(childPath(name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  };
  let stage = await readStage(input.stageName);
  if (stage.exists) stage = assertPostimage(stage);
  if (!stage.exists) {
    await discard(temporaryName);
    let temporary: fs.promises.FileHandle | null = null;
    try {
      temporary = await fs.promises.open(temporaryPath, 'wx', 0o600);
      await temporary.writeFile(input.postimage, 'utf8');
      await temporary.sync();
      await fs.promises.link(temporaryPath, stagePath);
      await input.parent.handle.sync();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    } finally {
      await temporary?.close().catch(() => undefined);
    }
    stage = assertPostimage(await readStage(input.stageName));
  }
  await discard(temporaryName);
  const initialStage = assertPostimage(await readStage(input.stageName));
  if ((await readStage(pinName)).exists) {
    throw new HostedTaskBoardDescriptorFsError('hosted-task-board-descriptor-stage-substituted');
  }
  await input.beforeFinalValidation?.();
  const finalStage = assertPostimage(await readStage(input.stageName));
  if (!sameHostedTaskBoardFileStamp(initialStage.stamp, finalStage.stamp)) {
    throw new HostedTaskBoardDescriptorFsError('hosted-task-board-descriptor-stage-substituted');
  }
  await input.onPublicationCheckpoint?.('existing_target_postimage_ready');
  await input.beforeCommit();
  await input.onPublicationCheckpoint?.('existing_target_precommit_validated');
  input.assertStillActive?.();
  if ((await readStage(pinName)).exists) {
    throw new HostedTaskBoardDescriptorFsError('hosted-task-board-descriptor-stage-substituted');
  }
  await input.beforeTargetDetach?.();
  try {
    await fs.promises.rename(childPath(input.name), childPath(pinName));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new HostedTaskBoardDescriptorFsError('hosted-task-board-descriptor-file-raced');
    }
    throw error;
  }
  try {
    const pinned = await readStage(pinName);
    if (!pinned.exists || !matchesHostedTaskBoardPreimageAfterRename(expectedStamp, pinned.stamp)) {
      throw new HostedTaskBoardDescriptorFsError('hosted-task-board-descriptor-stage-substituted');
    }
  } catch (error) {
    try {
      await fs.promises.link(childPath(pinName), childPath(input.name));
      await fs.promises.unlink(childPath(pinName));
      await input.parent.handle.sync();
    } catch {
      // Best-effort rollback preserves the original publish error.
    }
    throw error;
  }
  await input.parent.handle.sync();
  await input.onPublicationCheckpoint?.('existing_target_preimage_detached');
  await input.beforeTargetLink?.();
  try {
    await fs.promises.link(stagePath, childPath(input.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new HostedTaskBoardDescriptorFsError('hosted-task-board-descriptor-file-raced');
    }
    throw error;
  }
  await input.onPublicationCheckpoint?.('existing_target_replaced');
  await input.parent.handle.sync();
  await clearPublicationArtifacts({
    ...input,
    preimage: { text: input.expected.text, stamp: expectedStamp },
  });
}
