#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, lstat, mkdir, open, readFile, readdir, rename, rmdir, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
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
  readDescriptorBound,
  readVerifiedInventoryEntry,
  randomToken,
  removeOwnedScratchDirectory,
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
import { rotationScope } from './stopped-stack-recovery-journal.mjs';
import { checkpointIntentSqliteAuthority, rotationIntentSqliteAuthority, sqliteFamilyIdentity, validSqliteFamilyEntries, authorizedSqliteFamilyEntries } from './stopped-stack-recovery-authority.mjs';
import { primaryDatabaseIdentity, readTargetEntry, loadDatabaseConstructor, tableExists } from './stopped-stack-recovery-postrestore.mjs';

export function isSqliteAuthorityPath(path) {
  return /\.db(?:-wal|-shm)?$/u.test(path);
}

export function sqliteDatabasePath(path) {
  return path.endsWith('-wal') || path.endsWith('-shm') ? path.slice(0, -4) : path;
}

export function archiveContainsPrimaryDatabase(entries) {
  return entries.some((entry) => entry.path === 'data/storage/app.db');
}

export async function rotateRestoredDatabase(input) {
  const { rotation, keyringId } = input;
  const dataHandle = await openChildDirectory(input.targetRootHandle, 'data');
  let storageHandle;
  let database;
  let databaseHandle;
  try {
    storageHandle = await openChildDirectory(dataHandle, 'storage');
    await assertAuthorizedSqliteFamilyIdentity(
      input.targetRootHandle,
      input.sqliteAuthority,
      'stopped_stack_restore_database_identity_mismatch'
    );
    const openDatabase = input.openDatabase ?? (await loadDatabaseConstructor());
    ({ database, handle: databaseHandle } = await openBoundSqlite(
      storageHandle,
      openDatabase,
      authorizedSqliteFamilyEntries(input.sqliteAuthority)
        .find((entry) => entry.path === 'data/storage/app.db')
    ));
    const integrity = database.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') throw new Error('stopped_stack_restore_sqlite_integrity_failed');
    database.pragma('foreign_keys = OFF');
    database.transaction(() => {
      const supportsDurableRotationMarker = typeof database.exec === 'function';
      const existingRotation = supportsDurableRotationMarker && tableExists(database, 'phase10_restore_rotation')
        ? database
          .prepare('SELECT rotation_json AS rotationJson FROM phase10_restore_rotation WHERE rotation_scope = ?')
          .get(rotationScope(rotation))
        : undefined;
      const rotationJson = stableJson({ rotation, keyringId });
      if (existingRotation) {
        if (existingRotation.rotationJson !== rotationJson) {
          throw new Error('stopped_stack_restore_rotation_resume_mismatch');
        }
        return;
      }
      if (tableExists(database, 'operator_sessions')) {
        database
          .prepare(
            `UPDATE operator_sessions SET status = 'revoked', revoked_at = 0,
             revocation_reason = 'offline_restore' WHERE status = 'active'`
          )
          .run();
      }
      for (const table of ['oidc_login_attempts', 'oidc_logout_replay']) {
        if (tableExists(database, table)) database.prepare(`DELETE FROM ${table}`).run();
      }
      if (tableExists(database, 'hosted_access_authority')) {
        const row = database
          .prepare(
            'SELECT state_json AS stateJson, revision FROM hosted_access_authority WHERE singleton = 1'
          )
          .get();
        if (row) {
          const state = JSON.parse(row.stateJson);
          if (!Number.isSafeInteger(state?.binding?.restoreGeneration)) {
            throw new Error('stopped_stack_restore_generation_not_rotated');
          }
          if (state.binding.restoreGeneration > rotation.restoreGeneration) {
            throw new Error('stopped_stack_restore_generation_not_rotated');
          }
          if (state.binding.restoreGeneration === rotation.restoreGeneration) {
            if (
              state.binding.deploymentId !== rotation.deploymentId ||
              state.expectedKeyringId !== keyringId
            ) {
              throw new Error('stopped_stack_restore_rotation_resume_mismatch');
            }
          } else {
            const nextRevision = Number(row.revision) + 1;
            const next = {
              ...state,
              binding: {
                deploymentId: rotation.deploymentId,
                restoreGeneration: rotation.restoreGeneration,
              },
              deviceFamilies: [],
              deviceGrants: [],
              expectedKeyringId: keyringId,
              pairingChallenges: [],
              resetIntent: null,
              revision: nextRevision,
              sessions: [],
            };
            database
              .prepare(
                `UPDATE hosted_access_authority SET state_json = ?, revision = ?,
                 rollback_fence_revision = ? WHERE singleton = 1`
              )
              .run(JSON.stringify(next), nextRevision, nextRevision);
          }
        }
      }
      rotateCoordinationEventEpoch(database, rotation.eventEpoch);
      const foreignKeyFailures = database.pragma('foreign_key_check');
      if (Array.isArray(foreignKeyFailures) && foreignKeyFailures.length > 0) {
        throw new Error('stopped_stack_restore_foreign_key_failed');
      }
      if (supportsDurableRotationMarker) {
        database.exec(
          'CREATE TABLE IF NOT EXISTS phase10_restore_rotation (' +
          'rotation_scope TEXT PRIMARY KEY, rotation_json TEXT NOT NULL)'
        );
        database
          .prepare('INSERT INTO phase10_restore_rotation(rotation_scope, rotation_json) VALUES (?, ?)')
          .run(rotationScope(rotation), rotationJson);
        // This runs while SQLite's transaction is still open.  Test hooks at
        // this boundary model a WAL/SHM mutation whose transaction marker is
        // not yet committed; only synchronous hooks are valid in a
        // better-sqlite3 transaction callback.
        emitSynchronousRestoreStage(input.onRestoreStage, 'database_rotation_before_marker_commit');
      }
    })();
    database.pragma('foreign_keys = ON');
    await input.onRestoreStage?.('database_rotation_before_checkpoint');
    // A successful committed rotation is authoritative through its
    // journal-bound SQLite marker.  Checkpointing is maintenance, not the
    // authority transition, and can safely be completed by an intent resume.
    database.pragma('wal_checkpoint(TRUNCATE)');
    await input.onRestoreStage?.('database_rotation_before_sidecar_cleanup');
    database.close();
    database = undefined;
    await databaseHandle.close();
    databaseHandle = undefined;
    await removeRotatedSqliteSidecars(storageHandle);
  } finally {
    database?.close();
    await databaseHandle?.close();
    await storageHandle?.close();
    await dataHandle.close();
  }
}

export function rotateCoordinationEventEpoch(database, eventEpoch) {
  if (!tableExists(database, 'coordination_event_journal_metadata')) return;
  // The metadata key is referenced by both the journal and retention leases.
  // Foreign keys are deliberately disabled for this one transaction because
  // SQLite has no deferrable migration for this composite key.  Rebind every
  // child first, then replace the parent epoch, and prove the final graph with
  // foreign_key_check before the transaction can commit.  In particular, do
  // not retire a valid lease merely because a restore rotates its epoch: its
  // floor/high-watermark/use state remains the retention contract for the
  // copied journal history.
  if (tableExists(database, 'coordination_event_journal')) {
    database.prepare('UPDATE coordination_event_journal SET event_epoch = ?').run(eventEpoch);
  }
  if (tableExists(database, 'snapshot_retention_leases')) {
    database.prepare('UPDATE snapshot_retention_leases SET event_epoch = ?').run(eventEpoch);
  }
  database
    .prepare('UPDATE coordination_event_journal_metadata SET event_epoch = ?')
    .run(eventEpoch);
}

export function emitSynchronousRestoreStage(onRestoreStage, stage) {
  const result = onRestoreStage?.(stage);
  if (result && typeof result.then === 'function') {
    throw new Error('stopped_stack_restore_async_stage_inside_sqlite_transaction');
  }
}

export async function removeRotatedSqliteSidecars(storageHandle) {
  // The primary database is held separately and never removed here.  Once
  // SQLite has closed after a successful checkpoint, stale archived sidecars
  // cannot carry pre-rotation authority into the next owner generation.
  await unlinkDescriptorEntry(storageHandle, 'app.db-wal');
  await unlinkDescriptorEntry(storageHandle, 'app.db-shm');
  await storageHandle.sync();
}

export async function prepareDatabaseRotationCheckpoint(input) {
  const authority = input.sqliteAuthority;
  if (authority.checkpointTransformation) {
    // A durable checkpoint transition is mutable recovery state, not an
    // authority in itself. This includes the crash window before
    // rotationIntent publication: self-consistent replacement hashes must
    // not authorize that intent or the following SQLite rotation.
    await assertCheckpointTransformationRegeneratedFromArchive(input, authority);
    return authority;
  }
  if (!authority.checkpointIntent) {
    throw new Error('stopped_stack_restore_checkpoint_intent_required');
  }
  // A checkpoint, journal-mode change, or sidecar retirement can change the
  // database family before we can calculate its successor digest. The durable
  // intent makes that window recoverable: rebuild the exact archived family
  // before reopening SQLite, never blessing bytes that happened to survive a
  // killed process.
  await restoreCheckpointIntentFamily(input);
  // This check happens before SQLite is allowed to open the recovered family.
  // Thus a missing or altered archived WAL/SHM is never mistaken for SQLite's
  // own checkpoint side effect.
  await assertSqliteFamilyIdentity(
    input.targetRootHandle,
    authority.preRotation,
    'stopped_stack_restore_database_identity_mismatch'
  );
  const dataHandle = await openChildDirectory(input.targetRootHandle, 'data');
  let storageHandle;
  let database;
  let databaseHandle;
  try {
    storageHandle = await openChildDirectory(dataHandle, 'storage');
    const openDb = input.openDatabase ?? (await loadDatabaseConstructor());
    ({ database, handle: databaseHandle } = await openBoundSqlite(
      storageHandle,
      openDb,
      primaryDatabaseIdentity(authority)
    ));
    if (database.pragma('integrity_check', { simple: true }) !== 'ok') {
      throw new Error('stopped_stack_restore_sqlite_integrity_failed');
    }
    // Normalize the verified WAL family before the transaction. The DELETE
    // journal mode prevents the pre-marker transaction from creating a new,
    // unrecorded WAL family; a crash there rolls back through SQLite's normal
    // rollback journal recovery rather than accepting arbitrary WAL bytes.
    await input.onRestoreStage?.('database_checkpoint_before_wal_checkpoint');
    database.pragma('wal_checkpoint(TRUNCATE)');
    await input.onRestoreStage?.('database_checkpoint_before_journal_mode_delete');
    database.pragma('journal_mode = DELETE');
    database.close();
    database = undefined;
    await databaseHandle.close();
    databaseHandle = undefined;
    await input.onRestoreStage?.('database_checkpoint_before_sidecar_cleanup');
    await removeRotatedSqliteSidecars(storageHandle);
  } finally {
    database?.close();
    await databaseHandle?.close();
    await storageHandle?.close();
    await dataHandle.close();
  }
  const postCheckpoint = await captureSqliteFamilyIdentity(input.targetRootHandle);
  const preCheckpointIdentity = sqliteFamilyIdentity(authority.preRotation);
  const postCheckpointIdentity = sqliteFamilyIdentity(postCheckpoint);
  const { checkpointIntent: _checkpointIntent, ...authorityWithoutIntent } = authority;
  return Object.freeze({
    ...authorityWithoutIntent,
    checkpointTransformation: Object.freeze({
      format: 'hosted-stopped-stack-sqlite-checkpoint-transition/v1',
      sourceManifestHash: authority.databaseIdentity?.sourceManifestHash,
      preCheckpoint: authority.preRotation,
      postCheckpoint,
      preCheckpointIdentity,
      postCheckpointIdentity,
      transitionSha256: sha256(stableJson({
        sourceManifestHash: authority.databaseIdentity?.sourceManifestHash,
        preCheckpointIdentity,
        postCheckpointIdentity,
      })),
    }),
  });
}

export async function assertCheckpointTransformationRegeneratedFromArchive(input, authority) {
  // Rebuild the sealed source family and deterministically repeat the
  // checkpoint before accepting a recorded transition. The target family is
  // not proof: an attacker can substitute a valid SQLite database and
  // recompute all journal digests before the rotation intent is published.
  await restoreCheckpointIntentFamily(input);
  const { checkpointTransformation: expectedTransformation, rotationIntent: _rotationIntent, ...base } = authority;
  const regenerated = await prepareDatabaseRotationCheckpoint({
    ...input,
    sqliteAuthority: checkpointIntentSqliteAuthority(base, input.rotation),
  });
  if (stableJson(regenerated.checkpointTransformation) !== stableJson(expectedTransformation)) {
    throw new Error('stopped_stack_restore_database_identity_mismatch');
  }
}

export async function assertCheckpointTransformationRegeneratedInIsolatedStaging(input) {
  // The legacy journal has no mutation authorization yet.  Repeating the
  // checkpoint against its target would make a kill at any SQLite seam
  // indistinguishable from a fresh pre-authorization restore.  Exercise the
  // exact archive-derived family in a private disposable tree instead; only
  // its matching result permits publication of the durable rotation intent.
  const scratch = await createOwnedScratchDirectory(tmpdir(), 'hosted-recovery-checkpoint-audit-');
  const stagingRoot = descriptorPath(scratch.handle);
  let stagingRootHandle = scratch.handle;
  try {
    await mkdir(join(stagingRoot, 'data', 'storage'), { recursive: true, mode: 0o700 });
    stagingRootHandle = await openDirectoryBound(stagingRoot);
    // A resumed `database_rotated` or later journal has post-rotation
    // evidence too.  That evidence is not an input to the deterministic
    // checkpoint replay (and it requires the later keyring id), so exclude it
    // while regenerating the archive-derived pre-rotation transformation.
    const {
      checkpointTransformation: expectedTransformation,
      rotationIntent: _rotationIntent,
      postRotation: _postRotation,
      ...base
    } = input.sqliteAuthority;
    const regenerated = await prepareDatabaseRotationCheckpoint({
      ...input,
      targetRootHandle: stagingRootHandle,
      sqliteAuthority: checkpointIntentSqliteAuthority(base, input.rotation),
      // This is an audit, not a live recovery transition.  In particular,
      // external crash hooks must cover only mutations after the durable
      // rotation intent has been published to the real target journal.
      onRestoreStage: undefined,
    });
    if (stableJson(regenerated.checkpointTransformation) !== stableJson(expectedTransformation)) {
      throw new Error('stopped_stack_restore_database_identity_mismatch');
    }
  } finally {
    await removeOwnedScratchDirectory(scratch);
  }
}

export async function auditPostRotationFamilyInIsolatedStaging(input) {
  // Completed and staged post-rotation digests are mutable journal data.  Do
  // not let them authenticate themselves: replay the complete, sealed
  // pre-rotation SQLite family in a private tree and compare its transition
  // output before admitting any resumed post-rotation application bytes.
  if (input.sqliteAuthority.preRotation.length === 0) return Object.freeze([]);
  const scratch = await createOwnedScratchDirectory(tmpdir(), 'hosted-recovery-rotation-audit-');
  const stagingRoot = descriptorPath(scratch.handle);
  let stagingRootHandle = scratch.handle;
  try {
    await mkdir(join(stagingRoot, 'data', 'storage'), { recursive: true, mode: 0o700 });
    stagingRootHandle = await openDirectoryBound(stagingRoot);
    const {
      checkpointIntent: _checkpointIntent,
      checkpointTransformation: _checkpointTransformation,
      rotationIntent: _rotationIntent,
      postRotation: _postRotation,
      ...base
    } = input.sqliteAuthority;
    let auditedAuthority = checkpointIntentSqliteAuthority(base, input.rotation);
    auditedAuthority = await prepareDatabaseRotationCheckpoint({
      ...input,
      targetRootHandle: stagingRootHandle,
      sqliteAuthority: auditedAuthority,
      // Audit replay must neither participate in live crash seams nor expose
      // a synthetic phase transition to caller test hooks.
      onRestoreStage: undefined,
    });
    auditedAuthority = rotationIntentSqliteAuthority(auditedAuthority, input.rotation);
    await rotateRestoredDatabase({
      ...input,
      targetRootHandle: stagingRootHandle,
      sqliteAuthority: auditedAuthority,
      onRestoreStage: undefined,
    });
    return await captureSqliteFamilyIdentity(stagingRootHandle);
  } finally {
    await removeOwnedScratchDirectory(scratch);
  }
}

export async function restoreCheckpointIntentFamily(input) {
  const expected = input.sqliteAuthority.preRotation;
  const expectedNames = new Set(expected.map((entry) => entry.path));
  const dataHandle = await openChildDirectory(input.targetRootHandle, 'data');
  let storageHandle;
  try {
    storageHandle = await openChildDirectory(dataHandle, 'storage');
    // Retire only SQLite siblings; unrelated application records remain
    // journal-bound payload. The following copies are descriptor-verified
    // against the sealed archive inventory.
    for (const name of ['app.db', 'app.db-wal', 'app.db-shm']) {
      if (!expectedNames.has(`data/storage/${name}`)) {
        await unlinkDescriptorEntry(storageHandle, name);
      }
    }
    for (const entry of expected) {
      await copyVerifiedInventoryEntry(
        join(input.archiveRoot, 'payload'),
        input.verified.inventory,
        entry,
        input.targetRootHandle,
        true
      );
    }
    await storageHandle.sync();
  } finally {
    await storageHandle?.close();
    await dataHandle.close();
  }
  await assertSqliteFamilyIdentity(
    input.targetRootHandle,
    expected,
    'stopped_stack_restore_database_identity_mismatch'
  );
}

export async function captureSqliteFamilyIdentity(targetRootHandle) {
  const entries = [];
  for (const path of ['data/storage/app.db', 'data/storage/app.db-wal', 'data/storage/app.db-shm']) {
    try {
      const actual = await readTargetEntry(targetRootHandle, path);
      entries.push(Object.freeze({
        path,
        byteLength: actual.stat.size,
        mode: actual.stat.mode & 0o777,
        sha256: sha256(actual.body),
      }));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  if (!validSqliteFamilyEntries(entries)) {
    throw new Error('stopped_stack_restore_database_identity_mismatch');
  }
  return Object.freeze(entries);
}

export async function assertAuthorizedSqliteFamilyIdentity(targetRootHandle, authority, errorCode) {
  await assertSqliteFamilyIdentity(targetRootHandle, authorizedSqliteFamilyEntries(authority), errorCode);
}

export async function assertSqliteFamilyIdentity(targetRootHandle, expectedEntries, errorCode) {
  const expectedByPath = new Map(expectedEntries.map((entry) => [entry.path, entry]));
  for (const path of ['data/storage/app.db', 'data/storage/app.db-wal', 'data/storage/app.db-shm']) {
    const expected = expectedByPath.get(path);
    try {
      const actual = await readTargetEntry(targetRootHandle, path);
      if (!expected || actual.stat.size !== expected.byteLength ||
        (actual.stat.mode & 0o777) !== expected.mode || sha256(actual.body) !== expected.sha256) {
        throw new Error(errorCode);
      }
    } catch (error) {
      if (error?.message === errorCode) throw error;
      if (error?.code === 'ENOENT' && !expected) continue;
      throw new Error(errorCode);
    }
  }
}

export async function matchesSqliteFamilyIdentity(targetRootHandle, expectedEntries) {
  try {
    await assertSqliteFamilyIdentity(targetRootHandle, expectedEntries, '__sqlite_family_mismatch__');
    return true;
  } catch (error) {
    if (error?.message === '__sqlite_family_mismatch__') return false;
    throw error;
  }
}

export async function hasUnauthorizedSqliteSidecar(targetRootHandle, expectedEntries) {
  const expected = new Set(expectedEntries.map((entry) => entry.path));
  for (const path of ['data/storage/app.db-wal', 'data/storage/app.db-shm']) {
    let present = false;
    try {
      await readTargetEntry(targetRootHandle, path);
      present = true;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (present !== expected.has(path)) return true;
  }
  return false;
}

export async function openBoundSqlite(storageHandle, openDatabase, expectedPrimaryIdentity) {
  // SQLite may make several internal opens (journal/WAL included), so bind and
  // hold app.db's final component ourselves.  Opening through this held FD
  // keeps the primary database object tied to the no-follow inode even if an
  // attacker replaces the app.db pathname between recovery phases.
  let handle;
  let database;
  try {
    handle = await open(
      descriptorChildPath(storageHandle, 'app.db'),
      // Recovery is never allowed to create a new primary.  In particular, a
      // resumed database_rotation_started journal must fail closed if a crash
      // or attacker removed app.db before SQLite can create WAL/SHM sidecars.
      constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    const expected = await handle.stat({ bigint: true });
    if (!expected.isFile()) throw new Error('stopped_stack_restore_database_invalid');
    if (expectedPrimaryIdentity) {
      await assertBoundSqlitePrimaryIdentity(handle, expectedPrimaryIdentity);
    }
    await assertCurrentSqliteIdentity(storageHandle, expected);
    database = openDatabase(`/proc/self/fd/${handle.fd}`);
    // The constructor may synchronously open the database.  Check the final
    // component again before accepting the connection or resuming a journal.
    await assertCurrentSqliteIdentity(storageHandle, expected);
    const held = await handle.stat({ bigint: true });
    if (held.dev !== expected.dev || held.ino !== expected.ino) {
      throw new Error('stopped_stack_restore_database_replaced');
    }
    return { database, handle };
  } catch (error) {
    database?.close();
    await handle?.close();
    if (error?.code === 'ENOENT' && !handle) {
      throw new Error('stopped_stack_restore_database_identity_mismatch');
    }
    if (['ELOOP', 'ENOENT', 'ENOTDIR'].includes(error?.code)) {
      throw new Error('stopped_stack_restore_database_replaced');
    }
    throw error;
  }
}

export async function assertBoundSqlitePrimaryIdentity(handle, expected) {
  const before = await handle.stat();
  if (
    !before.isFile() || before.size !== expected.byteLength ||
    (before.mode & 0o777) !== expected.mode
  ) {
    throw new Error('stopped_stack_restore_database_identity_mismatch');
  }
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  while (position < before.size) {
    const { bytesRead } = await handle.read(
      buffer,
      0,
      Math.min(buffer.byteLength, before.size - position),
      position
    );
    if (bytesRead === 0) throw new Error('stopped_stack_restore_database_identity_mismatch');
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  const after = await handle.stat();
  if (
    !after.isFile() || after.size !== before.size ||
    (after.mode & 0o777) !== (before.mode & 0o777) ||
    hash.digest('hex') !== expected.sha256
  ) {
    throw new Error('stopped_stack_restore_database_identity_mismatch');
  }
}

export async function assertCurrentSqliteIdentity(storageHandle, expected) {
  let current;
  try {
    current = await open(
      descriptorChildPath(storageHandle, 'app.db'),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    const observed = await current.stat({ bigint: true });
    if (!observed.isFile() || observed.dev !== expected.dev || observed.ino !== expected.ino) {
      throw new Error('stopped_stack_restore_database_replaced');
    }
  } finally {
    await current?.close();
  }
}

export function verifyDatabaseRotation(database, rotation, keyringId) {
  if (typeof database.exec === 'function') {
    if (!tableExists(database, 'phase10_restore_rotation')) {
      throw new Error('stopped_stack_restore_journal_rotation_invalid');
    }
    const marker = database
      .prepare('SELECT rotation_json AS rotationJson FROM phase10_restore_rotation WHERE rotation_scope = ?')
      .get(rotationScope(rotation));
    if (!marker || marker.rotationJson !== stableJson({ rotation, keyringId })) {
      throw new Error('stopped_stack_restore_journal_rotation_invalid');
    }
  }
  if (tableExists(database, 'operator_sessions')) {
    const active = database.prepare("SELECT count(*) AS count FROM operator_sessions WHERE status = 'active'").get();
    if (Number(active?.count) !== 0) throw new Error('stopped_stack_restore_journal_revocation_invalid');
  }
  for (const table of ['oidc_login_attempts', 'oidc_logout_replay']) {
    if (tableExists(database, table)) {
      const rows = database.prepare(`SELECT count(*) AS count FROM ${table}`).get();
      if (Number(rows?.count) !== 0) throw new Error('stopped_stack_restore_journal_revocation_invalid');
    }
  }
  if (tableExists(database, 'hosted_access_authority')) {
    const row = database.prepare('SELECT state_json AS stateJson FROM hosted_access_authority WHERE singleton = 1').get();
    if (row) {
      const state = JSON.parse(row.stateJson);
      if (
        state?.binding?.deploymentId !== rotation.deploymentId ||
        state.binding.restoreGeneration !== rotation.restoreGeneration ||
        state.expectedKeyringId !== keyringId ||
        !Array.isArray(state.sessions) || state.sessions.length !== 0 ||
        !Array.isArray(state.deviceFamilies) || state.deviceFamilies.length !== 0 ||
        !Array.isArray(state.deviceGrants) || state.deviceGrants.length !== 0
      ) throw new Error('stopped_stack_restore_journal_rotation_invalid');
    }
  }
  for (const table of ['coordination_event_journal', 'coordination_event_journal_metadata']) {
    if (!tableExists(database, table)) continue;
    const mismatches = database.prepare(`SELECT count(*) AS count FROM ${table} WHERE event_epoch <> ?`).get(rotation.eventEpoch);
    if (Number(mismatches?.count) !== 0) throw new Error('stopped_stack_restore_journal_rotation_invalid');
  }
  const foreignKeyFailures = database.pragma('foreign_key_check');
  if (Array.isArray(foreignKeyFailures) && foreignKeyFailures.length > 0) {
    throw new Error('stopped_stack_restore_foreign_key_failed');
  }
}
