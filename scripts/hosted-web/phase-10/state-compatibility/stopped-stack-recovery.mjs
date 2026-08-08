#!/usr/bin/env node

import { lstat, mkdir, mkdtemp, readdir, rename, rm, stat } from 'node:fs/promises';
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
  readDescriptorBound,
  readVerifiedInventoryEntry,
  randomToken,
  removeDirectoryContainingOnly,
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

const ARCHIVE_FORMAT = 'hosted-stopped-stack-archive/v1';
const READY_FORMAT = 'hosted-stopped-stack-ready/v1';
const ROTATION_FORMAT = 'hosted-restored-authority-rotation/v1';
const SOURCE_ROOT = '/data/.agent-teams';
const READY_FILE = 'READY.json';
const MANIFEST_FILE = 'manifest.json';
const ROTATION_FILE = 'hosted-restore-rotation.v1.json';
const RESTORE_JOURNAL_FILE = 'hosted-restore-journal.v1.json';
const COMPLETED_ROTATION_FILE = 'hosted-restore-rotation.completed.v1.json';
const RESTORE_JOURNAL_FORMAT = 'hosted-stopped-stack-restore-journal/v1';
const EXCLUDED_SOURCE_PREFIX = 'instance-lock';
const INSTANCE_LEASE_ANCHOR = `${SOURCE_ROOT}/${EXCLUDED_SOURCE_PREFIX}/instance.lock`;
const INSTANCE_LEASE_FD_PATH = '/proc/self/fd/3';
const MAX_ENTRIES = 20_000;
const MAX_METADATA_BYTES = 256 * 1024;
const MAX_ENTRY_BYTES = 512 * 1024 * 1024;
const DEPLOYMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const RECOVERY_CONTROL_PATHS = new Set([
  `data/${ROTATION_FILE}`,
  `data/${ROTATION_FILE}.staging`,
  `data/${RESTORE_JOURNAL_FILE}`,
  `data/${RESTORE_JOURNAL_FILE}.staging`,
  `data/${COMPLETED_ROTATION_FILE}`,
  `data/${COMPLETED_ROTATION_FILE}.staging`,
]);

export async function createStoppedStackArchive(options = {}) {
  const sourceRoot = resolve(options.sourceRoot ?? SOURCE_ROOT);
  const archiveRoot = requireArchiveRoot(options.archiveRoot);
  const stagingRoot = `${archiveRoot}.partial`;
  await assertDirectory(sourceRoot);
  await assertAbsent(archiveRoot);
  await rm(stagingRoot, { recursive: true, force: true });
  await mkdir(join(stagingRoot, 'payload'), { recursive: true, mode: 0o700 });
  try {
    const inventory = await inventoryVerifiedTree(sourceRoot, true, options);
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
    const header = await readHostedStateHeader(sourceRoot, inventory);
    const body = Object.freeze({
      format: ARCHIVE_FORMAT,
      schemaVersion: 1,
      deploymentId: header.deploymentId,
      hostedStateSchemaVersion: header.hostedStateSchemaVersion,
      entries: inventory.entries,
      sqliteIntegrity: 'ok',
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
    await rename(stagingRoot, archiveRoot);
    await options.onArchiveCommitStage?.('archive_published');
    await syncDirectory(dirname(archiveRoot));
    await options.onArchiveCommitStage?.('archive_parent_synced');
    return Object.freeze({
      status: 'committed',
      manifestHash,
      entries: inventory.entries.length,
    });
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function verifyStoppedStackArchive(options = {}) {
  const archiveRoot = requireArchiveRoot(options.archiveRoot);
  const verified = await verifyArchiveTree(archiveRoot, true, options);
  return Object.freeze({
    status: 'verified',
    manifestHash: verified.manifestHash,
    entries: verified.manifest.entries.length,
  });
}

export async function restoreStoppedStackArchive(options = {}) {
  const archiveRoot = requireArchiveRoot(options.archiveRoot);
  const targetRoot = resolve(options.targetRoot ?? SOURCE_ROOT);
  const restoreGeneration = parseGeneration(
    options.restoreGeneration ?? process.env.AUTH_RESTORE_GENERATION
  );
  const targetRootHandle = await openDirectoryBound(targetRoot);
  try {
    await options.onTargetRootDescriptorVerified?.();
    const verified = await verifyArchiveTree(archiveRoot, true, options);
    await options.onRestoreStage?.('archive_verified');
    const journal = await initializeOrResumeRestore({
      targetRootHandle,
      verified,
      restoreGeneration,
      random: options.random ?? randomToken,
    });
    await options.onRestoreStage?.('journal_published');
    await ensureRotationMarker(targetRootHandle, journal.rotation);
    await options.onRestoreStage?.('rotation_marker_published');

    if (phaseBefore(journal.phase, 'payload_restored')) {
      for (const entry of verified.manifest.entries) {
        if (RECOVERY_CONTROL_PATHS.has(entry.path)) continue;
        if (entry.path.startsWith('data/hosted-auth-secrets/')) continue;
        await copyVerifiedInventoryEntry(
          join(archiveRoot, 'payload'),
          verified.inventory,
          entry,
          targetRootHandle,
          true
        );
      }
      await options.onRestoreStage?.('payload_copy_completed');
      journal.phase = 'payload_restored';
      await writeRestoreJournal(targetRootHandle, journal);
    }
    await options.onRestoreStage?.('payload_restored');

    if (phaseBefore(journal.phase, 'database_rotated')) {
      await rotateRestoredDatabase({
        targetRootHandle,
        rotation: journal.rotation,
        keyringId: journal.secretPlan.keyring.keyringId,
        openDatabase: options.openDatabase,
      });
      await options.onRestoreStage?.('database_transaction_committed');
      journal.phase = 'database_rotated';
      await writeRestoreJournal(targetRootHandle, journal);
    }
    await options.onRestoreStage?.('database_rotated');

    if (phaseBefore(journal.phase, 'secrets_published')) {
      await publishSecretGeneration(targetRootHandle, journal.secretPlan);
      await options.onRestoreStage?.('secret_generation_published');
      journal.phase = 'secrets_published';
      await writeRestoreJournal(targetRootHandle, journal);
    }
    await options.onRestoreStage?.('secrets_published');
    if (journal.phase !== 'completed') {
      const completed = {
        format: RESTORE_JOURNAL_FORMAT,
        schemaVersion: 1,
        manifestHash: journal.manifestHash,
        phase: 'completed',
        rotation: journal.rotation,
        keyringId: journal.secretPlan.keyring.keyringId,
      };
      await writeRestoreJournal(targetRootHandle, completed);
    }
    await options.onRestoreStage?.('restore_completed');
    await options.onRestoreStage?.('authority_rotated');
    return Object.freeze({
      status: 'restored',
      manifestHash: verified.manifestHash,
      rotation: journal.rotation,
    });
  } finally {
    await targetRootHandle.close();
  }
}

async function verifyArchiveTree(archiveRoot, requireReady = false, options = {}) {
  const archiveHandle = await openDirectoryBound(archiveRoot);
  try {
    const manifestBody = (
      await readDescriptorBound(
        descriptorChildPath(archiveHandle, MANIFEST_FILE),
        MAX_METADATA_BYTES
      )
    ).body.toString('utf8');
    const manifest = JSON.parse(manifestBody);
    validateManifest(manifest);
    const inventory = await inventoryVerifiedTree(
      descriptorChildPath(archiveHandle, 'payload'),
      false,
      options
    );
    if (stableJson(inventory.entries) !== stableJson(manifest.entries)) {
      throw new Error('stopped_stack_archive_checksum_mismatch');
    }
    const stateHeader = await readHostedStateHeader(
      descriptorChildPath(archiveHandle, 'payload'),
      inventory
    );
    if (
      stateHeader.deploymentId !== manifest.deploymentId ||
      stateHeader.hostedStateSchemaVersion !== manifest.hostedStateSchemaVersion
    ) {
      throw new Error('stopped_stack_archive_state_identity_mismatch');
    }
    const manifestHash = sha256(manifestBody);
    if (requireReady) {
      const ready = JSON.parse(
        (
          await readDescriptorBound(
            descriptorChildPath(archiveHandle, READY_FILE),
            MAX_METADATA_BYTES
          )
        ).body.toString('utf8')
      );
      if (
        ready?.format !== READY_FORMAT ||
        ready.schemaVersion !== 1 ||
        ready.manifestHash !== manifestHash
      ) {
        throw new Error('stopped_stack_archive_ready_marker_invalid');
      }
    }
    return { manifest, manifestHash, inventory };
  } finally {
    await archiveHandle.close();
  }
}

async function inventoryVerifiedTree(root, excludeLock, options) {
  const verificationRoot = await mkdtemp(join(tmpdir(), 'hosted-sqlite-verify-'));
  const sqliteSnapshots = new Map();
  try {
    const inventory = await inventoryTree(
      root,
      excludeLock,
      verificationRoot,
      sqliteSnapshots,
      options
    );
    await verifySqliteSnapshots(inventory.entries, sqliteSnapshots);
    return inventory;
  } finally {
    await rm(verificationRoot, { recursive: true, force: true });
  }
}

async function inventoryTree(root, excludeLock, verificationRoot, sqliteSnapshots, options) {
  const entries = [];
  const directoryIdentities = new Map();
  const rootHandle = await openDirectoryBound(root);
  const rootStat = await rootHandle.stat();
  directoryIdentities.set('', descriptorIdentity(rootStat));
  async function visit(directoryHandle, relativeDirectory) {
    await options.onDirectoryDescriptorVerified?.(relativeDirectory || '.');
    const children = await readdir(descriptorPath(directoryHandle), { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${child.name}` : child.name;
      if (excludeLock && relativePath.split('/')[0] === EXCLUDED_SOURCE_PREFIX) continue;
      if (excludeLock && RECOVERY_CONTROL_PATHS.has(relativePath)) continue;
      const childDirectory = await tryOpenChildDirectory(directoryHandle, child.name);
      if (childDirectory) {
        try {
          directoryIdentities.set(relativePath, descriptorIdentity(await childDirectory.stat()));
          await visit(childDirectory, relativePath);
        } finally {
          await childDirectory.close();
        }
        continue;
      }
      const descriptor = await readDescriptorBound(
        descriptorChildPath(directoryHandle, child.name),
        MAX_ENTRY_BYTES
      );
      if (relativePath.endsWith('.db')) {
        const snapshot = join(verificationRoot, `${sqliteSnapshots.size}.db`);
        await writeExclusiveDurableFile(snapshot, descriptor.body, 0o400);
        sqliteSnapshots.set(relativePath, snapshot);
        await options.onSqliteSourceDescriptorVerified?.(relativePath);
      }
      entries.push(
        Object.freeze({
          path: relativePath,
          byteLength: descriptor.stat.size,
          mode: descriptor.stat.mode & 0o777,
          sha256: sha256(descriptor.body),
        })
      );
      if (entries.length > MAX_ENTRIES) throw new Error('stopped_stack_archive_entry_limit');
    }
  }
  try {
    await visit(rootHandle, '');
  } finally {
    await rootHandle.close();
  }
  return Object.freeze({
    entries: Object.freeze(entries),
    directoryIdentities,
  });
}

async function rotateRestoredDatabase(input) {
  const { rotation, keyringId } = input;
  const dataHandle = await openChildDirectory(input.targetRootHandle, 'data');
  let storageHandle;
  let database;
  try {
    storageHandle = await openOrCreateChildDirectory(dataHandle, 'storage');
    const databasePath = descriptorChildPath(storageHandle, 'app.db');
    const openDatabase = input.openDatabase ?? (await loadDatabaseConstructor());
    database = openDatabase(databasePath);
    const integrity = database.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') throw new Error('stopped_stack_restore_sqlite_integrity_failed');
    database.pragma('foreign_keys = OFF');
    database.transaction(() => {
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
      if (tableExists(database, 'coordination_event_journal_metadata')) {
        database
          .prepare('UPDATE coordination_event_journal SET event_epoch = ?')
          .run(rotation.eventEpoch);
        database
          .prepare('UPDATE coordination_event_journal_metadata SET event_epoch = ?')
          .run(rotation.eventEpoch);
      }
      const foreignKeyFailures = database.pragma('foreign_key_check');
      if (Array.isArray(foreignKeyFailures) && foreignKeyFailures.length > 0) {
        throw new Error('stopped_stack_restore_foreign_key_failed');
      }
    })();
    database.pragma('foreign_keys = ON');
  } finally {
    database?.close();
    await storageHandle?.close();
    await dataHandle.close();
  }
}

function createRotationRequest(input) {
  return Object.freeze({
    format: ROTATION_FORMAT,
    schemaVersion: 1,
    deploymentId: input.deploymentId,
    restoreGeneration: input.restoreGeneration,
    bootId: `boot_x${input.random(18)}`,
    eventEpoch: `epoch_x${input.random(18)}`,
    browserAuthorityRotated: true,
    runtimeAuthorityRotationRequired: true,
    freshMountBindingsRequired: true,
  });
}

async function initializeOrResumeRestore(input) {
  const existing = await readOptionalRestoreJournal(input.targetRootHandle);
  if (existing) {
    validateRestoreJournal(existing);
    if (
      existing.manifestHash !== input.verified.manifestHash ||
      existing.rotation.deploymentId !== input.verified.manifest.deploymentId ||
      existing.rotation.restoreGeneration !== input.restoreGeneration
    ) {
      throw new Error('stopped_stack_restore_journal_mismatch');
    }
    return existing;
  }
  await recoverUnpublishedJournalStaging(input.targetRootHandle);
  await assertEmptyRestoreTarget(input.targetRootHandle);
  const rotation = createRotationRequest({
    deploymentId: input.verified.manifest.deploymentId,
    restoreGeneration: input.restoreGeneration,
    random: input.random,
  });
  const journal = {
    format: RESTORE_JOURNAL_FORMAT,
    schemaVersion: 1,
    manifestHash: input.verified.manifestHash,
    phase: 'initialized',
    rotation,
    secretPlan: {
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
    },
  };
  const dataHandle = await openOrCreateChildDirectory(input.targetRootHandle, 'data');
  await dataHandle.close();
  await writeRestoreJournal(input.targetRootHandle, journal);
  return journal;
}

async function recoverUnpublishedJournalStaging(targetRootHandle) {
  const rootEntries = await readdir(descriptorPath(targetRootHandle));
  const unexpectedRoot = rootEntries.filter(
    (entry) => entry !== EXCLUDED_SOURCE_PREFIX && entry !== 'data'
  );
  if (unexpectedRoot.length > 0 || !rootEntries.includes('data')) return;
  const dataHandle = await openChildDirectory(targetRootHandle, 'data');
  try {
    const dataEntries = await readdir(descriptorPath(dataHandle));
    if (dataEntries.length === 1 && dataEntries[0] === `${RESTORE_JOURNAL_FILE}.staging`) {
      await unlinkDescriptorEntry(dataHandle, `${RESTORE_JOURNAL_FILE}.staging`);
      await dataHandle.sync();
    }
  } finally {
    await dataHandle.close();
  }
}

async function ensureRotationMarker(targetRootHandle, rotation) {
  const dataHandle = await openChildDirectory(targetRootHandle, 'data');
  try {
    const existing = JSON.parse(
      (
        await readDescriptorBound(
          descriptorChildPath(dataHandle, ROTATION_FILE),
          MAX_METADATA_BYTES
        )
      ).body.toString('utf8')
    );
    if (stableJson(existing) !== stableJson(rotation)) {
      throw new Error('stopped_stack_restore_rotation_marker_mismatch');
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await writeExclusiveDurableFileAt(
      dataHandle,
      ROTATION_FILE,
      `${stableJson(rotation)}\n`,
      0o600
    );
  } finally {
    await dataHandle.close();
  }
}

async function readOptionalRestoreJournal(targetRootHandle) {
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

async function writeRestoreJournal(targetRootHandle, journal) {
  const dataHandle = await openChildDirectory(targetRootHandle, 'data');
  try {
    const staging = `${RESTORE_JOURNAL_FILE}.staging`;
    await unlinkDescriptorEntry(dataHandle, staging);
    await writeExclusiveDurableFileAt(dataHandle, staging, `${stableJson(journal)}\n`, 0o600);
    await rename(
      descriptorChildPath(dataHandle, staging),
      descriptorChildPath(dataHandle, RESTORE_JOURNAL_FILE)
    );
    await dataHandle.sync();
  } finally {
    await dataHandle.close();
  }
}

function validateRestoreJournal(journal) {
  const commonInvalid =
    journal?.format !== RESTORE_JOURNAL_FORMAT ||
    journal.schemaVersion !== 1 ||
    typeof journal.manifestHash !== 'string' ||
    !journal.rotation ||
    journal.rotation.format !== ROTATION_FORMAT;
  const completedInvalid = journal?.phase === 'completed' && typeof journal.keyringId !== 'string';
  const activeInvalid =
    journal?.phase !== 'completed' &&
    (!['initialized', 'payload_restored', 'database_rotated', 'secrets_published'].includes(
      journal?.phase
    ) ||
      typeof journal.secretPlan?.identityKey !== 'string' ||
      journal.secretPlan.identityKey.length < 32 ||
      journal.secretPlan?.keyring?.format !== 'hosted-access-keyring/v1' ||
      journal.secretPlan.keyring.binding?.deploymentId !== journal.rotation.deploymentId ||
      journal.secretPlan.keyring.binding?.restoreGeneration !==
        journal.rotation.restoreGeneration ||
      typeof journal.secretPlan.keyring.keyringId !== 'string');
  if (commonInvalid || completedInvalid || activeInvalid) {
    throw new Error('stopped_stack_restore_journal_invalid');
  }
}

function phaseBefore(observed, expected) {
  const phases = [
    'initialized',
    'payload_restored',
    'database_rotated',
    'secrets_published',
    'completed',
  ];
  return phases.indexOf(observed) < phases.indexOf(expected);
}

async function publishSecretGeneration(targetRootHandle, secretPlan) {
  const dataHandle = await openChildDirectory(targetRootHandle, 'data');
  try {
    let secretsHandle;
    try {
      secretsHandle = await openChildDirectory(dataHandle, 'hosted-auth-secrets');
      const [keyring, identity] = await Promise.all([
        readDescriptorBound(
          descriptorChildPath(secretsHandle, 'personal-keyring.json'),
          MAX_METADATA_BYTES
        ),
        readDescriptorBound(descriptorChildPath(secretsHandle, 'identity.key'), MAX_METADATA_BYTES),
      ]);
      if (
        keyring.body.toString('utf8') !== `${stableJson(secretPlan.keyring)}\n` ||
        identity.body.toString('utf8') !== `${secretPlan.identityKey}\n`
      ) {
        throw new Error('stopped_stack_restore_published_secrets_mismatch');
      }
      return;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    } finally {
      await secretsHandle?.close();
    }
    const stagingName = '.hosted-auth-secrets.restore-staging';
    await removeDirectoryContainingOnly(dataHandle, stagingName, [
      'identity.key',
      'personal-keyring.json',
    ]);
    const stagingHandle = await openOrCreateChildDirectory(dataHandle, stagingName);
    try {
      await writeExclusiveDurableFileAt(
        stagingHandle,
        'personal-keyring.json',
        `${stableJson(secretPlan.keyring)}\n`,
        0o600
      );
      await writeExclusiveDurableFileAt(
        stagingHandle,
        'identity.key',
        `${secretPlan.identityKey}\n`,
        0o600
      );
      await stagingHandle.sync();
    } finally {
      await stagingHandle.close();
    }
    await rename(
      descriptorChildPath(dataHandle, stagingName),
      descriptorChildPath(dataHandle, 'hosted-auth-secrets')
    );
    await dataHandle.sync();
  } finally {
    await dataHandle.close();
  }
}

async function loadDatabaseConstructor() {
  const module = await import('better-sqlite3');
  const Constructor = module.default;
  return (path, options) => new Constructor(path, options);
}

function tableExists(database, table) {
  return Boolean(
    database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table)
  );
}

async function readHostedStateHeader(payloadRoot, inventory) {
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

function validateManifest(manifest) {
  if (
    manifest?.format !== ARCHIVE_FORMAT ||
    manifest.schemaVersion !== 1 ||
    manifest.sqliteIntegrity !== 'ok' ||
    typeof manifest.deploymentId !== 'string' ||
    !DEPLOYMENT_ID_PATTERN.test(manifest.deploymentId) ||
    !Number.isSafeInteger(manifest.hostedStateSchemaVersion) ||
    manifest.hostedStateSchemaVersion <= 0 ||
    !Array.isArray(manifest.entries) ||
    manifest.entries.some((entry) => RECOVERY_CONTROL_PATHS.has(entry?.path))
  ) {
    throw new Error('stopped_stack_archive_manifest_invalid');
  }
}

async function assertEmptyRestoreTarget(rootHandle) {
  await assertDirectoryContainsOnlyOptionalEmptyChild(rootHandle, EXCLUDED_SOURCE_PREFIX, 'data');
}

function requireArchiveRoot(value) {
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

function parseGeneration(value) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error('stopped_stack_restore_generation_invalid');
  }
  return parsed;
}

async function main() {
  const [command, ...extra] = process.argv.slice(2);
  if (extra.length > 0 || !['backup', 'verify', 'restore'].includes(command)) {
    throw new Error('usage: stopped-stack-recovery.mjs <backup|verify|restore>');
  }
  await assertStoppedStackLeaseHeld();
  const archiveRoot = process.env.HOSTED_RECOVERY_ARCHIVE_ROOT;
  const result =
    command === 'backup'
      ? await createStoppedStackArchive({ archiveRoot })
      : command === 'verify'
        ? await verifyStoppedStackArchive({ archiveRoot })
        : await restoreStoppedStackArchive({ archiveRoot });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function assertStoppedStackLeaseHeld() {
  try {
    const [lease, anchor] = await Promise.all([
      stat(INSTANCE_LEASE_FD_PATH),
      lstat(INSTANCE_LEASE_ANCHOR),
    ]);
    if (
      !lease.isFile() ||
      !anchor.isFile() ||
      anchor.isSymbolicLink() ||
      anchor.uid !== 0 ||
      anchor.nlink !== 1 ||
      lease.dev !== anchor.dev ||
      lease.ino !== anchor.ino
    ) {
      throw new Error('lease_identity_invalid');
    }
  } catch {
    throw new Error('stopped_stack_instance_lease_required');
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch((error) => {
    process.stderr.write(
      `hosted_recovery_refused:${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exitCode = 1;
  });
}
