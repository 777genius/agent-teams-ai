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

export async function transitionRestoredDeploymentHeader(targetRootHandle, archivedHeader, rotation, onStage) {
  const dataHandle = await openChildDirectory(targetRootHandle, 'data');
  const headerName = 'hosted-state-header.v1.json';
  const staging = `${headerName}.restore-staging`;
  try {
    // The target copy is not an authority for a resumed restore.  It may be
    // the source header left by the payload copy, or an attacker-modified
    // inode.  Derive the replacement only from the archive header that was
    // just verified and the active journal-bound rotation.
    const source = normalizeHostedStateHeader(archivedHeader, 'stopped_stack_restore_state_header_invalid');
    if (source.deploymentId === rotation.deploymentId) return;
    const desiredHeader = restoredDeploymentHeader(source, rotation);
    const desired = `${stableJson(desiredHeader)}\n`;
    const existing = (await readDescriptorBound(descriptorChildPath(dataHandle, headerName), MAX_METADATA_BYTES)).body.toString('utf8');
    const observed = parseHostedStateHeader(existing);
    if (!observed || (!headersMatch(observed, source) && !headersMatch(observed, desiredHeader))) {
      throw new Error('stopped_stack_restore_state_header_transition_invalid');
    }
    if (headersMatch(observed, desiredHeader)) {
      await retireOrRejectHeaderStaging(dataHandle, staging, desiredHeader, desired);
      return;
    }
    let recoveredCompleteStaging = false;
    try {
      const staged = (await readDescriptorBound(descriptorChildPath(dataHandle, staging), MAX_METADATA_BYTES)).body.toString('utf8');
      const stagedHeader = parseHostedStateHeader(staged);
      if (!stagedHeader) {
        // A partial unpublished write was never an authority.  Retire it with
        // a directory sync and rebuild from the verified archive and current
        // journal rather than failing a safe same-operation resume.
        await unlinkDescriptorEntry(dataHandle, staging);
        await dataHandle.sync();
        await writeExclusiveDurableFileAt(dataHandle, staging, desired, 0o600);
      } else if (!headersMatch(stagedHeader, desiredHeader)) {
        // A structurally valid staging header belongs to another target
        // operation.  Never silently retarget it on a resume.
        throw new Error('stopped_stack_restore_state_header_staging_mismatch');
      } else if (staged === desired) recoveredCompleteStaging = true;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      await writeExclusiveDurableFileAt(dataHandle, staging, desired, 0o600);
    }
    const staged = (await readDescriptorBound(descriptorChildPath(dataHandle, staging), MAX_METADATA_BYTES)).body.toString('utf8');
    if (staged !== desired) throw new Error('stopped_stack_restore_state_header_staging_mismatch');
    await syncAndRevalidateRegularFileAt(dataHandle, staging, desired);
    if (recoveredCompleteStaging) {
      await onStage?.('recovered_header_staging_file_and_directory_fsynced');
    }
    // The staging inode is durable but still unpublished. Keep this crash seam
    // for newly written staging state; recovered state has its own post-fsync
    // seam above.
    await onStage?.('header_staging_durable');
    await rename(descriptorChildPath(dataHandle, staging), descriptorChildPath(dataHandle, headerName));
    await dataHandle.sync();
  } finally {
    await dataHandle.close();
  }
}

export function parseHostedStateHeader(body) {
  try {
    return normalizeHostedStateHeader(JSON.parse(body), 'stopped_stack_restore_state_header_invalid');
  } catch {
    return null;
  }
}

export function normalizeHostedStateHeader(value, error) {
  if (
    !value || typeof value !== 'object' || Array.isArray(value) ||
    value.format !== 'hosted-state-header/v1' ||
    !Number.isSafeInteger(value?.schemaVersion) || value.schemaVersion <= 0 ||
    !Number.isSafeInteger(value?.hostedStateSchemaVersion) || value.hostedStateSchemaVersion <= 0 ||
    !DEPLOYMENT_ID_PATTERN.test(value?.deploymentId)
  ) throw new Error(error);
  // Preserve every authenticated archive-header field.  The deployment ID is
  // the sole restore transition authorized by the journal; dropping an
  // unrecognised field here would make a resumed restore accept a weakened
  // header after the payload copy has completed.
  return Object.freeze({ ...value });
}

export function headersMatch(left, right) {
  return stableJson(left) === stableJson(right);
}

export function restoredDeploymentHeader(archivedHeader, rotation) {
  return Object.freeze({ ...archivedHeader, deploymentId: rotation.deploymentId });
}

export async function retireOrRejectHeaderStaging(dataHandle, staging, desiredHeader, desired) {
  try {
    const staged = (await readDescriptorBound(descriptorChildPath(dataHandle, staging), MAX_METADATA_BYTES)).body.toString('utf8');
    const stagedHeader = parseHostedStateHeader(staged);
    if (!stagedHeader) {
      await unlinkDescriptorEntry(dataHandle, staging);
      await dataHandle.sync();
      return;
    }
    if (!headersMatch(stagedHeader, desiredHeader) || staged !== desired) {
      throw new Error('stopped_stack_restore_state_header_staging_mismatch');
    }
    await unlinkDescriptorEntry(dataHandle, staging);
    await dataHandle.sync();
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

export async function verifyRestoredDeploymentHeader(targetRootHandle, archivedHeader, rotation) {
  const dataHandle = await openChildDirectory(targetRootHandle, 'data');
  try {
    const header = parseHostedStateHeader(
      (await readDescriptorBound(descriptorChildPath(dataHandle, 'hosted-state-header.v1.json'), MAX_METADATA_BYTES)).body.toString('utf8')
    );
    const source = normalizeHostedStateHeader(archivedHeader, 'stopped_stack_restore_state_header_invalid');
    const desired = restoredDeploymentHeader(source, rotation);
    if (!header || !headersMatch(header, desired)) {
      throw new Error('stopped_stack_restore_state_header_transition_invalid');
    }
  } finally {
    await dataHandle.close();
  }
}

export async function inspectDatabaseRotationIntentWindow(
  targetRootHandle,
  journal,
  openDatabase,
  familyMatchesAuthorizedCheckpoint
) {
  const { openBoundSqlite, verifyDatabaseRotation } = await import('./stopped-stack-recovery-sqlite.mjs');
  const rotationScope = (rotation) => `${rotation.sourceManifestHash}.g-${rotation.restoreGeneration}`;
  const authorizedSqliteFamilyEntries = (authority) => authority.checkpointTransformation?.postCheckpoint ?? authority.preRotation;
  const dataHandle = await openChildDirectory(targetRootHandle, 'data');
  let storageHandle;
  let database;
  let databaseHandle;
  try {
    storageHandle = await openChildDirectory(dataHandle, 'storage');
    const openDb = openDatabase ?? (await loadDatabaseConstructor());
    ({ database, handle: databaseHandle } = await openBoundSqlite(
      storageHandle,
      openDb,
      familyMatchesAuthorizedCheckpoint
        ? authorizedSqliteFamilyEntries(journal.sqliteAuthority)
          .find((entry) => entry.path === 'data/storage/app.db')
        : undefined
    ));
    if (database.pragma('integrity_check', { simple: true }) !== 'ok') {
      throw new Error('stopped_stack_restore_journal_database_invalid');
    }
    if (typeof database.exec !== 'function' || !tableExists(database, 'phase10_restore_rotation')) {
      return false;
    }
    const marker = database
      .prepare('SELECT rotation_json AS rotationJson FROM phase10_restore_rotation WHERE rotation_scope = ?')
      .get(rotationScope(journal.rotation));
    if (!marker) return false;
    verifyDatabaseRotation(database, journal.rotation, journal.secretPlan.keyring.keyringId);
    return true;
  } finally {
    database?.close();
    await databaseHandle?.close();
    await storageHandle?.close();
    await dataHandle.close();
  }
}

export async function verifyPreRotationSqliteAuthority(targetRootHandle, authority) {
  for (const expected of authority.preRotation) {
    let actual;
    try {
      actual = await readTargetEntry(targetRootHandle, expected.path);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new Error('stopped_stack_restore_journal_sqlite_pre_rotation_invalid');
      }
      throw error;
    }
    if (
      actual.stat.size !== expected.byteLength ||
      (actual.stat.mode & 0o777) !== expected.mode ||
      sha256(actual.body) !== expected.sha256
    ) {
      throw new Error('stopped_stack_restore_journal_sqlite_pre_rotation_invalid');
    }
  }
}

export function primaryDatabaseIdentity(authority) {
  const identity = authority?.databaseIdentity;
  if (
    !identity || identity.path !== 'data/storage/app.db' ||
    !Number.isSafeInteger(identity.byteLength) || identity.byteLength < 0 ||
    !Number.isSafeInteger(identity.mode) || identity.mode < 0 || identity.mode > 0o777 ||
    !/^[0-9a-f]{64}$/u.test(identity.sha256 ?? '') ||
    !/^[0-9a-f]{64}$/u.test(identity.sourceManifestHash ?? '')
  ) throw new Error('stopped_stack_restore_journal_sqlite_authority_invalid');
  return identity;
}

export async function readTargetEntry(rootHandle, relativePath) {
  const handles = [];
  try {
    let current = rootHandle;
    for (const component of relativePath.split('/').slice(0, -1)) {
      const child = await openChildDirectory(current, component);
      handles.push(child);
      current = child;
    }
    return await readDescriptorBound(
      descriptorChildPath(current, relativePath.split('/').at(-1)),
      MAX_ENTRY_BYTES
    );
  } finally {
    for (const handle of handles.reverse()) await handle.close();
  }
}

export function phaseBefore(observed, expected) {
  const phases = [
    'initialized',
    'payload_restored',
    'database_rotation_started',
    'database_rotated',
    'secrets_published',
    'completed',
  ];
  return phases.indexOf(observed) < phases.indexOf(expected);
}

export async function publishSecretGeneration(targetRootHandle, secretPlan, allowCompletedGenerationSupersede = false, onStage) {
  const dataHandle = await openChildDirectory(targetRootHandle, 'data');
  try {
    const liveName = 'hosted-auth-secrets';
    const stagingName = '.hosted-auth-secrets.restore-staging';
    const retiredName = '.hosted-auth-secrets.restore-retired';
    const desired = await secretGenerationMatches(dataHandle, liveName, secretPlan);
    if (desired === true) {
      // A prior process may have completed the atomic publish but crashed
      // before retiring the old directory.  Retirement is deliberately last.
      await removeDirectoryContainingOnly(dataHandle, retiredName, SECRET_GENERATION_ENTRIES);
      await removeDirectoryContainingOnly(dataHandle, stagingName, SECRET_GENERATION_ENTRIES);
      return;
    }
    if (desired === false && !allowCompletedGenerationSupersede) {
      throw new Error('stopped_stack_restore_published_secrets_mismatch');
    }

    // Do not delete the live generation before a complete replacement exists.
    // The three durable states (live+staging, retired+staging, live+retired)
    // make every crash point resumable without regenerating the secrets.
    const recoveredCompleteStaging = await secretGenerationMatches(dataHandle, stagingName, secretPlan);
    if (recoveredCompleteStaging !== true) {
      await removeDirectoryContainingOnly(dataHandle, stagingName, SECRET_GENERATION_ENTRIES);
      const stagingHandle = await openOrCreateChildDirectory(dataHandle, stagingName);
      try {
        await writeExclusiveDurableFileAt(stagingHandle, 'personal-keyring.json', `${stableJson(secretPlan.keyring)}\n`, 0o600);
        await writeExclusiveDurableFileAt(stagingHandle, 'identity.key', `${secretPlan.identityKey}\n`, 0o600);
        await stagingHandle.sync();
      } finally {
        await stagingHandle.close();
      }
      await dataHandle.sync();
    }
    const secretFiles = {
      'personal-keyring.json': `${stableJson(secretPlan.keyring)}\n`,
      'identity.key': `${secretPlan.identityKey}\n`,
    };
    // Before live is renamed to retired, recover the entire replacement as one
    // durable generation. In particular, a complete cached keyring must not
    // allow retirement of the only durable predecessor.
    await syncAndRevalidateDirectoryFilesAt(dataHandle, stagingName, secretFiles);
    if (recoveredCompleteStaging === true) {
      await onStage?.('recovered_secret_generation_staging_files_and_directory_fsynced');
    }
    if (desired === false) {
      try {
        await openChildDirectory(dataHandle, retiredName).then((handle) => handle.close().then(() => {
          throw new Error('stopped_stack_restore_secret_retired_generation_conflict');
        }));
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      await rename(descriptorChildPath(dataHandle, liveName), descriptorChildPath(dataHandle, retiredName));
      await dataHandle.sync();
    }
    // If live was already moved to retired before a crash, this rename is the
    // idempotent publish step.  A missing live and missing retired is valid for
    // the first generation only.
    await rename(descriptorChildPath(dataHandle, stagingName), descriptorChildPath(dataHandle, liveName));
    await dataHandle.sync();
    await removeDirectoryContainingOnly(dataHandle, retiredName, SECRET_GENERATION_ENTRIES);
  } finally {
    await dataHandle.close();
  }
}

export const SECRET_GENERATION_ENTRIES = ['identity.key', 'personal-keyring.json'];

export async function secretGenerationMatches(dataHandle, name, secretPlan) {
  let handle;
  try {
    handle = await openChildDirectory(dataHandle, name);
    const entries = await readBoundedDirectoryEntries(handle, SECRET_GENERATION_ENTRIES.length);
    if (entries.some((entry) => !SECRET_GENERATION_ENTRIES.includes(entry))) {
      throw new Error('stopped_stack_restore_secret_staging_invalid');
    }
    const [keyring, identity] = await Promise.all([
      readDescriptorBound(descriptorChildPath(handle, 'personal-keyring.json'), MAX_METADATA_BYTES),
      readDescriptorBound(descriptorChildPath(handle, 'identity.key'), MAX_METADATA_BYTES),
    ]);
    return keyring.body.toString('utf8') === `${stableJson(secretPlan.keyring)}\n` &&
      identity.body.toString('utf8') === `${secretPlan.identityKey}\n`;
  } catch (error) {
    // A missing directory is the first-generation case. A missing member of
    // an opened directory is a partially deleted old generation and must take
    // the retire-and-replace path rather than attempting rename-over-live.
    if (error?.code === 'ENOENT') return handle ? false : null;
    throw error;
  } finally {
    await handle?.close();
  }
}

export async function loadDatabaseConstructor() {
  // Use the runtime's native SQLite binding.  It keeps recovery independent of
  // an optional native addon whose ABI can differ from the executing Node.
  const { DatabaseSync } = await import('node:sqlite');
  return (path) => {
    const database = new DatabaseSync(path);
    return {
      close: () => database.close(),
      exec: (sql) => database.exec(sql),
      prepare: (sql) => database.prepare(sql),
      pragma(value, options = {}) {
        if (value.includes('=')) { database.exec(`PRAGMA ${value}`); return undefined; }
        const statement = database.prepare(`PRAGMA ${value}`);
        if (options.simple) return Object.values(statement.get() ?? {})[0];
        // PRAGMAs such as foreign_key_check are result sets, not scalar
        // settings.  Returning every row is required to fail on any violation.
        return statement.all();
      },
      transaction(callback) {
        return () => {
          database.exec('BEGIN IMMEDIATE');
          try { const result = callback(); database.exec('COMMIT'); return result; }
          catch (error) { database.exec('ROLLBACK'); throw error; }
        };
      },
    };
  };
}

export function tableExists(database, table) {
  return Boolean(
    database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table)
  );
}

export async function readHostedStateHeader(payloadRoot, inventory) {
  const path = 'data/hosted-state-header.v1.json';
  const expected = inventory.entries.find((entry) => entry.path === path);
  const descriptor = await readVerifiedInventoryEntry(
    payloadRoot,
    inventory,
    path,
    MAX_METADATA_BYTES
  );
  if (
    !expected ||
    descriptor.stat.size !== expected.byteLength ||
    (descriptor.stat.mode & 0o777) !== expected.mode ||
    sha256(descriptor.body) !== expected.sha256
  ) {
    throw new Error('stopped_stack_archive_checksum_mismatch');
  }
  const header = JSON.parse(descriptor.body.toString('utf8'));
  if (
    header?.format !== 'hosted-state-header/v1' ||
    header.schemaVersion !== 1 ||
    typeof header.deploymentId !== 'string' ||
    !DEPLOYMENT_ID_PATTERN.test(header.deploymentId) ||
    !Number.isSafeInteger(header.hostedStateSchemaVersion)
  ) {
    throw new Error('stopped_stack_archive_state_header_invalid');
  }
  return header;
}

export function validateManifest(manifest) {
  if (
    manifest?.format !== ARCHIVE_FORMAT ||
    manifest.schemaVersion !== 1 ||
    manifest.sqliteIntegrity !== 'ok' ||
    typeof manifest.deploymentId !== 'string' ||
    !DEPLOYMENT_ID_PATTERN.test(manifest.deploymentId) ||
    !Number.isSafeInteger(manifest.hostedStateSchemaVersion) ||
    manifest.hostedStateSchemaVersion <= 0 ||
    !Array.isArray(manifest.entries) ||
    manifest.entries.some((entry) => isRecoveryControlPath(entry?.path))
  ) {
    throw new Error('stopped_stack_archive_manifest_invalid');
  }
  if (manifest.sourceDeployment !== undefined) validateSourceDeploymentIdentity(manifest.sourceDeployment);
}

export function validateSourceDeploymentIdentity(value) {
  if (value === undefined) return undefined;
  if (
    !value ||
    typeof value !== 'object' ||
    !DEPLOYMENT_ID_PATTERN.test(value.deploymentId) ||
    !/^sha256:[0-9a-f]{64}$/.test(value.imageDigest) ||
    !/^sha256:[0-9a-f]{64}$/.test(value.deploymentManifestSha256) ||
    !/^sha256:[0-9a-f]{64}$/.test(value.controllerArtifactSha256)
  ) {
    throw new Error('stopped_stack_archive_source_deployment_invalid');
  }
  return Object.freeze({
    deploymentId: value.deploymentId,
    imageDigest: value.imageDigest,
    deploymentManifestSha256: value.deploymentManifestSha256,
    controllerArtifactSha256: value.controllerArtifactSha256,
  });
}

export function validateRestoreDeploymentId(value) {
  if (typeof value !== 'string' || !DEPLOYMENT_ID_PATTERN.test(value)) {
    throw new Error('stopped_stack_restore_deployment_invalid');
  }
  return value;
}

export function assertSourceDeploymentLink(manifest, expected) {
  const identity = validateSourceDeploymentIdentity(expected);
  if (!identity) return;
  const observed = validateSourceDeploymentIdentity(manifest.sourceDeployment);
  if (
    !observed ||
    observed.deploymentId !== identity.deploymentId ||
    observed.imageDigest !== identity.imageDigest ||
    observed.deploymentManifestSha256 !== identity.deploymentManifestSha256 ||
    observed.controllerArtifactSha256 !== identity.controllerArtifactSha256
  ) {
    throw new Error('stopped_stack_archive_source_deployment_mismatch');
  }
}

export function assertExpectedManifestHash(observed, expected) {
  if (expected === undefined) return;
  if (typeof expected !== 'string' || !/^[0-9a-f]{64}$/.test(expected) || observed !== expected) {
    throw new Error('stopped_stack_archive_manifest_hash_mismatch');
  }
}

export async function assertEmptyRestoreTarget(rootHandle) {
  await assertDirectoryContainsOnlyOptionalEmptyChild(rootHandle, EXCLUDED_SOURCE_PREFIX, 'data');
}

export function requireArchiveRoot(value) {
  if (typeof value !== 'string' || value.length === 0 || !isAbsolute(value)) {
    throw new Error('stopped_stack_archive_root_required');
  }
  const archiveRoot = resolve(value);
  if (
    archiveRoot === '/' ||
    archiveRoot === SOURCE_ROOT ||
    archiveRoot.startsWith(`${SOURCE_ROOT}/`)
  ) {
    throw new Error('stopped_stack_archive_root_unsafe');
  }
  return archiveRoot;
}

export function parseGeneration(value) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error('stopped_stack_restore_generation_invalid');
  }
  return parsed;
}
