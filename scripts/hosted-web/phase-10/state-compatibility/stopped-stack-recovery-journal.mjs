#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, rmdir, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  assertAbsent,
  assertDirectory,
  assertDirectoryContainsOnlyOptionalEmptyChild,
  copyVerifiedInventoryEntry,
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
import { validateRotationForMarker, validateRestoreJournal, preRotationSqliteAuthority, checkpointIntentSqliteAuthority, verifyJournalPhaseOutputs } from './stopped-stack-recovery-authority.mjs';
import { assertEmptyRestoreTarget } from './stopped-stack-recovery-postrestore.mjs';

export function createRotationRequest(input) {
  return Object.freeze({
    format: ROTATION_FORMAT,
    schemaVersion: 1,
    deploymentId: input.deploymentId,
    sourceManifestHash: input.sourceManifestHash,
    restoreGeneration: input.restoreGeneration,
    bootId: `boot_x${input.random(18)}`,
    eventEpoch: `epoch_x${input.random(18)}`,
    browserAuthorityRotated: true,
    runtimeAuthorityRotationRequired: true,
    freshMountBindingsRequired: true,
  });
}

export async function initializeOrResumeRestore(input) {
  await reconcileRestoreJournalStaging(input);
  const existing = await readOptionalRestoreJournal(input.targetRootHandle);
  let supersedesCompletedGeneration = false;
  if (existing) {
    validateRestoreJournal(existing);
    // Decide whether the sealed incoming archive can supersede this completed
    // operation *before* applying that archive's inventory to the historical
    // journal.  Comparing A's journal to B's archive would turn a legitimate
    // bounded rollback into a misleading SQLite-inventory failure.
    if (existing.manifestHash !== input.verified.manifestHash) {
      if (existing.phase !== 'completed' || input.restoreGeneration <= existing.rotation.restoreGeneration) {
        throw new Error('stopped_stack_restore_journal_mismatch');
      }
      await assertRestoreScopeAvailable(input.targetRootHandle, input.verified.manifestHash, input.restoreGeneration);
      await ensureCompletedRotationMarker(input.targetRootHandle, existing.rotation, input.onRestoreStage);
      // writeRestoreJournal publishes the selected new operation by an atomic
      // rename followed by a directory fsync, retiring this completed journal
      // without leaving its name available for a stale reader.
      supersedesCompletedGeneration = true;
    } else if (
      // The archive proves where the bytes came from.  It does not name the
      // deployment which will own those bytes after rollback.  In particular,
      // an interrupted A-to-B restore must resume as B, and a later request
      // for C must not be allowed to take over B's durable operation.
      existing.rotation.deploymentId !== input.restoreDeploymentId ||
      existing.rotation.restoreGeneration !== input.restoreGeneration
    ) {
      // A source scope is immutable.  In particular, do not treat a larger
      // generation for the same archive as a newer archive selection.
      throw new Error('stopped_stack_restore_journal_mismatch');
    } else {
      assertJournalSqliteAuthorityMatchesArchive(existing, input.verified.manifest.entries);
      return existing;
    }
  }
  await recoverUnpublishedJournalStaging(input.targetRootHandle);
  if (!existing) await assertEmptyRestoreTarget(input.targetRootHandle);
  const authorityPlan = input.restoreAuthorityPlan;
  const rotation = authorityPlan?.rotation ?? createRotationRequest({
    deploymentId: input.restoreDeploymentId,
    sourceManifestHash: input.verified.manifestHash,
    restoreGeneration: input.restoreGeneration,
    random: input.random,
  });
  if (!sameRequestedRestoreScope(rotation, input)) {
    throw new Error('stopped_stack_restore_authority_plan_scope_invalid');
  }
  const secretPlan = authorityPlan?.secretPlan ?? {
    identityKey: input.random(32),
    keyring: {
      binding: {
        deploymentId: rotation.deploymentId,
        restoreGeneration: rotation.restoreGeneration,
      },
      createdAt: 0,
      csrfKey: input.random(32),
      format: 'hosted-access-keyring/v1',
      hashKey: input.random(32),
      keyringId: `akr_x${input.random(18)}`,
    },
  };
  // The sealed replay receipt supplies the original rotation material.  Do
  // not permit a caller to use this as a generic journal override: the exact
  // plan is validated by the same journal authority that will consume it.
  validateRestoreJournal({
    format: RESTORE_JOURNAL_FORMAT,
    schemaVersion: 1,
    manifestHash: input.verified.manifestHash,
    phase: 'initialized',
    rotation,
    secretPlan,
    sqliteAuthority: preRotationSqliteAuthority(input.verified.manifest.entries, input.verified.manifestHash),
  });
  const journal = {
    format: RESTORE_JOURNAL_FORMAT,
    schemaVersion: 1,
    manifestHash: input.verified.manifestHash,
    phase: 'initialized',
    ...(supersedesCompletedGeneration ? { supersedesCompletedGeneration: true } : {}),
    rotation,
    secretPlan,
    sqliteAuthority: preRotationSqliteAuthority(
      input.verified.manifest.entries,
      input.verified.manifestHash
    ),
  };
  const dataHandle = await openOrCreateChildDirectory(input.targetRootHandle, 'data');
  await dataHandle.close();
  await writeRestoreJournal(input.targetRootHandle, journal, input.onRestoreStage);
  return journal;
}

function sameRequestedRestoreScope(rotation, input) {
  return rotation?.format === ROTATION_FORMAT && rotation.schemaVersion === 1 &&
    rotation.deploymentId === input.restoreDeploymentId &&
    rotation.sourceManifestHash === input.verified.manifestHash &&
    rotation.restoreGeneration === input.restoreGeneration &&
    rotation.browserAuthorityRotated === true &&
    rotation.runtimeAuthorityRotationRequired === true &&
    rotation.freshMountBindingsRequired === true;
}

export async function assertRestoreScopeAvailable(targetRootHandle, manifestHash, restoreGeneration) {
  const scope = `${manifestHash}.g-${restoreGeneration}`;
  const names = [
    `hosted-restore-rotation.v1.${scope}.json`,
    `hosted-restore-rotation.completed.v1.${scope}.json`,
  ];
  const dataHandle = await openChildDirectory(targetRootHandle, 'data');
  try {
    for (const name of names) {
      try {
        const body = (await readDescriptorBound(
          descriptorChildPath(dataHandle, name),
          MAX_METADATA_BYTES
        )).body.toString('utf8');
        const marker = JSON.parse(body);
        validateRotationForMarker(marker);
        if (rotationScope(marker) !== scope) {
          throw new Error('stopped_stack_restore_generation_scope_history_invalid');
        }
        throw new Error('stopped_stack_restore_generation_scope_reused');
      } catch (error) {
        if (error?.code === 'ENOENT') continue;
        throw error;
      }
    }
  } finally {
    await dataHandle.close();
  }
}

export async function recoverUnpublishedJournalStaging(targetRootHandle) {
  const rootEntries = await readBoundedDirectoryEntries(targetRootHandle, 2);
  const unexpectedRoot = rootEntries.filter(
    (entry) => entry !== EXCLUDED_SOURCE_PREFIX && entry !== 'data'
  );
  if (unexpectedRoot.length > 0 || !rootEntries.includes('data')) return;
  const dataHandle = await openChildDirectory(targetRootHandle, 'data');
  try {
    const dataEntries = await readBoundedDirectoryEntries(dataHandle, MAX_ENTRIES);
    // Staging metadata has never been published.  A killed writer can leave a
    // truncated journal together with a truncated rotation marker, so recover
    // the empty target from the authoritative archive rather than treating
    // those private temp inodes as user state.
    if (dataEntries.length > 0 && dataEntries.every((entry) =>
      entry.endsWith('.staging') && isRecoveryControlPath(`data/${entry}`)
    )) {
      for (const entry of dataEntries) await unlinkDescriptorEntry(dataHandle, entry);
      await dataHandle.sync();
    }
  } finally {
    await dataHandle.close();
  }
}

export async function ensureRotationMarker(targetRootHandle, rotation, onStage) {
  const dataHandle = await openChildDirectory(targetRootHandle, 'data');
  const markerName = rotationMarkerName(rotation);
  try {
    await publishResumableMetadata(
      dataHandle,
      markerName,
      rotation,
      'stopped_stack_restore_rotation_marker_mismatch',
      onStage,
      'rotation_marker'
    );
  } finally {
    await dataHandle.close();
  }
}

export function rotationScope(rotation) {
  return `${rotation.sourceManifestHash}.g-${rotation.restoreGeneration}`;
}

export function rotationMarkerName(rotation) {
  return `hosted-restore-rotation.v1.${rotationScope(rotation)}.json`;
}

export function completedRotationMarkerName(rotation) {
  return `hosted-restore-rotation.completed.v1.${rotationScope(rotation)}.json`;
}

export async function ensureCompletedRotationMarker(targetRootHandle, rotation, onStage) {
  const dataHandle = await openChildDirectory(targetRootHandle, 'data');
  const markerName = completedRotationMarkerName(rotation);
  try {
    await publishResumableMetadata(
      dataHandle,
      markerName,
      rotation,
      'stopped_stack_restore_completed_rotation_marker_mismatch',
      onStage,
      'completed_rotation_marker'
    );
  } finally {
    await dataHandle.close();
  }
}

export async function readOptionalRestoreJournal(targetRootHandle) {
  let dataHandle;
  try {
    dataHandle = await openChildDirectory(targetRootHandle, 'data');
    return JSON.parse(
      (
        await readDescriptorBound(
          descriptorChildPath(dataHandle, RESTORE_JOURNAL_FILE),
          MAX_METADATA_BYTES
        )
      ).body.toString('utf8')
    );
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  } finally {
    await dataHandle?.close();
  }
}

export async function writeRestoreJournal(targetRootHandle, journal, onStage) {
  const dataHandle = await openChildDirectory(targetRootHandle, 'data');
  try {
    const staging = `${RESTORE_JOURNAL_FILE}.staging`;
    const body = `${stableJson(journal)}\n`;
    try {
      const staged = (await readDescriptorBound(descriptorChildPath(dataHandle, staging), MAX_METADATA_BYTES)).body.toString('utf8');
      if (staged !== body) throw new Error('stopped_stack_restore_journal_staging_mismatch');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      await writeExclusiveDurableFileAt(dataHandle, staging, body, 0o600);
    }
    // This is the exact point at which a later generation exists only as
    // durable private intent.  Its immutable completed-scope marker must not
    // exist yet, so a restart may safely promote this same staged operation.
    await onStage?.('journal_staging_durable_before_publication');
    await rename(
      descriptorChildPath(dataHandle, staging),
      descriptorChildPath(dataHandle, RESTORE_JOURNAL_FILE)
    );
    await dataHandle.sync();
  } finally {
    await dataHandle.close();
  }
}

export async function reconcileRestoreJournalStaging(input) {
  const dataHandle = await openChildDirectory(input.targetRootHandle, 'data').catch((error) => {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!dataHandle) return;
  try {
    const staging = `${RESTORE_JOURNAL_FILE}.staging`;
    let staged;
    try {
      staged = (await readDescriptorBound(descriptorChildPath(dataHandle, staging), MAX_METADATA_BYTES)).body.toString('utf8');
      validateRestoreJournal(JSON.parse(staged));
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      // A staging write is not publication.  Its bytes cannot supersede an
      // intact active journal, and an invalid partial record carries no
      // operation identity to preserve.  Retire it and rebuild from the
      // durable active journal (or, if none exists, from archive inputs).
      try {
        await readDescriptorBound(descriptorChildPath(dataHandle, RESTORE_JOURNAL_FILE), MAX_METADATA_BYTES);
      } catch (activeError) {
        if (activeError?.code !== 'ENOENT') throw activeError;
      }
      await unlinkDescriptorEntry(dataHandle, staging);
      await dataHandle.sync();
      return;
    }
    const stagedJournal = JSON.parse(staged);
    try {
      const active = (await readDescriptorBound(descriptorChildPath(dataHandle, RESTORE_JOURNAL_FILE), MAX_METADATA_BYTES)).body.toString('utf8');
      const activeJournal = JSON.parse(active);
      validateRestoreJournal(activeJournal);
      if (active === staged) {
        assertJournalSqliteAuthorityMatchesArchive(activeJournal, input.verified.manifest.entries);
        await unlinkDescriptorEntry(dataHandle, staging);
        await dataHandle.sync();
        return;
      }
      if (sameRestoreOperation(activeJournal, stagedJournal)) {
        assertJournalSqliteAuthorityMatchesArchive(activeJournal, input.verified.manifest.entries);
        assertJournalSqliteAuthorityMatchesArchive(stagedJournal, input.verified.manifest.entries);
        const checkpointSuccessor = isCheckpointJournalSuccessor(activeJournal, stagedJournal);
        if (!checkpointSuccessor && !isImmediateRestoreSuccessor(activeJournal.phase, stagedJournal.phase)) {
          throw new Error('stopped_stack_restore_journal_staging_mismatch');
        }
        if (checkpointSuccessor) {
          await assertCheckpointSuccessorRegeneratedFromArchive({
            activeJournal,
            stagedJournal,
            targetRootHandle: input.targetRootHandle,
            archiveRoot: input.archiveRoot,
            verified: input.verified,
            openDatabase: input.openDatabase,
            onRestoreStage: input.onRestoreStage,
          });
        }
        if (checkpointSuccessor && stagedJournal.sqliteAuthority.checkpointIntent) {
          // SQLite can alter WAL/SHM merely by opening the primary to inspect
          // it. A recovered pre-mutation intent is therefore promoted only after its
          // exact staging inode and directory entry have been fsynced and
          // revalidated, *before* verifyJournalPhaseOutputs can open SQLite.
          // The next outer restore step then observes this authoritative
          // journal and is free to inspect or resume the database family.
          await promoteRecoveredDatabaseRotationIntent(
            dataHandle,
            staging,
            staged,
            input.onRestoreStage
          );
          return;
        }
        // The successor was fsynced before its rename. Regenerate every
        // carried checkpoint transition in isolated staging before phase
        // verification is allowed to open the live SQLite family; this also
        // covers staged `database_rotated`/later reconciliation.
        if (stagedJournal.sqliteAuthority.checkpointTransformation) {
          const { assertCheckpointTransformationRegeneratedInIsolatedStaging } = await import('./stopped-stack-recovery-sqlite.mjs');
          await assertCheckpointTransformationRegeneratedInIsolatedStaging({
            targetRootHandle: input.targetRootHandle,
            sqliteAuthority: stagedJournal.sqliteAuthority,
            openDatabase: input.openDatabase,
            archiveRoot: input.archiveRoot,
            verified: input.verified,
            rotation: stagedJournal.rotation,
          });
        }
        // The successor was fsynced before its rename.  Prove the exact
        // phase output before making it authoritative; this covers the window
        // after payload/DB/secrets work and immediately before rename.
        const verified = await verifyJournalPhaseOutputs(
          input.targetRootHandle,
          input.verified,
          stagedJournal,
          input.openDatabase,
          input.onRestoreStage,
          input.archiveRoot
        );
        if (verified.phase !== stagedJournal.phase || !sameRestoreOperation(verified, stagedJournal)) {
          throw new Error('stopped_stack_restore_journal_staging_output_invalid');
        }
      } else if (
        activeJournal.phase === 'completed' &&
        stagedJournal.phase === 'initialized' &&
        stagedJournalMatchesRequestedRestore(stagedJournal, input)
      ) {
        // A completed journal is historical.  A later source/generation is a
        // new operation, and its staged initialized record is the only valid
        // cross-operation successor.  A completed/historical scope must not
        // be promoted over the active selector merely because its staging
        // inode survived a crash.
        assertBoundedNewArchiveSupersession(activeJournal, input);
        // The staged replacement names the newer archive, but its SQLite
        // authority remains mutable recovery state. Authenticate the actual
        // incoming archive inventory before publishing its completed marker
        // or retiring the completed selector it supersedes.
        assertJournalSqliteAuthorityMatchesArchive(
          stagedJournal,
          input.verified.manifest.entries
        );
        await ensureCompletedRotationMarker(input.targetRootHandle, activeJournal.rotation, input.onRestoreStage);
        await assertRestoreScopeAvailable(input.targetRootHandle, stagedJournal.manifestHash, stagedJournal.rotation.restoreGeneration);
      } else {
        throw new Error('stopped_stack_restore_journal_staging_mismatch');
      }
      await syncAndRevalidateRegularFileAt(dataHandle, staging, staged);
      await input.onRestoreStage?.('recovered_journal_staging_file_fsynced');
      await rename(descriptorChildPath(dataHandle, staging), descriptorChildPath(dataHandle, RESTORE_JOURNAL_FILE));
      await dataHandle.sync();
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      if (!stagedJournalMatchesRequestedRestore(stagedJournal, input)) {
        throw new Error('stopped_stack_restore_journal_staging_mismatch');
      }
      await syncAndRevalidateRegularFileAt(dataHandle, staging, staged);
      await input.onRestoreStage?.('recovered_journal_staging_file_fsynced');
      await rename(descriptorChildPath(dataHandle, staging), descriptorChildPath(dataHandle, RESTORE_JOURNAL_FILE));
      await dataHandle.sync();
    }
  } finally {
    await dataHandle.close();
  }
}

export async function promoteRecoveredDatabaseRotationIntent(dataHandle, staging, body, onStage) {
  await syncAndRevalidateRegularFileAt(dataHandle, staging, body);
  // Keep the generic pre-rename seam for the existing recovered-journal
  // contract. It is now necessarily before any SQLite open for this phase.
  await onStage?.('recovered_journal_staging_file_fsynced');
  await rename(descriptorChildPath(dataHandle, staging), descriptorChildPath(dataHandle, RESTORE_JOURNAL_FILE));
  await dataHandle.sync();
}

export function sameRestoreOperation(left, right) {
  return left.manifestHash === right.manifestHash &&
    stableJson(left.rotation) === stableJson(right.rotation) &&
    stableJson(left.secretPlan) === stableJson(right.secretPlan) &&
    left.supersedesCompletedGeneration === right.supersedesCompletedGeneration;
}

export function isImmediateRestoreSuccessor(activePhase, stagedPhase) {
  const phases = [
    'initialized',
    'payload_restored',
    'database_rotation_started',
    'database_rotated',
    'secrets_published',
    'completed',
  ];
  return phases.indexOf(stagedPhase) === phases.indexOf(activePhase) + 1;
}

export function isCheckpointJournalSuccessor(active, staged) {
  if (active.phase !== 'database_rotation_started' || staged.phase !== 'database_rotation_started') return false;
  const previous = active.sqliteAuthority;
  const successor = staged.sqliteAuthority;
  // The only legal same-phase state machine is pre-family -> durable intent
  // -> durable post-checkpoint family. Any other same-phase journal is an
  // operation divergence, even if its marker/rotation fields look valid.
  if (
    !previous.checkpointIntent && !previous.checkpointTransformation &&
    successor.checkpointIntent && !successor.checkpointTransformation
  ) {
    const { checkpointIntent: _successorIntent, ...successorBase } = successor;
    return stableJson(previous) === stableJson(successorBase);
  }
  if (
    previous.checkpointIntent && !previous.checkpointTransformation &&
    !successor.checkpointIntent && successor.checkpointTransformation
  ) {
    const { checkpointIntent: _previousIntent, ...previousBase } = previous;
    const { checkpointTransformation: _successorTransformation, ...successorBase } = successor;
    return stableJson(previousBase) === stableJson(successorBase);
  }
  if (
    previous.checkpointTransformation && !previous.rotationIntent &&
    successor.checkpointTransformation && successor.rotationIntent
  ) {
    const { rotationIntent: _successorIntent, ...successorBase } = successor;
    return stableJson(previous) === stableJson(successorBase);
  }
  return false;
}

export async function assertCheckpointSuccessorRegeneratedFromArchive(input) {
  const sealedAuthority = preRotationSqliteAuthority(
    input.verified.manifest.entries,
    input.stagedJournal.rotation.sourceManifestHash
  );
  const staged = input.stagedJournal.sqliteAuthority;
  let expected;
  if (staged.checkpointIntent) {
    expected = checkpointIntentSqliteAuthority(sealedAuthority, input.stagedJournal.rotation);
  } else {
    // The staged successor is still private intent.  Do not reconstruct its
    // checkpoint in the live target merely to authenticate it: that would
    // rewrite app.db/WAL before this transition has a durably published
    // rotation authorization.  Reuse the isolated audit used by the legacy
    // pre-intent path.  Once the staged journal is promoted, the normal
    // restore path audits it again, publishes rotationIntent, and only then
    // regenerates the live family.
    const { assertCheckpointTransformationRegeneratedInIsolatedStaging } = await import('./stopped-stack-recovery-sqlite.mjs');
    await assertCheckpointTransformationRegeneratedInIsolatedStaging({
      targetRootHandle: input.targetRootHandle,
      sqliteAuthority: staged,
      openDatabase: input.openDatabase,
      archiveRoot: input.archiveRoot,
      verified: input.verified,
      rotation: input.stagedJournal.rotation,
    });
    return;
  }
  if (stableJson(staged) !== stableJson(expected)) {
    throw new Error('stopped_stack_restore_database_identity_mismatch');
  }
}

export function assertBoundedNewArchiveSupersession(completed, input) {
  if (
    completed.manifestHash === input.verified.manifestHash ||
    input.restoreGeneration <= completed.rotation.restoreGeneration
  ) {
    throw new Error('stopped_stack_restore_journal_staging_mismatch');
  }
}

export function assertJournalSqliteAuthorityMatchesArchive(journal, entries) {
  // A journal is mutable recovery state; hashes it carries are not an
  // authority to redefine the archive family.  Rebuild the pre-rotation
  // authority from the sealed manifest on every resume, including the
  // same-phase checkpoint-intent promotion window.
  const expected = preRotationSqliteAuthority(entries, journal.rotation.sourceManifestHash);
  if (
    stableJson(journal.sqliteAuthority?.preRotation) !== stableJson(expected.preRotation) ||
    stableJson(journal.sqliteAuthority?.databaseIdentity) !== stableJson(expected.databaseIdentity)
  ) {
    throw new Error('stopped_stack_restore_journal_sqlite_archive_mismatch');
  }
}

export function stagedJournalMatchesRequestedRestore(journal, input) {
  return journal.phase === 'initialized' &&
    journal.manifestHash === input.verified.manifestHash &&
    journal.rotation.deploymentId === input.restoreDeploymentId &&
    journal.rotation.restoreGeneration === input.restoreGeneration;
}

export async function publishResumableMetadata(dataHandle, markerName, value, mismatchError, onStage, stageName) {
  const body = `${stableJson(value)}\n`;
  const staging = `${markerName}.staging`;
  try {
    const existing = (await readDescriptorBound(descriptorChildPath(dataHandle, markerName), MAX_METADATA_BYTES)).body.toString('utf8');
    if (existing !== body) throw new Error(mismatchError);
    // A crash after rename can leave an old staging inode only if an external
    // writer raced us. Treat a differing one as ambiguous; retire an identical
    // one with a directory sync so a later restart sees one authoritative name.
    try {
      const staged = (await readDescriptorBound(descriptorChildPath(dataHandle, staging), MAX_METADATA_BYTES)).body.toString('utf8');
      if (staged !== body) {
        try {
          validateRotationForMarker(JSON.parse(staged));
        } catch {
          await unlinkDescriptorEntry(dataHandle, staging);
          await dataHandle.sync();
          return;
        }
        throw new Error(mismatchError);
      }
      await unlinkDescriptorEntry(dataHandle, staging);
      await dataHandle.sync();
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    return;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  let recoveredCompleteStaging = false;
  try {
    const staged = (await readDescriptorBound(descriptorChildPath(dataHandle, staging), MAX_METADATA_BYTES)).body.toString('utf8');
    if (staged !== body) {
      // A malformed staging record was never authoritative.  Discard it so
      // the exact marker can be rebuilt from the journal; a valid but
      // different record is an operation-identity conflict and stays fatal.
      try {
        const parsed = JSON.parse(staged);
        validateRotationForMarker(parsed);
      } catch {
        await unlinkDescriptorEntry(dataHandle, staging);
        await dataHandle.sync();
        await writeExclusiveDurableFileAt(dataHandle, staging, body, 0o600);
      }
      const rebuilt = (await readDescriptorBound(descriptorChildPath(dataHandle, staging), MAX_METADATA_BYTES)).body.toString('utf8');
      if (rebuilt !== body) throw new Error(mismatchError);
    } else recoveredCompleteStaging = true;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await writeExclusiveDurableFileAt(dataHandle, staging, body, 0o600);
  }
  // An exact recovered staging marker may have reached only the page cache
  // before its writer died. Re-establish both inode and name durability before
  // publishing it as a rotation/completion authority.
  await syncAndRevalidateRegularFileAt(dataHandle, staging, body);
  if (recoveredCompleteStaging) {
    await onStage?.(`recovered_${stageName}_staging_file_and_directory_fsynced`);
  }
  await rename(descriptorChildPath(dataHandle, staging), descriptorChildPath(dataHandle, markerName));
  await dataHandle.sync();
}
