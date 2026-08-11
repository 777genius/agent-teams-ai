import { randomUUID } from 'node:crypto';

// eslint-disable-next-line no-restricted-imports -- Transaction mechanics use the feature public contract.
import {
  type HostedTaskMutationCommand,
  type HostedTaskMutationCommittedReceipt,
} from '@features/team-task-board/main/hosted';
import { atomicCreateAsync } from '@main/utils/atomicWrite';
import { atomicReplaceFileIfUnchangedAsync } from '@main/utils/durablePathOperations';

import {
  descriptorChildPath,
  type HostedTaskBoardDirectoryDescriptor,
  type HostedTaskBoardFileSnapshot,
  listHostedTaskBoardDirectoryNames,
  matchesHostedTaskBoardPersistedFileStamp,
  readHostedTaskBoardFile,
  revalidateHostedTaskBoardDirectories,
  revalidateHostedTaskBoardDirectoryMembership,
  revalidateHostedTaskBoardSnapshots,
} from './hostedTaskBoardDescriptorFs';
import {
  type HostedTaskBoardExistingFilePublicationCheckpoint,
  publishHostedTaskBoardExistingFile,
  recoverHostedTaskBoardExistingFilePublication,
} from './hostedTaskBoardExistingFilePublication';
import {
  assertHostedTaskBoardMutationWalTargetLayout,
  HOSTED_TASK_BOARD_MUTATION_FENCE_FILE,
  HOSTED_TASK_BOARD_MUTATION_MAX_DIRECTORY_ENTRIES,
  HOSTED_TASK_BOARD_MUTATION_MAX_WAL_BYTES,
  HostedTaskBoardMutationFence,
  type HostedTaskBoardMutationPublishKind,
  hostedTaskBoardMutationStageName,
  type HostedTaskBoardMutationWal,
  hostedTaskBoardMutationWalByteLength,
  type HostedTaskBoardMutationWalDirectoryIdentity,
  type HostedTaskBoardMutationWalGuard,
  type HostedTaskBoardMutationWalParent,
  type HostedTaskBoardMutationWalTarget,
  normalizeHostedTaskBoardMutationWalNames,
  parseHostedTaskBoardMutationWal,
  serializeHostedTaskBoardMutationWal,
  serializeHostedTaskBoardMutationWalDirectory,
  serializeHostedTaskBoardMutationWalGuardPreimage,
  serializeHostedTaskBoardMutationWalPreimage,
  serializeHostedTaskBoardMutationWalReceipt,
  validHostedTaskBoardMutationWalName,
} from './hostedTaskBoardMutationLedger';

export const HOSTED_TASK_BOARD_MUTATION_WAL_FILE = 'hosted-task-board-mutation.wal.v1.json';
const MAX_WAL_BYTES = HOSTED_TASK_BOARD_MUTATION_MAX_WAL_BYTES;
const MAX_DIRECTORY_ENTRIES = HOSTED_TASK_BOARD_MUTATION_MAX_DIRECTORY_ENTRIES;
type ParentKind = HostedTaskBoardMutationWalParent;
type PersistedDirectoryIdentity = HostedTaskBoardMutationWalDirectoryIdentity;

export type {
  HostedTaskBoardMutationPublishKind,
  HostedTaskBoardMutationWal,
} from './hostedTaskBoardMutationLedger';

export interface HostedTaskBoardMutationTarget {
  readonly kind: HostedTaskBoardMutationPublishKind;
  readonly parent: ParentKind;
  readonly name: string;
  readonly snapshot: HostedTaskBoardFileSnapshot;
  readonly postimage: string;
}

export interface HostedTaskBoardMutationGuard {
  readonly parent: ParentKind;
  readonly snapshot: HostedTaskBoardFileSnapshot;
}

export interface HostedTaskBoardMutationWalHandle {
  readonly wal: HostedTaskBoardMutationWal;
  readonly snapshot: Extract<HostedTaskBoardFileSnapshot, { readonly exists: true }>;
}

export interface HostedTaskBoardMutationWalObservation {
  readonly handle: HostedTaskBoardMutationWalHandle | null;
  readonly snapshot: HostedTaskBoardFileSnapshot;
}

export class HostedTaskBoardMutationTransactionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostedTaskBoardMutationTransactionError';
  }
}

const transactionError = (message: string) => new HostedTaskBoardMutationTransactionError(message);

function sameDirectory(
  expected: PersistedDirectoryIdentity,
  actual: HostedTaskBoardDirectoryDescriptor
): boolean {
  return (
    expected.canonicalPath === actual.identity.canonicalPath &&
    expected.device === actual.identity.device.toString() &&
    expected.inode === actual.identity.inode.toString()
  );
}

function parentFor(
  target: HostedTaskBoardMutationWalTarget,
  directories: {
    readonly teamDirectory: HostedTaskBoardDirectoryDescriptor;
    readonly tasksDirectory: HostedTaskBoardDirectoryDescriptor;
  }
): HostedTaskBoardDirectoryDescriptor {
  return target.parent === 'team' ? directories.teamDirectory : directories.tasksDirectory;
}

function guardMatchesSnapshot(
  guard: HostedTaskBoardMutationWalGuard,
  snapshot: HostedTaskBoardFileSnapshot
): boolean {
  if (guard.preimage.exists !== snapshot.exists) return false;
  return (
    !guard.preimage.exists ||
    (snapshot.exists &&
      matchesHostedTaskBoardPersistedFileStamp(guard.preimage.stamp, snapshot.stamp))
  );
}

async function assertWalGuards(
  wal: HostedTaskBoardMutationWal,
  directories: {
    readonly teamDirectory: HostedTaskBoardDirectoryDescriptor;
    readonly tasksDirectory: HostedTaskBoardDirectoryDescriptor;
  },
  assertStillActive?: () => void
): Promise<void> {
  const snapshots = await Promise.all(
    wal.guards.map((guard) =>
      readHostedTaskBoardFile(
        guard.parent === 'team' ? directories.teamDirectory : directories.tasksDirectory,
        guard.name,
        guard.maximumBytes,
        { optional: true, assertStillActive }
      )
    )
  );
  if (snapshots.some((snapshot, index) => !guardMatchesSnapshot(wal.guards[index], snapshot))) {
    throw new HostedTaskBoardMutationTransactionError('hosted-task-board-mutation-wal-guard-raced');
  }
}

function targetMatchesPreimage(
  target: HostedTaskBoardMutationWalTarget,
  snapshot: HostedTaskBoardFileSnapshot
): boolean {
  if (target.preimage.exists !== snapshot.exists) return false;
  if (!target.preimage.exists || !snapshot.exists) return true;
  return (
    target.preimage.text === snapshot.text &&
    matchesHostedTaskBoardPersistedFileStamp(target.preimage.stamp, snapshot.stamp)
  );
}

function targetMatchesPostimage(
  target: HostedTaskBoardMutationWalTarget,
  snapshot: HostedTaskBoardFileSnapshot
): boolean {
  return snapshot.exists && snapshot.text === target.postimage;
}

function taskStageArtifactNames(wal: HostedTaskBoardMutationWal): readonly string[] {
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

async function stagedTaskNames(
  wal: HostedTaskBoardMutationWal,
  directories: {
    readonly teamDirectory: HostedTaskBoardDirectoryDescriptor;
    readonly tasksDirectory: HostedTaskBoardDirectoryDescriptor;
  },
  assertStillActive?: () => void
): Promise<readonly string[]> {
  const artifacts = taskStageArtifactNames(wal);
  if (artifacts.length === 0) return artifacts;
  const observed = await listHostedTaskBoardDirectoryNames(
    directories.tasksDirectory,
    MAX_DIRECTORY_ENTRIES + artifacts.length,
    assertStillActive
  );
  const known = new Set(artifacts);
  return Object.freeze(observed.filter((name) => known.has(name)));
}

function sameCreateIdentity(
  snapshot: Extract<HostedTaskBoardFileSnapshot, { readonly exists: true }>,
  created: { readonly dev: number; readonly ino: number; readonly birthtimeMs: number }
): boolean {
  return (
    snapshot.stamp.durableIdentity.dev === created.dev &&
    snapshot.stamp.durableIdentity.ino === created.ino &&
    snapshot.stamp.durableIdentity.birthtimeMs === created.birthtimeMs
  );
}

export async function observeHostedTaskBoardMutationWal(
  teamDirectory: HostedTaskBoardDirectoryDescriptor,
  assertStillActive?: () => void
): Promise<HostedTaskBoardMutationWalObservation> {
  const snapshot = await readHostedTaskBoardFile(
    teamDirectory,
    HOSTED_TASK_BOARD_MUTATION_WAL_FILE,
    MAX_WAL_BYTES,
    { optional: true, assertStillActive }
  );
  if (!snapshot.exists) return Object.freeze({ handle: null, snapshot });
  return Object.freeze({
    handle: Object.freeze({
      wal: parseHostedTaskBoardMutationWal(JSON.parse(snapshot.text)),
      snapshot,
    }),
    snapshot,
  });
}

export async function readHostedTaskBoardMutationWal(
  teamDirectory: HostedTaskBoardDirectoryDescriptor,
  assertStillActive?: () => void
): Promise<HostedTaskBoardMutationWalHandle | null> {
  return (await observeHostedTaskBoardMutationWal(teamDirectory, assertStillActive)).handle;
}

export function createHostedTaskBoardMutationWal(input: {
  readonly nowMs: number;
  readonly command: HostedTaskMutationCommand;
  readonly payloadFingerprint: string;
  readonly fence: HostedTaskBoardMutationFence;
  readonly teamDirectory: HostedTaskBoardDirectoryDescriptor;
  readonly tasksDirectory: HostedTaskBoardDirectoryDescriptor;
  readonly taskDirectoryNames: readonly string[];
  readonly guards: readonly HostedTaskBoardMutationGuard[];
  readonly targets: readonly HostedTaskBoardMutationTarget[];
  readonly finalReceipt: HostedTaskMutationCommittedReceipt;
}): HostedTaskBoardMutationWal {
  if (
    !Number.isSafeInteger(input.nowMs) ||
    input.nowMs < 0 ||
    !/^[A-Za-z0-9_-]{32,128}$/.test(input.payloadFingerprint) ||
    input.targets.length < 2 ||
    input.targets.length > MAX_DIRECTORY_ENTRIES + 2
  ) {
    throw new TypeError('hosted-task-board-mutation-wal-create-invalid');
  }
  const targetKeys = new Set(input.targets.map((target) => `${target.parent}\u0000${target.name}`));
  if (
    targetKeys.size !== input.targets.length ||
    input.targets.filter((target) => target.kind === 'ledger').length !== 1 ||
    input.finalReceipt.commandId !== input.command.commandId ||
    input.finalReceipt.teamId !== input.command.teamId ||
    input.finalReceipt.sourceGeneration !== input.command.expectedSourceGeneration
  ) {
    throw new TypeError('hosted-task-board-mutation-wal-create-invalid');
  }
  const targets = input.targets.map((target) => {
    if (
      (target.parent !== 'team' && target.parent !== 'tasks') ||
      target.snapshot.parent !==
        (target.parent === 'team' ? input.teamDirectory : input.tasksDirectory) ||
      !validHostedTaskBoardMutationWalName(target.name) ||
      !Number.isSafeInteger(target.snapshot.maximumBytes) ||
      target.snapshot.maximumBytes < 1 ||
      target.snapshot.maximumBytes > MAX_WAL_BYTES ||
      hostedTaskBoardMutationWalByteLength(target.postimage) < 1 ||
      hostedTaskBoardMutationWalByteLength(target.postimage) > target.snapshot.maximumBytes ||
      (target.snapshot.exists &&
        hostedTaskBoardMutationWalByteLength(target.snapshot.text) > target.snapshot.maximumBytes)
    ) {
      throw new TypeError('hosted-task-board-mutation-wal-create-invalid');
    }
    return Object.freeze({
      kind: target.kind,
      parent: target.parent,
      name: target.name,
      maximumBytes: target.snapshot.maximumBytes,
      preimage: serializeHostedTaskBoardMutationWalPreimage(target.snapshot),
      postimage: target.postimage,
    });
  });
  const publishedTargetKeys = new Set(
    targets.map((target) => `${target.parent}\u0000${target.name}`)
  );
  const guards = input.guards.map((guard) => {
    if (
      (guard.parent !== 'team' && guard.parent !== 'tasks') ||
      guard.snapshot.parent !==
        (guard.parent === 'team' ? input.teamDirectory : input.tasksDirectory) ||
      !validHostedTaskBoardMutationWalName(guard.snapshot.name) ||
      !Number.isSafeInteger(guard.snapshot.maximumBytes) ||
      guard.snapshot.maximumBytes < 1 ||
      guard.snapshot.maximumBytes > MAX_WAL_BYTES ||
      publishedTargetKeys.has(`${guard.parent}\u0000${guard.snapshot.name}`)
    ) {
      throw new TypeError('hosted-task-board-mutation-wal-create-invalid');
    }
    return Object.freeze({
      parent: guard.parent,
      name: guard.snapshot.name,
      maximumBytes: guard.snapshot.maximumBytes,
      preimage: serializeHostedTaskBoardMutationWalGuardPreimage(guard.snapshot),
    });
  });
  if (new Set(guards.map((guard) => `${guard.parent}\u0000${guard.name}`)).size !== guards.length) {
    throw new TypeError('hosted-task-board-mutation-wal-create-invalid');
  }
  assertHostedTaskBoardMutationWalTargetLayout(targets);
  const wal = Object.freeze({
    schemaVersion: 3 as const,
    phase: 'prepared' as const,
    transactionId: randomUUID(),
    createdAtMs: input.nowMs,
    fence: input.fence.identity,
    command: input.command,
    payloadFingerprint: input.payloadFingerprint,
    sourceGeneration: input.command.expectedSourceGeneration,
    scope: Object.freeze({
      teamDirectory: serializeHostedTaskBoardMutationWalDirectory(input.teamDirectory),
      tasksDirectory: serializeHostedTaskBoardMutationWalDirectory(input.tasksDirectory),
      taskDirectoryNames: normalizeHostedTaskBoardMutationWalNames(input.taskDirectoryNames),
    }),
    guards: Object.freeze(guards),
    targets: Object.freeze(targets),
    finalReceipt: serializeHostedTaskBoardMutationWalReceipt(input.finalReceipt),
  });
  const serialized = serializeHostedTaskBoardMutationWal(wal);
  if (hostedTaskBoardMutationWalByteLength(serialized) > MAX_WAL_BYTES) {
    throw new TypeError('hosted-task-board-mutation-wal-create-budget-exceeded');
  }
  return parseHostedTaskBoardMutationWal(JSON.parse(serialized));
}

async function replaceWalWithFence(input: {
  readonly teamDirectory: HostedTaskBoardDirectoryDescriptor;
  readonly handle: HostedTaskBoardMutationWalHandle;
  readonly nextWal: HostedTaskBoardMutationWal;
  readonly fence: HostedTaskBoardMutationFence;
  readonly assertStillActive?: () => void;
}): Promise<HostedTaskBoardMutationWalHandle> {
  if (!input.fence.matches(input.nextWal.fence)) {
    throw new HostedTaskBoardMutationTransactionError('hosted-task-board-mutation-wal-fence-lost');
  }
  const serialized = serializeHostedTaskBoardMutationWal(input.nextWal);
  await input.fence.renew(input.assertStillActive);
  await revalidateHostedTaskBoardSnapshots(
    [input.teamDirectory],
    [input.handle.snapshot],
    input.assertStillActive
  );
  await input.fence.assertCurrent(input.assertStillActive);
  const replaced = await atomicReplaceFileIfUnchangedAsync(
    descriptorChildPath(input.teamDirectory, HOSTED_TASK_BOARD_MUTATION_WAL_FILE),
    serialized,
    {
      identity: input.handle.snapshot.stamp.durableIdentity,
      content: input.handle.snapshot.text,
    },
    { mode: 0o600 }
  );
  if (replaced === null) {
    throw new HostedTaskBoardMutationTransactionError('hosted-task-board-mutation-wal-fence-lost');
  }
  await input.fence.assertCurrent(input.assertStillActive);
  const observed = await observeHostedTaskBoardMutationWal(
    input.teamDirectory,
    input.assertStillActive
  );
  if (
    observed.handle === null ||
    observed.handle.snapshot.text !== serialized ||
    observed.handle.wal.transactionId !== input.nextWal.transactionId ||
    !sameCreateIdentity(observed.handle.snapshot, replaced)
  ) {
    throw transactionError('hosted-task-board-mutation-wal-persist-raced');
  }
  return observed.handle;
}

export async function createHostedTaskBoardMutationWalHandle(input: {
  readonly teamDirectory: HostedTaskBoardDirectoryDescriptor;
  readonly wal: HostedTaskBoardMutationWal;
  readonly fence: HostedTaskBoardMutationFence;
  readonly previousTerminal?: HostedTaskBoardMutationWalHandle | null;
  readonly assertStillActive?: () => void;
}): Promise<HostedTaskBoardMutationWalHandle> {
  if (!input.fence.matches(input.wal.fence)) {
    throw new HostedTaskBoardMutationTransactionError('hosted-task-board-mutation-wal-fence-lost');
  }
  const serialized = serializeHostedTaskBoardMutationWal(input.wal);
  await input.fence.renew(input.assertStillActive);
  let created: { readonly dev: number; readonly ino: number; readonly birthtimeMs: number };
  if (input.previousTerminal !== null && input.previousTerminal !== undefined) {
    if (input.previousTerminal.wal.phase !== 'terminal') {
      throw transactionError('hosted-task-board-mutation-wal-terminal-replace-invalid');
    }
    await revalidateHostedTaskBoardSnapshots(
      [input.teamDirectory],
      [input.previousTerminal.snapshot],
      input.assertStillActive
    );
    await input.fence.assertCurrent(input.assertStillActive);
    const replaced = await atomicReplaceFileIfUnchangedAsync(
      descriptorChildPath(input.teamDirectory, HOSTED_TASK_BOARD_MUTATION_WAL_FILE),
      serialized,
      {
        identity: input.previousTerminal.snapshot.stamp.durableIdentity,
        content: input.previousTerminal.snapshot.text,
      },
      { mode: 0o600 }
    );
    if (replaced === null) {
      throw transactionError('hosted-task-board-mutation-wal-terminal-replace-raced');
    }
    created = replaced;
  } else {
    await input.fence.assertCurrent(input.assertStillActive);
    try {
      created = await atomicCreateAsync(
        descriptorChildPath(input.teamDirectory, HOSTED_TASK_BOARD_MUTATION_WAL_FILE),
        serialized,
        { mode: 0o600, requireTrustworthyIdentity: true }
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw transactionError('hosted-task-board-mutation-wal-create-raced');
      }
      throw error;
    }
  }
  await input.fence.assertCurrent(input.assertStillActive);
  const observed = await observeHostedTaskBoardMutationWal(
    input.teamDirectory,
    input.assertStillActive
  );
  if (
    observed.handle === null ||
    observed.handle.snapshot.text !== serialized ||
    observed.handle.wal.transactionId !== input.wal.transactionId ||
    !sameCreateIdentity(observed.handle.snapshot, created)
  ) {
    throw transactionError('hosted-task-board-mutation-wal-create-raced');
  }
  return observed.handle;
}

function terminalWal(wal: HostedTaskBoardMutationWal): HostedTaskBoardMutationWal {
  return Object.freeze({ ...wal, phase: 'terminal' });
}

async function inspectWalTargets(
  wal: HostedTaskBoardMutationWal,
  directories: {
    readonly teamDirectory: HostedTaskBoardDirectoryDescriptor;
    readonly tasksDirectory: HostedTaskBoardDirectoryDescriptor;
  },
  assertStillActive?: () => void
): Promise<readonly HostedTaskBoardFileSnapshot[]> {
  return Promise.all(
    wal.targets.map((target) =>
      readHostedTaskBoardFile(parentFor(target, directories), target.name, target.maximumBytes, {
        optional: true,
        assertStillActive,
      })
    )
  );
}

function expectedTaskDirectoryNames(
  wal: HostedTaskBoardMutationWal,
  targets: readonly HostedTaskBoardFileSnapshot[],
  stagedNames: readonly string[] = []
): readonly string[] {
  const names = new Set(wal.scope.taskDirectoryNames);
  stagedNames.forEach((name) => names.add(name));
  wal.targets.forEach((target, index) => {
    const snapshot = targets[index];
    if (target.parent !== 'tasks' || snapshot === undefined) return;
    if (target.preimage.exists && !snapshot.exists) names.delete(target.name);
    if (!target.preimage.exists && targetMatchesPostimage(target, snapshot)) names.add(target.name);
  });
  return Object.freeze([...names].sort((left, right) => left.localeCompare(right)));
}

async function assertTransactionFence(input: {
  readonly wal: HostedTaskBoardMutationWal;
  readonly directories: {
    readonly teamDirectory: HostedTaskBoardDirectoryDescriptor;
    readonly tasksDirectory: HostedTaskBoardDirectoryDescriptor;
  };
  readonly snapshots: readonly HostedTaskBoardFileSnapshot[];
  readonly walSnapshot: HostedTaskBoardFileSnapshot;
  readonly fence: HostedTaskBoardMutationFence;
  readonly assertStillActive?: () => void;
}): Promise<void> {
  if (!input.fence.matches(input.wal.fence)) {
    throw new HostedTaskBoardMutationTransactionError('hosted-task-board-mutation-wal-fence-lost');
  }
  await input.fence.assertCurrent(input.assertStillActive);
  await revalidateHostedTaskBoardDirectories(
    [input.directories.teamDirectory, input.directories.tasksDirectory],
    input.assertStillActive
  );
  const stagedNames = await stagedTaskNames(input.wal, input.directories, input.assertStillActive);
  await revalidateHostedTaskBoardDirectoryMembership(
    input.directories.tasksDirectory,
    expectedTaskDirectoryNames(input.wal, input.snapshots, stagedNames),
    MAX_DIRECTORY_ENTRIES + taskStageArtifactNames(input.wal).length,
    input.assertStillActive
  );
  await assertWalGuards(input.wal, input.directories, input.assertStillActive);
  await revalidateHostedTaskBoardSnapshots(
    [input.directories.teamDirectory, input.directories.tasksDirectory],
    [...input.snapshots, input.walSnapshot],
    input.assertStillActive
  );
}

async function synchronizePreparedWalFence(input: {
  readonly handle: HostedTaskBoardMutationWalHandle;
  readonly teamDirectory: HostedTaskBoardDirectoryDescriptor;
  readonly fence: HostedTaskBoardMutationFence;
  readonly assertStillActive?: () => void;
}): Promise<HostedTaskBoardMutationWalHandle> {
  if (input.handle.wal.phase !== 'prepared') {
    throw transactionError('hosted-task-board-mutation-wal-terminal-non-authoritative');
  }
  if (input.fence.matches(input.handle.wal.fence)) return input.handle;
  return replaceWalWithFence({
    teamDirectory: input.teamDirectory,
    handle: input.handle,
    nextWal: Object.freeze({ ...input.handle.wal, fence: input.fence.identity }),
    fence: input.fence,
    assertStillActive: input.assertStillActive,
  });
}

async function publishTarget(input: {
  readonly wal: HostedTaskBoardMutationWal;
  readonly target: HostedTaskBoardMutationWalTarget;
  readonly targetIndex: number;
  readonly current: HostedTaskBoardFileSnapshot;
  readonly parent: HostedTaskBoardDirectoryDescriptor;
  readonly assertStillActive?: () => void;
  readonly beforePublish: () => Promise<void> | void;
  readonly beforeCommit: () => Promise<void>;
  readonly beforeTargetDetach: () => Promise<void>;
  readonly beforeTargetLink: () => Promise<void>;
  readonly onExistingTargetPublicationCheckpoint?: (
    checkpoint: HostedTaskBoardExistingFilePublicationCheckpoint
  ) => Promise<void> | void;
}): Promise<void> {
  const { current, parent, target } = input;
  const path = descriptorChildPath(parent, target.name);
  if (current.exists) {
    await publishHostedTaskBoardExistingFile({
      parent,
      name: target.name,
      stageName: hostedTaskBoardMutationStageName(input.wal.transactionId, input.targetIndex),
      expected: current,
      postimage: target.postimage,
      maximumBytes: target.maximumBytes,
      assertStillActive: input.assertStillActive,
      beforeFinalValidation: input.beforePublish,
      beforeCommit: input.beforeCommit,
      beforeTargetDetach: input.beforeTargetDetach,
      beforeTargetLink: input.beforeTargetLink,
      onPublicationCheckpoint: input.onExistingTargetPublicationCheckpoint,
    });
    return;
  }
  await input.beforePublish();
  await input.beforeCommit();
  try {
    await atomicCreateAsync(path, target.postimage, {
      mode: 0o600,
      requireTrustworthyIdentity: true,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new HostedTaskBoardMutationTransactionError('hosted-task-board-mutation-target-raced');
    }
    throw error;
  }
}

async function ensurePublicationDurable(
  parent: HostedTaskBoardDirectoryDescriptor,
  assertStillActive?: () => void
): Promise<void> {
  await revalidateHostedTaskBoardDirectories([parent], assertStillActive);
  await parent.handle.sync();
  await revalidateHostedTaskBoardDirectories([parent], assertStillActive);
}

async function applyPreparedWal(input: {
  readonly handle: HostedTaskBoardMutationWalHandle;
  readonly teamDirectory: HostedTaskBoardDirectoryDescriptor;
  readonly tasksDirectory: HostedTaskBoardDirectoryDescriptor;
  readonly fence: HostedTaskBoardMutationFence;
  readonly assertStillActive?: () => void;
  readonly beforePublish?: (kind: HostedTaskBoardMutationPublishKind) => Promise<void> | void;
  readonly onExistingTargetPublicationCheckpoint?: (
    checkpoint: HostedTaskBoardExistingFilePublicationCheckpoint
  ) => Promise<void> | void;
  readonly onPublished?: (kind: HostedTaskBoardMutationPublishKind) => Promise<void> | void;
}): Promise<HostedTaskBoardMutationWalHandle> {
  const handle = await synchronizePreparedWalFence(input);
  const directories = {
    teamDirectory: input.teamDirectory,
    tasksDirectory: input.tasksDirectory,
  };
  const wal = handle.wal;
  if (
    !sameDirectory(wal.scope.teamDirectory, input.teamDirectory) ||
    !sameDirectory(wal.scope.tasksDirectory, input.tasksDirectory)
  ) {
    throw transactionError('hosted-task-board-mutation-wal-scope-substituted');
  }
  for (let index = 0; index < wal.targets.length; index += 1) {
    const target = wal.targets[index];
    const currentTargets = await inspectWalTargets(wal, directories, input.assertStillActive);
    await assertTransactionFence({
      wal,
      directories,
      snapshots: currentTargets,
      walSnapshot: handle.snapshot,
      fence: input.fence,
      assertStillActive: input.assertStillActive,
    });
    const current = currentTargets[index];
    if (current === undefined) {
      throw transactionError('hosted-task-board-mutation-wal-target-missing');
    }
    const parent = parentFor(target, directories);
    if (targetMatchesPostimage(target, current)) {
      if (target.preimage.exists) {
        await recoverHostedTaskBoardExistingFilePublication({
          parent,
          name: target.name,
          stageName: hostedTaskBoardMutationStageName(wal.transactionId, index),
          preimage: target.preimage,
          postimage: target.postimage,
          maximumBytes: target.maximumBytes,
          assertStillActive: input.assertStillActive,
        });
      }
      await ensurePublicationDurable(parent, input.assertStillActive);
      continue;
    }
    if (!targetMatchesPreimage(target, current)) {
      if (target.preimage.exists && !current.exists) {
        await input.fence.renew(input.assertStillActive);
        await input.fence.assertCurrent(input.assertStillActive);
        await recoverHostedTaskBoardExistingFilePublication({
          parent,
          name: target.name,
          stageName: hostedTaskBoardMutationStageName(wal.transactionId, index),
          preimage: target.preimage,
          postimage: target.postimage,
          maximumBytes: target.maximumBytes,
          assertStillActive: input.assertStillActive,
        });
        const recovered = await readHostedTaskBoardFile(parent, target.name, target.maximumBytes, {
          assertStillActive: input.assertStillActive,
        });
        if (!targetMatchesPostimage(target, recovered)) {
          throw transactionError('hosted-task-board-mutation-wal-publish-invalid');
        }
        await ensurePublicationDurable(parent, input.assertStillActive);
        continue;
      }
      throw transactionError('hosted-task-board-mutation-wal-content-unsafe');
    }
    await input.fence.renew(input.assertStillActive);
    const beforePublishTargets = await inspectWalTargets(wal, directories, input.assertStillActive);
    await assertTransactionFence({
      wal,
      directories,
      snapshots: beforePublishTargets,
      walSnapshot: handle.snapshot,
      fence: input.fence,
      assertStillActive: input.assertStillActive,
    });
    const beforePublish = beforePublishTargets[index];
    if (beforePublish === undefined || !targetMatchesPreimage(target, beforePublish)) {
      throw transactionError('hosted-task-board-mutation-wal-content-unsafe');
    }
    await input.fence.renew(input.assertStillActive);
    await publishTarget({
      wal,
      target,
      targetIndex: index,
      current: beforePublish,
      parent,
      assertStillActive: input.assertStillActive,
      beforePublish: () => input.beforePublish?.(target.kind),
      onExistingTargetPublicationCheckpoint: input.onExistingTargetPublicationCheckpoint,
      beforeTargetDetach: () => input.fence.assertCurrent(input.assertStillActive),
      beforeTargetLink: () => input.fence.assertCurrent(input.assertStillActive),
      beforeCommit: async () => {
        const commitTargets = await inspectWalTargets(wal, directories, input.assertStillActive);
        await assertTransactionFence({
          wal,
          directories,
          snapshots: commitTargets,
          walSnapshot: handle.snapshot,
          fence: input.fence,
          assertStillActive: input.assertStillActive,
        });
        if (!targetMatchesPreimage(target, commitTargets[index])) {
          throw transactionError('hosted-task-board-mutation-wal-content-unsafe');
        }
        await input.fence.assertCurrent(input.assertStillActive);
      },
    });
    await ensurePublicationDurable(parent, input.assertStillActive);
    await input.fence.assertCurrent(input.assertStillActive);
    const publishedTargets = await inspectWalTargets(wal, directories, input.assertStillActive);
    await assertTransactionFence({
      wal,
      directories,
      snapshots: publishedTargets,
      walSnapshot: handle.snapshot,
      fence: input.fence,
      assertStillActive: input.assertStillActive,
    });
    const published = publishedTargets[index];
    if (published === undefined || !targetMatchesPostimage(target, published)) {
      throw transactionError('hosted-task-board-mutation-wal-publish-invalid');
    }
    await input.onPublished?.(target.kind);
  }
  const finalTargets = await inspectWalTargets(wal, directories, input.assertStillActive);
  if (
    finalTargets.some((snapshot, index) => !targetMatchesPostimage(wal.targets[index], snapshot))
  ) {
    throw transactionError('hosted-task-board-mutation-wal-postimage-unsafe');
  }
  await assertTransactionFence({
    wal,
    directories,
    snapshots: finalTargets,
    walSnapshot: handle.snapshot,
    fence: input.fence,
    assertStillActive: input.assertStillActive,
  });
  return replaceWalWithFence({
    teamDirectory: input.teamDirectory,
    handle,
    nextWal: terminalWal(wal),
    fence: input.fence,
    assertStillActive: input.assertStillActive,
  });
}

export async function recoverHostedTaskBoardMutationWal(input: {
  readonly handle: HostedTaskBoardMutationWalHandle;
  readonly teamDirectory: HostedTaskBoardDirectoryDescriptor;
  readonly tasksDirectory: HostedTaskBoardDirectoryDescriptor;
  readonly fence: HostedTaskBoardMutationFence;
  readonly assertStillActive?: () => void;
}): Promise<HostedTaskBoardMutationWalHandle> {
  return applyPreparedWal(input);
}

export async function publishHostedTaskBoardMutationWal(input: {
  readonly handle: HostedTaskBoardMutationWalHandle;
  readonly teamDirectory: HostedTaskBoardDirectoryDescriptor;
  readonly tasksDirectory: HostedTaskBoardDirectoryDescriptor;
  readonly fence: HostedTaskBoardMutationFence;
  readonly assertStillActive?: () => void;
  readonly beforePublish?: (kind: HostedTaskBoardMutationPublishKind) => Promise<void> | void;
  readonly onExistingTargetPublicationCheckpoint?: (
    checkpoint: HostedTaskBoardExistingFilePublicationCheckpoint
  ) => Promise<void> | void;
  readonly onPublished?: (kind: HostedTaskBoardMutationPublishKind) => Promise<void> | void;
}): Promise<HostedTaskBoardMutationWalHandle> {
  return applyPreparedWal(input);
}

export { HOSTED_TASK_BOARD_MUTATION_FENCE_FILE };
