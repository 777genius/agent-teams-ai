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

// Authority validation is a pure layer.  Keep the common SQLite-path and
// restore-scope predicates here rather than importing higher lifecycle
// layers; orchestration below obtains its IO collaborators explicitly.
const isSqliteAuthorityPath = (path) => /\.db(?:-wal|-shm)?$/u.test(path);
const rotationScope = (rotation) => `${rotation.sourceManifestHash}.g-${rotation.restoreGeneration}`;

export function validateRotationForMarker(value) {
  validateRestoreJournal({
    format: RESTORE_JOURNAL_FORMAT,
    schemaVersion: 1,
    manifestHash: value?.sourceManifestHash,
    phase: 'initialized',
    rotation: value,
    secretPlan: {
      identityKey: 'x'.repeat(32),
      keyring: {
        binding: { deploymentId: value?.deploymentId, restoreGeneration: value?.restoreGeneration },
        createdAt: 0,
        csrfKey: 'x'.repeat(32),
        format: 'hosted-access-keyring/v1',
        hashKey: 'x'.repeat(32),
        keyringId: 'akr_x123456789012345678',
      },
    },
    sqliteAuthority: {
      format: SQLITE_AUTHORITY_FORMAT,
      schemaVersion: 1,
      preRotation: [],
      databaseIdentity: null,
    },
  });
}

export function validateRestoreJournal(journal) {
  const commonInvalid =
    journal?.format !== RESTORE_JOURNAL_FORMAT ||
    journal.schemaVersion !== 1 ||
    !/^[0-9a-f]{64}$/.test(journal?.manifestHash) ||
    !journal.rotation ||
    journal.rotation.format !== ROTATION_FORMAT ||
    journal.rotation.schemaVersion !== 1;
  const commonRotationInvalid =
    !DEPLOYMENT_ID_PATTERN.test(journal?.rotation?.deploymentId) ||
    !/^[0-9a-f]{64}$/.test(journal?.rotation?.sourceManifestHash) ||
    !Number.isSafeInteger(journal?.rotation?.restoreGeneration) ||
    journal.rotation.restoreGeneration <= 0 ||
    typeof journal.rotation.bootId !== 'string' ||
    typeof journal.rotation.eventEpoch !== 'string' ||
    journal.rotation.browserAuthorityRotated !== true ||
    journal.rotation.runtimeAuthorityRotationRequired !== true ||
    journal.rotation.freshMountBindingsRequired !== true;
  const activePlanInvalid =
    typeof journal.secretPlan?.identityKey !== 'string' ||
    journal.secretPlan.identityKey.length < 32 ||
    journal.secretPlan?.keyring?.format !== 'hosted-access-keyring/v1' ||
    journal.secretPlan.keyring.binding?.deploymentId !== journal.rotation.deploymentId ||
    journal.secretPlan.keyring.binding?.restoreGeneration !== journal.rotation.restoreGeneration ||
    typeof journal.secretPlan.keyring.keyringId !== 'string' ||
    !/^akr_x[A-Za-z0-9_-]{18,}$/.test(journal.secretPlan.keyring.keyringId) ||
    typeof journal.secretPlan.keyring.csrfKey !== 'string' ||
    journal.secretPlan.keyring.csrfKey.length < 32 ||
    typeof journal.secretPlan.keyring.hashKey !== 'string' ||
    journal.secretPlan.keyring.hashKey.length < 32 ||
    journal.secretPlan.keyring.createdAt !== 0;
  const sqliteAuthorityInvalid = !validSqliteAuthority(
    journal?.sqliteAuthority,
    journal.rotation,
    journal.secretPlan?.keyring?.keyringId,
    { allowMissingPost: ['initialized', 'payload_restored', 'database_rotation_started'].includes(journal?.phase) }
  );
  const phaseInvalid = ![
    'initialized',
    'payload_restored',
    'database_rotation_started',
    'database_rotated',
    'secrets_published',
    'completed',
  ].includes(
    journal?.phase
  );
  const completedInvalid = journal?.phase === 'completed' &&
    (typeof journal.keyringId !== 'string' || journal.keyringId !== journal.secretPlan?.keyring?.keyringId || !/^[0-9a-f]{64}$/.test(journal.secretPlanSha256) || journal.secretPlanSha256 !== sha256(stableJson(journal.secretPlan)));
  if (commonInvalid || journal.manifestHash !== journal.rotation?.sourceManifestHash || commonRotationInvalid || phaseInvalid || activePlanInvalid || sqliteAuthorityInvalid || completedInvalid || (journal.supersedesCompletedGeneration !== undefined && journal.supersedesCompletedGeneration !== true)) {
    throw new Error('stopped_stack_restore_journal_invalid');
  }
}

export function preRotationSqliteAuthority(entries, sourceManifestHash) {
  const preRotation = entries
    .filter((entry) => isSqliteAuthorityPath(entry.path))
    .map((entry) => Object.freeze({
      path: entry.path,
      byteLength: entry.byteLength,
      mode: entry.mode,
      sha256: entry.sha256,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const primary = preRotation.find((entry) => entry.path === 'data/storage/app.db');
  return Object.freeze({
    format: SQLITE_AUTHORITY_FORMAT,
    schemaVersion: 1,
    preRotation,
    // This legacy primary field remains for descriptor-bound opens. The
    // authority decision itself is made from preRotation as a complete SQLite
    // family: committed WAL frames are database contents, not optional cache.
    databaseIdentity: primary
      ? Object.freeze({ sourceManifestHash, ...primary })
      : null,
  });
}

export function postRotationSqliteAuthority(authority, rotation, keyringId, databaseFamily, auditedDatabaseFamily = databaseFamily) {
  if (!validSqliteAuthority(authority, rotation, keyringId, { allowMissingPost: true })) {
    throw new Error('stopped_stack_restore_journal_sqlite_authority_invalid');
  }
  const databaseFree = authority.preRotation.length === 0;
  if (!validSqliteFamilyEntries(databaseFamily, { allowEmpty: databaseFree }) ||
    !validSqliteFamilyEntries(auditedDatabaseFamily, { allowEmpty: databaseFree }) ||
    (databaseFree && (databaseFamily.length !== 0 || auditedDatabaseFamily.length !== 0)) ||
    stableJson(databaseFamily) !== stableJson(auditedDatabaseFamily)) {
    throw new Error('stopped_stack_restore_journal_sqlite_authority_invalid');
  }
  const { rotationIntent: _rotationIntent, ...authorityWithoutIntent } = authority;
  const databaseFamilyIdentity = sqliteFamilyIdentity(databaseFamily);
  const checkpointIdentity = sqliteFamilyIdentity(authorizedSqliteFamilyEntries(authority));
  const preRotationIdentity = sqliteFamilyIdentity(authority.preRotation);
  const audit = Object.freeze({
    format: 'hosted-stopped-stack-sqlite-rotation-transition/v1',
    sourceManifestHash: rotation.sourceManifestHash,
    rotationScope: rotationScope(rotation),
    preRotationIdentity,
    checkpointIdentity,
    databaseFamilyIdentity,
    auditSha256: sha256(stableJson({
      sourceManifestHash: rotation.sourceManifestHash,
      rotationScope: rotationScope(rotation),
      preRotationIdentity,
      checkpointIdentity,
      databaseFamilyIdentity,
      rotationSha256: sha256(stableJson({ rotation, keyringId })),
    })),
  });
  return Object.freeze({
    ...authorityWithoutIntent,
    postRotation: Object.freeze({
      databaseFamily,
      databaseFamilyIdentity,
      rotationScope: rotationScope(rotation),
      // This version marker makes pre-admission journals fail closed unless
      // they were produced by a recovery path that supports the independently
      // replayed immutable-archive family check in the Node admission layer.
      immutableArchiveReplay: Object.freeze({
        format: 'hosted-immutable-restore-archive-replay/v1',
        sourceManifestHash: rotation.sourceManifestHash,
        restoreGeneration: rotation.restoreGeneration,
        rotationScope: rotationScope(rotation),
      }),
      rotationSha256: sha256(stableJson({ rotation, keyringId })),
      audit,
    }),
  });
}

export function rotationIntentSqliteAuthority(authority, rotation) {
  if (!authority.checkpointTransformation || authority.rotationIntent ||
    !validSqliteAuthority(authority, rotation, undefined, { allowMissingPost: true })) {
    throw new Error('stopped_stack_restore_journal_sqlite_authority_invalid');
  }
  const intent = Object.freeze({
    format: 'hosted-stopped-stack-sqlite-rotation-intent/v1',
    checkpointIdentity: authority.checkpointTransformation.postCheckpointIdentity,
    sourceManifestHash: rotation.sourceManifestHash,
    intentSha256: sha256(stableJson({
      checkpointIdentity: authority.checkpointTransformation.postCheckpointIdentity,
      sourceManifestHash: rotation.sourceManifestHash,
    })),
  });
  return Object.freeze({ ...authority, rotationIntent: intent });
}

export function checkpointIntentSqliteAuthority(authority, rotation) {
  if (!validSqliteAuthority(authority, rotation, undefined, { allowMissingPost: true }) ||
    authority.checkpointTransformation || authority.checkpointIntent) {
    throw new Error('stopped_stack_restore_journal_sqlite_authority_invalid');
  }
  const preCheckpointIdentity = sqliteFamilyIdentity(authority.preRotation);
  const intent = Object.freeze({
    format: 'hosted-stopped-stack-sqlite-checkpoint-intent/v1',
    sourceManifestHash: rotation.sourceManifestHash,
    preCheckpoint: authority.preRotation,
    preCheckpointIdentity,
    intentSha256: sha256(stableJson({
      sourceManifestHash: rotation.sourceManifestHash,
      preCheckpointIdentity,
    })),
  });
  return Object.freeze({ ...authority, checkpointIntent: intent });
}

export function validSqliteAuthority(authority, rotation, keyringId, options = {}) {
  if (authority?.format !== SQLITE_AUTHORITY_FORMAT || authority.schemaVersion !== 1 ||
    !Array.isArray(authority.preRotation)) return false;
  const names = new Set();
  for (const entry of authority.preRotation) {
    if (!isSqliteAuthorityPath(entry?.path) || names.has(entry.path) ||
      !Number.isSafeInteger(entry.byteLength) || entry.byteLength < 0 ||
      !Number.isSafeInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777 ||
      !/^[0-9a-f]{64}$/u.test(entry.sha256 ?? '')) return false;
    names.add(entry.path);
  }
  const primary = authority.preRotation.find((entry) => entry.path === 'data/storage/app.db');
  const identity = authority.databaseIdentity;
  if (!primary) {
    // Database-free archives are explicitly supported, but a marker-only
    // WAL/SHM family is never a database-free archive.
    if (identity !== null || authority.preRotation.length !== 0) return false;
  } else if (
    !identity || identity.sourceManifestHash !== rotation.sourceManifestHash ||
    identity.path !== primary.path || identity.byteLength !== primary.byteLength ||
    identity.mode !== primary.mode || identity.sha256 !== primary.sha256
  ) return false;
  if (authority.checkpointIntent !== undefined &&
    !validCheckpointIntent(authority.checkpointIntent, authority, rotation)) return false;
  if (authority.checkpointTransformation !== undefined &&
    !validCheckpointTransformation(authority.checkpointTransformation, authority, rotation)) return false;
  if (authority.checkpointIntent !== undefined && authority.checkpointTransformation !== undefined) return false;
  if (authority.rotationIntent !== undefined &&
    !validRotationIntent(authority.rotationIntent, authority, rotation)) return false;
  const post = authority.postRotation;
  if (!post) return options.allowMissingPost === true;
  return post.rotationScope === rotationScope(rotation) &&
    validSqliteFamilyEntries(post.databaseFamily, { allowEmpty: !primary }) &&
    (primary || post.databaseFamily.length === 0) &&
    post.databaseFamilyIdentity === sqliteFamilyIdentity(post.databaseFamily) &&
    post.rotationSha256 === sha256(stableJson({ rotation, keyringId })) &&
    validImmutableArchiveReplay(post.immutableArchiveReplay, rotation) &&
    validPostRotationAudit(post.audit, authority, rotation, keyringId, post);
}

function validImmutableArchiveReplay(replay, rotation) {
  return replay?.format === 'hosted-immutable-restore-archive-replay/v1' &&
    replay.sourceManifestHash === rotation.sourceManifestHash &&
    replay.restoreGeneration === rotation.restoreGeneration &&
    replay.rotationScope === rotationScope(rotation);
}

export function validPostRotationAudit(audit, authority, rotation, keyringId, post) {
  const preRotationIdentity = sqliteFamilyIdentity(authority.preRotation);
  const checkpointIdentity = sqliteFamilyIdentity(authorizedSqliteFamilyEntries(authority));
  return audit?.format === 'hosted-stopped-stack-sqlite-rotation-transition/v1' &&
    audit.sourceManifestHash === rotation.sourceManifestHash &&
    audit.rotationScope === rotationScope(rotation) &&
    audit.preRotationIdentity === preRotationIdentity &&
    audit.checkpointIdentity === checkpointIdentity &&
    audit.databaseFamilyIdentity === post.databaseFamilyIdentity &&
    audit.auditSha256 === sha256(stableJson({
      sourceManifestHash: rotation.sourceManifestHash,
      rotationScope: rotationScope(rotation),
      preRotationIdentity,
      checkpointIdentity,
      databaseFamilyIdentity: post.databaseFamilyIdentity,
      rotationSha256: sha256(stableJson({ rotation, keyringId })),
    }));
}

export function validRotationIntent(intent, authority, rotation) {
  return authority.checkpointTransformation && intent?.format === 'hosted-stopped-stack-sqlite-rotation-intent/v1' &&
    intent.sourceManifestHash === rotation.sourceManifestHash &&
    intent.checkpointIdentity === authority.checkpointTransformation.postCheckpointIdentity &&
    intent.intentSha256 === sha256(stableJson({
      checkpointIdentity: intent.checkpointIdentity,
      sourceManifestHash: intent.sourceManifestHash,
    }));
}

export function validCheckpointIntent(intent, authority, rotation) {
  return intent?.format === 'hosted-stopped-stack-sqlite-checkpoint-intent/v1' &&
    intent.sourceManifestHash === rotation.sourceManifestHash &&
    validSqliteFamilyEntries(intent.preCheckpoint) &&
    stableJson(intent.preCheckpoint) === stableJson(authority.preRotation) &&
    intent.preCheckpointIdentity === sqliteFamilyIdentity(intent.preCheckpoint) &&
    intent.intentSha256 === sha256(stableJson({
      sourceManifestHash: intent.sourceManifestHash,
      preCheckpointIdentity: intent.preCheckpointIdentity,
    }));
}

export function sqliteFamilyIdentity(entries) {
  return sha256(stableJson(entries));
}

export function validSqliteFamilyEntries(entries, options = {}) {
  if (!Array.isArray(entries)) return false;
  const names = new Set();
  for (const entry of entries) {
    if (!isSqliteAuthorityPath(entry?.path) || names.has(entry.path) ||
      !Number.isSafeInteger(entry.byteLength) || entry.byteLength < 0 ||
      !Number.isSafeInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777 ||
      !/^[0-9a-f]{64}$/u.test(entry.sha256 ?? '')) return false;
    names.add(entry.path);
  }
  return names.has('data/storage/app.db') || (options.allowEmpty === true && names.size === 0);
}

export function validCheckpointTransformation(transformation, authority, rotation) {
  if (transformation?.format !== 'hosted-stopped-stack-sqlite-checkpoint-transition/v1' ||
    transformation.sourceManifestHash !== rotation.sourceManifestHash ||
    !validSqliteFamilyEntries(transformation.preCheckpoint) ||
    !validSqliteFamilyEntries(transformation.postCheckpoint) ||
    stableJson(transformation.preCheckpoint) !== stableJson(authority.preRotation) ||
    transformation.preCheckpointIdentity !== sqliteFamilyIdentity(transformation.preCheckpoint) ||
    transformation.postCheckpointIdentity !== sqliteFamilyIdentity(transformation.postCheckpoint) ||
    transformation.preCheckpointIdentity !== sqliteFamilyIdentity(authority.preRotation)) return false;
  return transformation.transitionSha256 === sha256(stableJson({
    sourceManifestHash: transformation.sourceManifestHash,
    preCheckpointIdentity: transformation.preCheckpointIdentity,
    postCheckpointIdentity: transformation.postCheckpointIdentity,
  }));
}

export function authorizedSqliteFamilyEntries(authority) {
  return authority.checkpointTransformation?.postCheckpoint ?? authority.preRotation;
}

export async function verifyJournalPhaseOutputs(targetRootHandle, verified, journal, openDatabase, onStage, archiveRoot) {
  const [sqlite, journalStore, postrestore] = await Promise.all([
    import('./stopped-stack-recovery-sqlite.mjs'),
    import('./stopped-stack-recovery-journal.mjs'),
    import('./stopped-stack-recovery-postrestore.mjs'),
  ]);
  const {
    archiveContainsPrimaryDatabase, assertSqliteFamilyIdentity,
    matchesSqliteFamilyIdentity, hasUnauthorizedSqliteSidecar,
    openBoundSqlite, verifyDatabaseRotation, auditPostRotationFamilyInIsolatedStaging,
  } = sqlite;
  const { ensureRotationMarker, assertJournalSqliteAuthorityMatchesArchive } = journalStore;
  const {
    verifyRestoredDeploymentHeader, inspectDatabaseRotationIntentWindow,
    verifyPreRotationSqliteAuthority, readTargetEntry, phaseBefore,
    loadDatabaseConstructor,
  } = postrestore;
  validateRestoreJournal(journal);
  // Do this before any phase branch or SQLite inspection.  It keeps the
  // complete archive inventory and the primary identity mandatory after the
  // initial journal, instead of trusting a self-consistent proposed journal.
  assertJournalSqliteAuthorityMatchesArchive(journal, verified.manifest.entries);
  await ensureRotationMarker(targetRootHandle, journal.rotation, onStage);
  if (phaseBefore(journal.phase, 'payload_restored')) return journal;
  for (const entry of verified.manifest.entries) {
    if (isRecoveryControlPath(entry.path) || entry.path.startsWith('data/hosted-auth-secrets/')) continue;
    // app.db is intentionally mutable after the rotation transaction.  Its
    // phase-specific identity is checked below rather than against archive
    // bytes, including the transaction/journal crash window.
    if (isSqliteAuthorityPath(entry.path) || entry.path === 'data/hosted-state-header.v1.json') continue;
    const actual = await readTargetEntry(targetRootHandle, entry.path);
    if (
      actual.stat.size !== entry.byteLength ||
      (actual.stat.mode & 0o777) !== entry.mode ||
      sha256(actual.body) !== entry.sha256
    ) {
      throw new Error('stopped_stack_restore_journal_payload_invalid');
    }
  }
  await verifyRestoredDeploymentHeader(targetRootHandle, verified.stateHeader, journal.rotation);
  if (phaseBefore(journal.phase, 'database_rotated')) {
    if (journal.phase === 'database_rotation_started') {
      if (!archiveContainsPrimaryDatabase(verified.manifest.entries)) {
        // There is no database family to rotate.  The journal is still
        // advanced by the caller, but recovery must not create an empty
        // primary just to run a no-op authority transition.
        return journal;
      }
      // The rotation intent is the sole authority for a transaction that may
      // have committed before its full post-rotation family digest reached the
      // journal. Never inspect a marker-only database in that window; the
      // caller rebuilds the sealed pre-rotation family and replays it.
      if (journal.sqliteAuthority.rotationIntent) return journal;
      if (journal.sqliteAuthority.checkpointTransformation) {
        // This is the pre-intent legacy recovery window.  A prior interrupted
        // regeneration may already have restored archive WAL/SHM sidecars,
        // while the recorded checkpoint family intentionally omits them.
        // Those restored sidecars are neither proof nor a tamper signal at
        // this point: the caller first replays the transition in isolated
        // staging, publishes its durable intent, and only then mutates the
        // target.  Rejecting them here would strand precisely the recovery
        // state that the authorization repair is meant to resume.
        return journal;
      }
      // No SQLite inspection is allowed until the exact full database family
      // matches either archive identity or the journal's durable checkpoint
      // transition. A WAL frame can contain a committed row absent from
      // app.db, so primary-only matching loses authority here.
      const familyMatchesAuthorizedCheckpoint = await matchesSqliteFamilyIdentity(
        targetRootHandle,
        authorizedSqliteFamilyEntries(journal.sqliteAuthority)
      );
      if (!familyMatchesAuthorizedCheckpoint && !journal.sqliteAuthority.checkpointTransformation && !journal.sqliteAuthority.checkpointIntent) {
        throw new Error('stopped_stack_restore_database_identity_mismatch');
      }
      if (!familyMatchesAuthorizedCheckpoint && !journal.sqliteAuthority.checkpointIntent && await hasUnauthorizedSqliteSidecar(
        targetRootHandle,
        authorizedSqliteFamilyEntries(journal.sqliteAuthority)
      )) {
        // The authorized post-checkpoint state has no WAL/SHM. SQLite's
        // DELETE-mode rotation never creates one, so an added sidecar cannot
        // be repaired or silently consumed by inspection.
        throw new Error('stopped_stack_restore_database_identity_mismatch');
      }
      // A newly published intent still names the archived WAL family. Do not
      // inspect it here: merely opening SQLite can alter WAL/SHM. The caller
      // first performs and durably records the authorized checkpoint
      // transition, then a later resume may inspect that recorded family.
      if (!journal.sqliteAuthority.checkpointTransformation) return journal;
      const markerCommitted = await inspectDatabaseRotationIntentWindow(
        targetRootHandle,
        journal,
        openDatabase,
        familyMatchesAuthorizedCheckpoint
      );
      if (!markerCommitted && !familyMatchesAuthorizedCheckpoint) {
        // A SIGKILL in a DELETE-mode transaction can leave a rollback journal
        // which SQLite recovers while inspecting the held primary. Re-check
        // the authenticated checkpoint family after that recovery; no WAL or
        // SHM discrepancy was permitted above.
        if (!await matchesSqliteFamilyIdentity(
          targetRootHandle,
          authorizedSqliteFamilyEntries(journal.sqliteAuthority)
        )) throw new Error('stopped_stack_restore_database_identity_mismatch');
      }
      if (!markerCommitted) return journal;
      throw new Error('stopped_stack_restore_rotation_intent_required');
    }
    try {
      await verifyPreRotationSqliteAuthority(targetRootHandle, journal.sqliteAuthority);
      return journal;
    } catch (error) {
      if (error?.message !== 'stopped_stack_restore_journal_sqlite_pre_rotation_invalid') throw error;
    }
    // A journal without an intent cannot use a database marker as authority.
    // Refuse legacy marker-only recovery rather than admitting substituted
    // application bytes.
    throw new Error('stopped_stack_restore_rotation_intent_required');
  }
  if (!journal.sqliteAuthority.postRotation ||
    !validSqliteAuthority(journal.sqliteAuthority, journal.rotation, journal.secretPlan.keyring.keyringId)) {
    throw new Error('stopped_stack_restore_journal_sqlite_authority_invalid');
  }
  const auditedDatabaseFamily = await auditPostRotationFamilyInIsolatedStaging({
    targetRootHandle,
    sqliteAuthority: journal.sqliteAuthority,
    openDatabase,
    archiveRoot,
    verified,
    rotation: journal.rotation,
    keyringId: journal.secretPlan.keyring.keyringId,
  });
  if (stableJson(auditedDatabaseFamily) !== stableJson(journal.sqliteAuthority.postRotation.databaseFamily)) {
    throw new Error('stopped_stack_restore_database_identity_mismatch');
  }
  await assertSqliteFamilyIdentity(
    targetRootHandle,
    journal.sqliteAuthority.postRotation.databaseFamily,
    'stopped_stack_restore_database_identity_mismatch'
  );
  const databaseEntry = verified.manifest.entries.find((entry) => entry.path === 'data/storage/app.db');
  if (databaseEntry) {
    const dataHandle = await openChildDirectory(targetRootHandle, 'data');
    let storageHandle;
    let database;
    let databaseHandle;
    try {
      storageHandle = await openChildDirectory(dataHandle, 'storage');
      const openDb = openDatabase ?? (await loadDatabaseConstructor());
      ({ database, handle: databaseHandle } = await openBoundSqlite(storageHandle, openDb));
      if (database.pragma('integrity_check', { simple: true }) !== 'ok') {
        throw new Error('stopped_stack_restore_journal_database_invalid');
      }
      verifyDatabaseRotation(database, journal.rotation, journal.secretPlan.keyring.keyringId);
    } finally {
      database?.close();
      await databaseHandle?.close();
      await storageHandle?.close();
      await dataHandle.close();
    }
  }
  if (phaseBefore(journal.phase, 'secrets_published')) return journal;
  const dataHandle = await openChildDirectory(targetRootHandle, 'data');
  let secretsHandle;
  try {
    secretsHandle = await openChildDirectory(dataHandle, 'hosted-auth-secrets');
    const secretEntries = await readBoundedDirectoryEntries(secretsHandle, 2);
    if (secretEntries.length !== 2 ||
      !secretEntries.includes('personal-keyring.json') ||
      !secretEntries.includes('identity.key')) {
      throw new Error('stopped_stack_restore_journal_secrets_inventory_invalid');
    }
    const [keyring, identity] = await Promise.all([
      readDescriptorBound(descriptorChildPath(secretsHandle, 'personal-keyring.json'), MAX_METADATA_BYTES),
      readDescriptorBound(descriptorChildPath(secretsHandle, 'identity.key'), MAX_METADATA_BYTES),
    ]);
    const expected = { keyring: `${stableJson(journal.secretPlan.keyring)}\n`, identity: `${journal.secretPlan.identityKey}\n` };
    const observedKeyring = JSON.parse(keyring.body.toString('utf8'));
    if (
      keyring.body.toString('utf8') !== expected.keyring || identity.body.toString('utf8') !== expected.identity ||
      observedKeyring?.keyringId !== journal.secretPlan.keyring.keyringId || observedKeyring?.csrfKey !== journal.secretPlan.keyring.csrfKey || observedKeyring?.hashKey !== journal.secretPlan.keyring.hashKey
    ) {
      throw new Error('stopped_stack_restore_journal_secrets_invalid');
    }
  } finally {
    await secretsHandle?.close();
    await dataHandle.close();
  }
  return journal;
}
