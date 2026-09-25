import * as fs from 'fs';
import * as path from 'path';

import {
  type AtomicCreateRecoveryBudget,
  boundedMatchingEntries,
  createAtomicCreateRecoveryBudget,
  readBoundedRegularText,
  withinAtomicCreateRecoveryBudget,
  withinAtomicCreateRecoveryOpenBudget,
} from './atomicCreateCleanupRecoveryIo';
import { getDurableFileIdentity, isSameDurableFileIdentity } from './durablePathIdentity';

const ATOMIC_CREATE_ARTIFACT =
  /^(?:\.review-create\.[a-f0-9-]+\.tmp|\.review-create-cleanup-[a-z0-9-]+|\.atomic-create-cleanup-[a-z0-9.-]+)$/i;
const STAGED_ATTACHMENT_DELETION =
  /^\.attachment-delete\.([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\.staged$/i;
const PUBLIC_GUARD = /^\.review-create\.[a-f0-9-]+\.tmp$/i;
const MAX_ARTIFACTS = 64;

async function activeStagedDeletionPinName(
  targetPath: string,
  target: fs.Stats,
  budget: AtomicCreateRecoveryBudget
): Promise<string | null> {
  const transactionId = STAGED_ATTACHMENT_DELETION.exec(path.basename(targetPath))?.[1];
  if (!transactionId) return null;
  const taskDirectory = path.dirname(targetPath);
  const teamDirectory = path.dirname(taskDirectory);
  const attachmentsDirectory = path.dirname(teamDirectory);
  if (path.basename(attachmentsDirectory) !== 'task-attachments') return null;
  const journalPath = path.join(
    path.dirname(attachmentsDirectory),
    'task-attachment-deletion-intents',
    `${transactionId}.json`
  );
  let raw: string;
  try {
    raw = await readBoundedRegularText(journalPath, 16 * 1024, budget);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const record: unknown = JSON.parse(raw);
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const intent = record as Record<string, unknown>;
  const pinPath = intent.pinPath;
  const identity = intent.identity;
  if (
    intent.version !== 1 ||
    intent.transactionId !== transactionId ||
    intent.teamName !== path.basename(teamDirectory) ||
    intent.taskId !== path.basename(taskDirectory) ||
    intent.phase !== 'detached' ||
    intent.detachedPath !== targetPath ||
    typeof intent.attachmentId !== 'string' ||
    typeof intent.originalPath !== 'string' ||
    path.dirname(intent.originalPath) !== taskDirectory ||
    !path.basename(intent.originalPath).startsWith(`${intent.attachmentId}--`) ||
    typeof pinPath !== 'string' ||
    path.dirname(pinPath) !== taskDirectory ||
    !PUBLIC_GUARD.test(path.basename(pinPath)) ||
    !identity ||
    typeof identity !== 'object' ||
    Array.isArray(identity)
  )
    return null;
  const generation = identity as Record<string, unknown>;
  const targetIdentity = getDurableFileIdentity(target);
  if (
    generation.dev !== targetIdentity.dev ||
    generation.ino !== targetIdentity.ino ||
    generation.birthtimeMs !== targetIdentity.birthtimeMs ||
    generation.size !== targetIdentity.size
  )
    return null;
  try {
    const pin = await withinAtomicCreateRecoveryBudget(budget, 'journal-pin-lstat', () =>
      fs.promises.lstat(pinPath)
    );
    if (
      !pin.isFile() ||
      pin.isSymbolicLink() ||
      !isSameDurableFileIdentity(getDurableFileIdentity(pin), targetIdentity)
    )
      return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  return path.basename(pinPath);
}

async function retainOperatorMarker(
  directory: string,
  markerPath: string,
  budget: AtomicCreateRecoveryBudget
): Promise<void> {
  await withinAtomicCreateRecoveryBudget(budget, 'operator-marker-create', () =>
    fs.promises.mkdir(markerPath, { mode: 0o700 })
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error;
  });
  const marker = await withinAtomicCreateRecoveryBudget(budget, 'operator-marker-lstat', () =>
    fs.promises.lstat(markerPath)
  );
  if (!marker.isDirectory() || marker.isSymbolicLink()) {
    throw new Error('Atomic-create operator marker was replaced');
  }
  const directoryHandle = await withinAtomicCreateRecoveryOpenBudget(
    budget,
    'operator-marker-parent-open',
    () => fs.promises.open(directory, 'r')
  );
  let closeAfterPendingSync = false;
  try {
    await withinAtomicCreateRecoveryBudget(
      budget,
      'operator-marker-parent-fsync',
      () => directoryHandle.sync(),
      (pending) => {
        closeAfterPendingSync = true;
        void pending
          .catch(() => undefined)
          .then(() => directoryHandle.close().catch(() => undefined));
      }
    );
  } finally {
    if (!closeAfterPendingSync) {
      let closeStarted = false;
      await withinAtomicCreateRecoveryBudget(budget, 'operator-marker-parent-close', () => {
        closeStarted = true;
        return directoryHandle.close();
      }).catch(() => undefined);
      if (!closeStarted) void directoryHandle.close().catch(() => undefined);
    }
  }
}

export class AtomicCreateOperatorRequiredError extends Error {
  readonly code = 'EATOMICCREATE_OPERATOR_REQUIRED';
  readonly reconciliation = 'operator_required';

  constructor(
    readonly targetPath: string,
    readonly markerPath: string,
    cause?: unknown
  ) {
    super(
      `Atomic-create cleanup requires operator reconciliation for ${targetPath}. ` +
        `Quiesce writers, inspect the retained guard/recovery entries and ${markerPath}, ` +
        'then remove only generations proven safe.'
    );
    this.name = 'AtomicCreateOperatorRequiredError';
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * Stock Node has pathname unlink/rmdir/rename, but no syscall that binds the
 * final pathname component to an authenticated inode generation. A prior
 * lstat cannot authorize a later rename or unlink: a concurrent publisher can
 * substitute B in between. A private directory does not fix this for crash
 * recovery, since its entry can also be replaced before the destructive call.
 *
 * Retain public crash guards, failed-create guards, and any legacy detached
 * recovery directories. A linked target with a matching guard or recovery
 * prefix gets an operator-required marker. No record prefix grants deletion
 * authority, even when its claimed identity agrees with the current entry.
 */
export async function cleanupStockNodeAtomicCreateTempLinks(
  targetPath: string,
  budget: AtomicCreateRecoveryBudget
): Promise<void> {
  const directory = path.dirname(targetPath);
  // One no-clobber marker per directory bounds durable operator state even
  // when many targets carry old guards.
  const markerPath = path.join(directory, '.atomic-create-operator-required');
  let target: fs.Stats | null = null;
  let matching = false;
  try {
    try {
      target = await withinAtomicCreateRecoveryBudget(budget, 'target-lstat', () =>
        fs.promises.lstat(targetPath)
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const artifacts = await boundedMatchingEntries(
      directory,
      ATOMIC_CREATE_ARTIFACT,
      MAX_ARTIFACTS,
      'retained-atomic-create-artifact',
      budget
    );
    const targetIdentity =
      target?.isFile() && !target.isSymbolicLink() && target.nlink > 1
        ? getDurableFileIdentity(target)
        : null;
    const stagedDeletion = STAGED_ATTACHMENT_DELETION.test(path.basename(targetPath));
    const activePin =
      target && stagedDeletion
        ? await activeStagedDeletionPinName(targetPath, target, budget)
        : null;
    for (const name of artifacts) {
      if (
        name.startsWith('.review-create-cleanup-') ||
        name.startsWith('.atomic-create-cleanup-')
      ) {
        matching = true; // Recordless crash prefixes are retained, never reclaimed.
        continue;
      }
      if (!name.startsWith('.review-create.')) continue;
      if (stagedDeletion) {
        if (name === activePin && targetIdentity) {
          const pin = await withinAtomicCreateRecoveryBudget(budget, 'active-pin-recheck', () =>
            fs.promises.lstat(path.join(directory, name))
          );
          if (
            pin.isFile() &&
            !pin.isSymbolicLink() &&
            isSameDurableFileIdentity(getDurableFileIdentity(pin), targetIdentity)
          )
            continue;
        }
        matching = true;
        continue;
      }
      if (!target) {
        matching = true; // Orphaned public guards have no target authority.
        continue;
      }
      if (!targetIdentity) continue;
      try {
        const candidate = await withinAtomicCreateRecoveryBudget(budget, 'guard-lstat', () =>
          fs.promises.lstat(path.join(directory, name))
        );
        if (
          candidate.isFile() &&
          !candidate.isSymbolicLink() &&
          isSameDurableFileIdentity(getDurableFileIdentity(candidate), targetIdentity)
        ) {
          matching = true;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  } catch (error) {
    try {
      // Scanning can exhaust its own deadline or entry quota. Marker publication
      // has a separate finite budget so those failures still leave durable intent.
      await retainOperatorMarker(directory, markerPath, createAtomicCreateRecoveryBudget());
    } catch (markerError) {
      throw new AtomicCreateOperatorRequiredError(
        targetPath,
        markerPath,
        new AggregateError([error, markerError])
      );
    }
    throw new AtomicCreateOperatorRequiredError(targetPath, markerPath, error);
  }
  if (!matching) return;

  try {
    await retainOperatorMarker(directory, markerPath, createAtomicCreateRecoveryBudget());
  } catch (error) {
    throw new AtomicCreateOperatorRequiredError(targetPath, markerPath, error);
  }
  throw new AtomicCreateOperatorRequiredError(targetPath, markerPath);
}
