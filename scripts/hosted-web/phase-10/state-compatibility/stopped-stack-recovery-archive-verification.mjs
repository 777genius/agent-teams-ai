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
  readBoundedDirectoryEntries,
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
import { isSqliteAuthorityPath, sqliteDatabasePath } from './stopped-stack-recovery-sqlite.mjs';
import { readHostedStateHeader, validateManifest, assertSourceDeploymentLink, assertExpectedManifestHash, requireArchiveRoot } from './stopped-stack-recovery-postrestore.mjs';

// The archive format is a descriptor-bound directory inventory rather than a
// compressed stream, so it has no decompression-ratio surface. Keep the
// remaining extraction limits here, at the common primitive used by recovery
// and main-process replay, instead of letting the replay worker invent a
// second archive reader.
const MAX_ARCHIVE_TOTAL_BYTES = 1024 * 1024 * 1024;
const MAX_ARCHIVE_PATH_BYTES = 4096;

export async function verifyStoppedStackArchive(options = {}) {
  const archiveRoot = requireArchiveRoot(options.archiveRoot);
  const verified = await verifyArchiveTree(archiveRoot, true, options);
  assertSourceDeploymentLink(verified.manifest, options.expectedSourceDeploymentIdentity);
  assertExpectedManifestHash(verified.manifestHash, options.expectedManifestHash);
  return Object.freeze({
    status: 'verified',
    manifestHash: verified.manifestHash,
    entries: verified.manifest.entries.length,
  });
}


export async function enforceSupersedingPayloadInventory(targetRootHandle, entries) {
  const expected = new Set(
    entries
      .filter((entry) => !isRecoveryControlPath(entry.path) && !entry.path.startsWith('data/hosted-auth-secrets/'))
      .map((entry) => entry.path)
  );
  await pruneUnexpectedRestoreTree(targetRootHandle, '', expected, 0, { remaining: MAX_ENTRIES });
}

export async function pruneUnexpectedRestoreTree(parentHandle, relativePath, expected, depth = 0, budget = { remaining: MAX_ENTRIES }) {
  if (depth > 32) throw new Error('recovery_directory_depth_limit');
  const children = await readBoundedDirectoryEntries(parentHandle, Math.min(MAX_ENTRIES, budget.remaining));
  budget.remaining -= children.length;
  if (budget.remaining < 0) throw new Error('recovery_directory_entry_limit');
  for (const name of children) {
    const path = relativePath ? `${relativePath}/${name}` : name;
    if (
      path === EXCLUDED_SOURCE_PREFIX ||
      path === 'data/hosted-auth-secrets' ||
      isRecoveryControlPath(path) ||
      expected.has(path)
    ) continue;
    const child = await tryOpenChildDirectory(parentHandle, name);
    if (child) {
      try {
        await pruneUnexpectedRestoreTree(child, path, expected, depth + 1, budget);
        if ((await readBoundedDirectoryEntries(child, 1)).length === 0) {
          await child.close();
          await rmdir(descriptorChildPath(parentHandle, name));
          await parentHandle.sync();
        }
      } finally {
        // The handle may already have been closed before rmdir; close is
        // idempotent on Node's FileHandle and keeps the crash path bounded.
        await child.close().catch(() => {});
      }
      continue;
    }
    await unlinkDescriptorEntry(parentHandle, name);
    await parentHandle.sync();
  }
}

export async function verifyArchiveTree(archiveRoot, requireReady = false, options = {}) {
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
    return { manifest, manifestHash, inventory, stateHeader };
  } finally {
    await archiveHandle.close();
  }
}

export async function inventoryVerifiedTree(root, excludeLock, options, heldRootHandle) {
  const scratch = await createOwnedScratchDirectory(tmpdir(), 'hosted-sqlite-verify-');
  const verificationRoot = descriptorPath(scratch.handle);
  const sqliteSnapshots = new Map();
  try {
    const inventory = await inventoryTree(
      root,
      excludeLock,
      verificationRoot,
      sqliteSnapshots,
      options,
      heldRootHandle
    );
    await verifySqliteSnapshots(inventory.entries, sqliteSnapshots);
    return inventory;
  } finally {
    await removeOwnedScratchDirectory(scratch);
  }
}

export async function inventoryTree(root, excludeLock, verificationRoot, sqliteSnapshots, options, heldRootHandle) {
  const entries = [];
  const directoryIdentities = new Map();
  let totalBytes = 0;
  const rootHandle = heldRootHandle ?? (await openDirectoryBound(root));
  const closeRootHandle = !heldRootHandle;
  const rootStat = await rootHandle.stat();
  directoryIdentities.set('', descriptorIdentity(rootStat));
  let visitedPaths = 0;
  async function visit(directoryHandle, relativeDirectory, depth) {
    if (depth > 32) throw new Error('stopped_stack_archive_depth_limit');
    await options.onDirectoryDescriptorVerified?.(relativeDirectory || '.');
    const children = await readBoundedDirectoryEntries(directoryHandle, MAX_ENTRIES - visitedPaths);
    children.sort((left, right) => left.localeCompare(right));
    for (const childName of children) {
      visitedPaths += 1;
      if (visitedPaths > MAX_ENTRIES) throw new Error('stopped_stack_archive_entry_limit');
      const relativePath = relativeDirectory ? `${relativeDirectory}/${childName}` : childName;
      if (Buffer.byteLength(relativePath, 'utf8') > MAX_ARCHIVE_PATH_BYTES) {
        throw new Error('stopped_stack_archive_path_limit');
      }
      if (excludeLock && relativePath.split('/')[0] === EXCLUDED_SOURCE_PREFIX) continue;
      if (excludeLock && isRecoveryControlPath(relativePath)) continue;
      const childDirectory = await tryOpenChildDirectory(directoryHandle, childName);
      if (childDirectory) {
        try {
          directoryIdentities.set(relativePath, descriptorIdentity(await childDirectory.stat()));
          await visit(childDirectory, relativePath, depth + 1);
        } finally {
          await childDirectory.close();
        }
        continue;
      }
      const descriptor = await readDescriptorBound(
        descriptorChildPath(directoryHandle, childName),
        MAX_ENTRY_BYTES,
        isSqliteAuthorityPath(relativePath)
          ? async (liveDescriptor) => {
            await options.onSqliteSourceDescriptorVerified?.({
              path: relativePath,
              ...liveDescriptor,
            });
          }
          : undefined
      );
      totalBytes += descriptor.stat.size;
      if (totalBytes > MAX_ARCHIVE_TOTAL_BYTES) throw new Error('stopped_stack_archive_total_size_limit');
      if (isSqliteAuthorityPath(relativePath)) {
        // A WAL database is a database *family*, not an immutable .db file.
        // Keep its sidecars beside the snapshot primary so SQLite validates
        // the same pre-rotation authority that was inventoried.
        const databasePath = sqliteDatabasePath(relativePath);
        const snapshotDirectory = join(verificationRoot, sha256(databasePath));
        await mkdir(snapshotDirectory, { mode: 0o700, recursive: true });
        const snapshot = join(snapshotDirectory, relativePath.slice(relativePath.lastIndexOf('/') + 1));
        await writeExclusiveDurableFile(snapshot, descriptor.body, 0o400);
        sqliteSnapshots.set(relativePath, snapshot);
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
    await visit(rootHandle, '', 0);
  } finally {
    if (closeRootHandle) await rootHandle.close();
  }
  return Object.freeze({
    entries: Object.freeze(entries),
    directoryIdentities,
  });
}
