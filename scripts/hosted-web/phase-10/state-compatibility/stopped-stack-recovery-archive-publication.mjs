#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, lstat, mkdir, open, readFile, readdir, rename, rmdir, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  assertAbsent,
  assertDirectory,
  assertDirectoryContainsOnlyOptionalEmptyChild,
  copyVerifiedInventoryEntry,
  createOwnedScratchDirectory,
  descriptorChildPath,
  descriptorIdentity,
  descriptorPath,
  openChildDirectory,
  openDirectoryBound,
  openOrCreateChildDirectory,
  readBoundedDirectoryEntries,
  readDescriptorBound,
  readVerifiedInventoryEntry,
  randomToken,
  releaseOwnedScratchDirectory,
  removeRetainedDirectory,
  retainDirectoryForRemoval,
  removeDirectoryContainingOnly,
  syncAndRevalidateDirectoryFilesAt,
  syncAndRevalidateRegularFileAt,
  syncCopiedTreeDirectories,
  syncDirectory,
  sha256,
  stableJson,
  tryOpenChildDirectory,
  unlinkDescriptorEntry,
  writeExclusiveDurableFile,
  writeExclusiveDurableFileAt,
  verifySqliteSnapshots,
} from './recovery-descriptor-io.mjs';

import * as shared from './stopped-stack-recovery-shared.mjs';
const { isRecoveryControlPath, ARCHIVE_FORMAT, READY_FORMAT, ROTATION_FORMAT, SOURCE_ROOT, READY_FILE, MANIFEST_FILE, ROTATION_FILE, RESTORE_JOURNAL_FILE, COMPLETED_ROTATION_FILE, RESTORE_JOURNAL_FORMAT, SQLITE_AUTHORITY_FORMAT, ARCHIVE_PUBLICATION_LOCK_FORMAT, ARCHIVE_PUBLICATION_LOCK_MAX_BYTES, EXCLUDED_SOURCE_PREFIX, INSTANCE_LEASE_ANCHOR, INSTANCE_LEASE_FD_PATH, MAX_ENTRIES, MAX_METADATA_BYTES, MAX_ENTRY_BYTES, DEPLOYMENT_ID_PATTERN, RECOVERY_CONTROL_PATHS } = shared;
import { verifyArchiveTree, inventoryVerifiedTree } from './stopped-stack-recovery-archive-verification.mjs';
import { readHostedStateHeader, validateSourceDeploymentIdentity, requireArchiveRoot } from './stopped-stack-recovery-postrestore.mjs';

export async function createStoppedStackArchive(options = {}) {
  const sourceRoot = resolve(options.sourceRoot ?? SOURCE_ROOT);
  const archiveRoot = requireArchiveRoot(options.archiveRoot);
  const legacyStagingRoot = `${archiveRoot}.partial`;
  if (options.sourceRootHandle) {
    if (!(await options.sourceRootHandle.stat()).isDirectory()) throw new Error('recovery_directory_invalid');
  } else {
    await assertDirectory(sourceRoot);
  }
  let archiveReservation;
  let stagingScratch;
  let stagingRoot;
  let archivePublished = false;
  let primaryError;
  try {
    // Reserve the publication operation before creating any staging state. An
    // existence check followed by a shared .partial directory permits a
    // second creator to delete or publish the first creator's work.  The
    // exclusive reservation makes this invocation the sole publisher. The
    // retained parent and child descriptors make this unpublished tree a
    // capability rather than a pathname that a later cleanup could follow.
    archiveReservation = await reserveArchivePublication(archiveRoot, options);
    await assertArchivePublicationHeld(archiveReservation);
    await assertAbsent(archiveRoot);
    await reclaimLegacyArchiveStaging(legacyStagingRoot);
    stagingScratch = await createOwnedScratchDirectory(
      dirname(archiveRoot),
      `${basename(archiveRoot)}.partial-`
    );
    stagingRoot = descriptorPath(stagingScratch.handle);
    const inventory = await inventoryVerifiedTree(sourceRoot, true, options, options.sourceRootHandle);
    // Bind the source deployment before a staging tree exists or any payload
    // byte is copied.  A valid archive from another deployment is not a valid
    // input to this recovery operation.
    const header = await readHostedStateHeader(sourceRoot, inventory);
    const sourceDeployment = validateSourceDeploymentIdentity(options.sourceDeploymentIdentity);
    if (sourceDeployment && sourceDeployment.deploymentId !== header.deploymentId) {
      throw new Error('stopped_stack_archive_source_deployment_mismatch');
    }
    await mkdir(join(stagingRoot, 'payload'), { mode: 0o700 });
    for (const entry of inventory.entries) {
      await copyVerifiedInventoryEntry(
        sourceRoot,
        inventory,
        entry,
        join(stagingRoot, 'payload'),
        false
      );
    }
    await syncCopiedTreeDirectories(stagingRoot, inventory.entries);
    await options.onArchiveCommitStage?.('payload_directories_synced');
    const body = Object.freeze({
      format: ARCHIVE_FORMAT,
      schemaVersion: 1,
      deploymentId: header.deploymentId,
      hostedStateSchemaVersion: header.hostedStateSchemaVersion,
      entries: inventory.entries,
      sqliteIntegrity: 'ok',
      ...(sourceDeployment ? { sourceDeployment } : {}),
    });
    const serialized = `${stableJson(body)}\n`;
    const manifestHash = sha256(serialized);
    await writeExclusiveDurableFile(join(stagingRoot, MANIFEST_FILE), serialized, 0o400);
    await options.onArchiveCommitStage?.('manifest_durable');
    await verifyArchiveTree(stagingRoot, false, options);
    await writeExclusiveDurableFile(
      join(stagingRoot, READY_FILE),
      `${stableJson({ format: READY_FORMAT, manifestHash, schemaVersion: 1 })}\n`,
      0o400
    );
    await options.onArchiveCommitStage?.('ready_durable');
    await syncDirectory(stagingRoot);
    await options.onArchiveCommitStage?.('staging_directory_synced');
    await assertArchivePublicationHeld(archiveReservation);
    await rename(
      descriptorChildPath(stagingScratch.parentHandle, stagingScratch.name),
      descriptorChildPath(stagingScratch.parentHandle, basename(archiveRoot))
    );
    archivePublished = true;
    await options.onArchiveCommitStage?.('archive_published');
    await stagingScratch.parentHandle.sync();
    await options.onArchiveCommitStage?.('archive_parent_synced');
    await releaseOwnedScratchDirectory(stagingScratch);
    stagingScratch = undefined;
    return Object.freeze({
      status: 'committed',
      manifestHash,
      entries: inventory.entries.length,
    });
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    // A staging tree is never an archive authority.  Retire it after every
    // failed or cancelled pre-publication attempt so the next attempt is not
    // blocked, while leaving an atomically published archive untouched.
    const cleanupFailures = [];
    if (!archivePublished && stagingScratch) {
      try { await removeRetainedDirectory(stagingScratch); }
      catch (error) { cleanupFailures.push(error); }
    }
    if (archiveReservation) {
      try { await releaseArchivePublication(archiveReservation); }
      catch (error) { cleanupFailures.push(error); }
    }
    if (cleanupFailures.length > 0) {
      if (primaryError) {
        throw new AggregateError([primaryError, ...cleanupFailures], 'stopped_stack_archive_cleanup_failed');
      }
      if (cleanupFailures.length === 1) throw cleanupFailures[0];
      throw new AggregateError(cleanupFailures, 'stopped_stack_archive_cleanup_failed');
    }
  }
}

export async function reserveArchivePublication(archiveRoot, options) {
  const lockRoot = `${archiveRoot}.partial.lock`;
  // The old directory-shaped lock has no advisory-lock anchor.  Hold this
  // separate, permanent file anchor across *both* legacy inspection/retirement
  // and acquisition of the replacement file lock.  Without it, a worker that
  // observed the legacy inode could resume after another worker acquired the
  // new anchor and rename that successor during an await gap.
  const migration = await acquireLegacyArchiveLockMigrationMutex(lockRoot, options);
  try {
    await recoverDeadLegacyArchivePublicationLock(lockRoot, options);
    let handle;
    try {
      handle = await open(
        lockRoot,
        constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
        0o600
      );
    } catch (error) {
      if (error?.code === 'EISDIR') throw new Error('stopped_stack_archive_lock_owner_unverifiable');
      throw error;
    }
    try {
      const identity = await handle.stat();
      if (!identity.isFile() || identity.nlink !== 1 || (identity.mode & 0o077) !== 0) {
        throw new Error('stopped_stack_archive_lock_invalid');
      }
      await syncDirectory(dirname(lockRoot));
      const owner = await archivePublicationOwner();
      const child = await startArchivePublicationLockHolder(handle, owner, options);
      try {
        const holderStartTicks = await readLinuxProcessStartTicks(child.pid);
        if (holderStartTicks === null) throw new Error('stopped_stack_archive_lock_holder_unverifiable');
        const binding = Object.freeze({ ...owner, holderPid: child.pid, holderStartTicks });
        await writeArchivePublicationOwner(handle, binding);
        const reservation = { lockRoot, handle, identity, owner: binding, child, lost: false, releasing: false };
        child.once('exit', () => { if (!reservation.releasing) reservation.lost = true; });
        await assertArchivePublicationHeld(reservation);
        return reservation;
      } catch (error) {
        await stopArchivePublicationLockHolder(child);
        throw error;
      }
    } catch (error) {
      await handle.close().catch(() => {});
      throw error;
    }
  } finally {
    await releaseArchivePublication(migration);
  }
}

export async function acquireLegacyArchiveLockMigrationMutex(lockRoot, options) {
  const mutexPath = `${lockRoot}.migration.lock`;
  let handle;
  try {
    handle = await open(
      mutexPath,
      constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600
    );
  } catch (error) {
    if (error?.code === 'EISDIR') throw new Error('stopped_stack_archive_lock_migration_mutex_invalid');
    throw error;
  }
  try {
    const identity = await handle.stat();
    if (!identity.isFile() || identity.nlink !== 1 || (identity.mode & 0o077) !== 0) {
      throw new Error('stopped_stack_archive_lock_migration_mutex_invalid');
    }
    await syncDirectory(dirname(mutexPath));
    const owner = await archivePublicationOwner();
    const child = await startArchivePublicationLockHolder(handle, owner, options);
    try {
      const reservation = { lockRoot: mutexPath, handle, identity, owner, child, lost: false, releasing: false };
      child.once('exit', () => { if (!reservation.releasing) reservation.lost = true; });
      await assertArchivePublicationHeld(reservation);
      return reservation;
    } catch (error) {
      await stopArchivePublicationLockHolder(child);
      throw error;
    }
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

export async function releaseArchivePublication(reservation) {
  reservation.releasing = true;
  try {
    // The lock anchor deliberately remains in place.  Removing a pathname
    // after releasing an advisory lock permits a delayed owner to unlink a
    // successor's anchor.  The holder owns only its child and its exact open
    // file description; process death closes that description automatically.
    await assertArchivePublicationHeld(reservation);
  } finally {
    await stopArchivePublicationLockHolder(reservation.child);
    await reservation.handle.close();
  }
}

export async function archivePublicationOwner() {
  const processStartTicks = await readLinuxProcessStartTicks(process.pid);
  if (processStartTicks === null) throw new Error('stopped_stack_archive_lock_owner_unverifiable');
  return Object.freeze({
    format: ARCHIVE_PUBLICATION_LOCK_FORMAT,
    nonce: randomToken(32),
    pid: process.pid,
    processStartTicks,
  });
}

export function parseLinuxProcessStat(body) {
  // proc(5) permits spaces and closing parentheses in comm.  The state and
  // all following fields begin only after the final closing parenthesis.
  const closingName = typeof body === 'string' ? body.lastIndexOf(')') : -1;
  if (closingName < 0) return null;
  const fields = body.slice(closingName + 1).trim().split(/\s+/u);
  const state = fields[0];
  const startTicks = fields[19];
  if (!/^[A-Za-z]$/u.test(state ?? '') || !/^[0-9]+$/u.test(startTicks ?? '')) return null;
  return Object.freeze({ state, startTicks });
}

export async function readLinuxProcessStatus(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  let body;
  try {
    body = await readFile(`/proc/${pid}/stat`, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new Error('stopped_stack_archive_lock_owner_unverifiable');
  }
  const parsed = parseLinuxProcessStat(body);
  if (!parsed) throw new Error('stopped_stack_archive_lock_owner_unverifiable');
  return parsed;
}

export async function readLinuxProcessStartTicks(pid, options = {}) {
  const status = options.readLinuxProcessStatus
    ? await options.readLinuxProcessStatus(pid)
    : await readLinuxProcessStatus(pid);
  if (
    status !== null &&
    (!status || !/^[A-Za-z]$/u.test(status.state ?? '') || !/^[0-9]+$/u.test(status.startTicks ?? ''))
  ) throw new Error('stopped_stack_archive_lock_owner_unverifiable');
  // A zombie has exited even when a parent has not reaped it.  It cannot
  // remain an archive-lock owner, and treating it as live wedges recovery.
  if (!status || status.state === 'Z' || status.state === 'X' || status.state === 'x') return null;
  return status.startTicks;
}

export function archiveLockHolderScript() {
  // The shell is the flock child.  It retains FD 3 while it verifies the
  // parent identity, so SIGKILL cannot strand a held lock: the PID may be
  // reused only with a different /proc start time and the holder exits.
  //
  // proc(5) permits spaces and ')' in comm.  Read the complete record, strip
  // through its final ') ', then count fields in the tail: state is $1 and
  // starttime (field 22) is ${20}.  Do not split the complete record or use a
  // fixed full-line field number.  A zombie/dead task has exited even before
  // its parent reaps it and must release this watchdog-held lock.
  return 'expected_start="$2"; stat_path="${4:-/proc/$1/stat}"; /usr/bin/flock -n 3 || exit $?; printf "archive-lock-held:%s" "$3" >&4; while :; do record="$(cat "$stat_path" 2>/dev/null)" || exit 0; tail="${record##*) }"; [ "$tail" != "$record" ] || exit 0; set -f; set -- $tail; set +f; state="$1"; start="${20-}"; case "$state" in Z|X|x|\"\") exit 0 ;; esac; [ "$start" = "$expected_start" ] || exit 0; sleep 0.05; done';
}

export async function startArchivePublicationLockHolder(handle, owner, options = {}) {
  const child = spawn(
    '/bin/sh',
    [
      '-c', archiveLockHolderScript(), 'archive-lock-holder', String(owner.pid), owner.processStartTicks,
      owner.nonce, options.watchdogProcStatPath ?? '',
    ],
    { stdio: ['ignore', 'ignore', 'ignore', handle.fd, 'pipe'] }
  );
  await new Promise((resolveSpawn, rejectSpawn) => {
    child.once('spawn', resolveSpawn);
    child.once('error', rejectSpawn);
  });
  const acknowledgement = `archive-lock-held:${owner.nonce}`;
  try {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error('stopped_stack_archive_already_exists');
    }
    await new Promise((resolveAcknowledgement, rejectAcknowledgement) => {
      let received = '';
      let settled = false;
      const timer = setTimeout(() => rejectAcknowledgement(new Error('stopped_stack_archive_lock_ack_timeout')), 5_000);
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback(value);
      };
      child.stdio[4].on('data', (chunk) => {
        received += chunk.toString('utf8');
        if (received === acknowledgement) finish(resolveAcknowledgement);
        else if (!acknowledgement.startsWith(received)) finish(rejectAcknowledgement, new Error('stopped_stack_archive_lock_ack_invalid'));
      });
      child.once('exit', () => finish(rejectAcknowledgement, new Error('stopped_stack_archive_already_exists')));
      child.once('error', (error) => finish(rejectAcknowledgement, error));
    });
    return child;
  } catch (error) {
    await stopArchivePublicationLockHolder(child);
    throw error;
  }
}

export async function stopArchivePublicationLockHolder(child) {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolveExit) => child.once('exit', resolveExit));
}

export async function writeArchivePublicationOwner(handle, owner) {
  const serialized = `${stableJson(owner)}\n`;
  await handle.truncate(0);
  await handle.writeFile(serialized, 'utf8');
  await handle.sync();
}

export async function assertArchivePublicationHeld(reservation) {
  if (reservation.lost || reservation.child.exitCode !== null || reservation.child.signalCode !== null) {
    throw new Error('stopped_stack_archive_lock_lost');
  }
  const current = await lstat(reservation.lockRoot);
  if (
    !current.isFile() ||
    current.isSymbolicLink() ||
    current.dev !== reservation.identity.dev ||
    current.ino !== reservation.identity.ino
  ) throw new Error('stopped_stack_archive_lock_lost');
  const held = await reservation.handle.stat();
  if (held.dev !== reservation.identity.dev || held.ino !== reservation.identity.ino) {
    throw new Error('stopped_stack_archive_lock_lost');
  }
}

export async function recoverDeadLegacyArchivePublicationLock(lockRoot, options = {}) {
  let lockStat;
  try {
    lockStat = await lstat(lockRoot);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (!lockStat.isDirectory() || lockStat.isSymbolicLink()) return;
  const lockHandle = await openDirectoryBound(lockRoot);
  let entries;
  try {
    entries = await readBoundedDirectoryEntries(lockHandle, 1);
  } finally {
    await lockHandle.close();
  }
  if (entries.length === 0) {
    // Older interrupted recovery code could leave an empty legacy directory
    // after retiring owner.json.  A directory with no owner record is not a
    // live lock; transition it as a whole so that a retry is resumable.
    await retireLegacyArchivePublicationLock(lockRoot, lockStat, options, 'empty');
    return;
  }
  if (entries.length !== 1 || entries[0] !== 'owner.json') {
    throw new Error('stopped_stack_archive_lock_owner_unverifiable');
  }
  const ownerPath = join(lockRoot, 'owner.json');
  const owner = await readArchivePublicationOwner(ownerPath);
  const liveStartTicks = await readLinuxProcessStartTicks(owner.pid, options);
  if (liveStartTicks === owner.processStartTicks) {
    throw new Error('stopped_stack_archive_already_exists');
  }
  await retireLegacyArchivePublicationLock(lockRoot, lockStat, options, 'stale_owner');
}

export async function retireLegacyArchivePublicationLock(lockRoot, expected, options, reason) {
  await assertLegacyArchiveLockIdentity(lockRoot, expected);
  const retained = await retainDirectoryForRemoval(dirname(lockRoot), basename(lockRoot), expected);
  let removalAttempted = false;
  try {
    // Do not unlink owner.json and then rmdir the directory.  SIGKILL in that
    // window erases the sole owner evidence, making a restart unable to decide
    // whether it is safe to acquire.  Rename preserves the complete legacy
    // record under a tombstone until the parent-directory transition is synced.
    const tombstone = await legacyArchiveLockTombstonePath(lockRoot);
    await options.onArchiveLockRecoveryStage?.(`legacy_${reason}_verified`);
    // The migration mutex serializes normal workers, but keep the descriptor
    // identity check adjacent to rename as well.  A stale verifier must fail
    // closed rather than rename a successor it did not inspect.
    await assertLegacyArchiveLockIdentity(lockRoot, expected);
    await rename(
      descriptorChildPath(retained.parentHandle, retained.name),
      descriptorChildPath(retained.parentHandle, basename(tombstone))
    );
    await options.onArchiveLockRecoveryStage?.(`legacy_${reason}_tombstoned`);
    await retained.parentHandle.sync();
    await options.onArchiveLockRecoveryStage?.(`legacy_${reason}_tombstone_durable`);

    // This cleanup is deliberately after the durable rename.  A SIGKILL here
    // leaves either a complete tombstone or harmless retired debris; neither
    // state can erase or steal a live lock at lockRoot.
    removalAttempted = true;
    await removeRetainedDirectory(Object.freeze({
      ...retained,
      name: basename(tombstone),
    }));
    await options.onArchiveLockRecoveryStage?.(`legacy_${reason}_retired`);
  } finally {
    if (!removalAttempted) await releaseOwnedScratchDirectory(retained);
  }
}

export async function assertLegacyArchiveLockIdentity(lockRoot, expected) {
  const current = await lstat(lockRoot);
  if (
    current.dev !== expected.dev || current.ino !== expected.ino ||
    !current.isDirectory() || current.isSymbolicLink()
  ) throw new Error('stopped_stack_archive_lock_owner_unverifiable');
}

export async function legacyArchiveLockTombstonePath(lockRoot) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = `${lockRoot}.retired-${randomToken(18)}`;
    try {
      await lstat(candidate);
    } catch (error) {
      if (error?.code === 'ENOENT') return candidate;
      throw error;
    }
  }
  throw new Error('stopped_stack_archive_lock_tombstone_collision');
}

export async function readArchivePublicationOwner(path) {
  const { body } = await readDescriptorBound(path, ARCHIVE_PUBLICATION_LOCK_MAX_BYTES);
  let owner;
  try { owner = JSON.parse(body.toString('utf8')); }
  catch { throw new Error('stopped_stack_archive_lock_owner_unverifiable'); }
  if (
    !owner || owner.format !== ARCHIVE_PUBLICATION_LOCK_FORMAT ||
    !Number.isSafeInteger(owner.pid) || owner.pid < 1 ||
    typeof owner.processStartTicks !== 'string' || !/^[0-9]+$/u.test(owner.processStartTicks) ||
    typeof owner.nonce !== 'string' || !/^[A-Za-z0-9_-]{32,}$/u.test(owner.nonce)
  ) throw new Error('stopped_stack_archive_lock_owner_unverifiable');
  return owner;
}

export async function reclaimLegacyArchiveStaging(stagingRoot) {
  let stale;
  try {
    stale = await lstat(stagingRoot);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  // Pre-descriptor-format scratch has no authenticated owner, incarnation, or
  // bounded inventory. It cannot be safely distinguished from a live
  // publisher, so fail closed instead of recursively deleting a pathname.
  throw new Error(
    !stale.isDirectory() || stale.isSymbolicLink()
      ? 'stopped_stack_archive_staging_invalid'
      : 'stopped_stack_archive_staging_owner_unverifiable'
  );
}
