import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  type BackupCommitMarker,
  type BackupManifest,
  type BackupManifestEntry,
  type BackupRunId,
  type CommittedBackupPublication,
  COORDINATION_BACKUP_COMMIT_MARKER_FORMAT,
  COORDINATION_BACKUP_FORMAT,
  type MeasuredBackupEntry,
  parseSha256Digest,
  type Sha256Digest,
  SQLITE_ONLINE_BACKUP_METHOD,
} from '../../contracts';

import {
  artifactAncestorEntryIds,
  BACKUP_COMMIT_MARKER_FILE,
  BACKUP_DIRECTORY_MODE,
  BACKUP_METADATA_FILE_MODE,
  BACKUP_ROOT_MANIFEST_FILE,
  BACKUP_STAGE_OWNER_FILE,
  type BackupPathLayout,
  type BackupStagePaths,
  generationName,
  isPathInside,
  resolveArtifactPath,
  validateArtifactEntryId,
} from './backupPathLayout';
import { canonicalBackupJson } from './canonicalBackupJson';
import { NodeBackupManifestHasher } from './NodeBackupManifestHasher';
import {
  type BackupArtifactWriteRequest,
  BackupPublicationError,
} from './nodeBackupPublicationTypes';

const NO_FOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const DIRECTORY_ONLY = fs.constants.O_DIRECTORY ?? 0;
const OWNER_FORMAT = 'coordination-backup-private-stage/v1' as const;
const MAX_METADATA_BYTES = 16 * 1024 * 1024;
const MARKER_TEMPORARY_PREFIX = `.${BACKUP_COMMIT_MARKER_FILE}.prepare-`;
const MARKER_TEMPORARY_SUFFIX_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PREPARATION_DIRECTORY_SUFFIX_PATTERN = /^[A-Za-z0-9]{6}$/;

interface StageOwner {
  readonly format: typeof OWNER_FORMAT;
  readonly backupRunId: BackupRunId;
}

export async function generationCandidates(
  layout: BackupPathLayout,
  backupRunId: BackupRunId
): Promise<readonly { readonly name: string; readonly path: string }[]> {
  const names = await fs.promises.readdir(layout.generationsRoot);
  const prefix = `${backupRunId}.`;
  return names
    .filter((name) => name.startsWith(prefix))
    .map((name) => ({ name, path: path.join(layout.generationsRoot, name) }));
}

export async function readSealedMetadata(
  paths: BackupStagePaths,
  backupRunId: BackupRunId
): Promise<{ readonly manifest: BackupManifest; readonly marker: BackupCommitMarker }> {
  const manifest = await readTypedMetadata<BackupManifest>(paths.manifest);
  const marker = await readTypedMetadata<BackupCommitMarker>(paths.marker);
  if (!markerMatchesManifest(marker, manifest, backupRunId)) {
    throw publicationError('sealed-metadata-mismatch');
  }
  const hasher = new NodeBackupManifestHasher();
  await validateManifestHash(hasher, manifest);
  return { manifest, marker };
}

export async function validateManifestHash(
  hasher: NodeBackupManifestHasher,
  manifest: BackupManifest
): Promise<void> {
  if (!manifest || typeof manifest !== 'object' || typeof manifest.manifestHash !== 'string') {
    throw publicationError('manifest-invalid');
  }
  const { manifestHash, ...body } = manifest;
  const computed = await hasher.hashCanonicalManifest(body);
  if (parseSha256Digest(manifestHash) !== computed)
    throw publicationError('manifest-hash-mismatch');
  const sqliteEntry = manifest.entries.find(
    (entry) => entry.entryId === manifest.sqliteSnapshot?.entry?.entryId
  );
  if (
    manifest.format !== COORDINATION_BACKUP_FORMAT ||
    manifest.sourceBackupRunId !== manifest.backupRunId ||
    manifest.sqliteSnapshot?.method !== SQLITE_ONLINE_BACKUP_METHOD ||
    manifest.sqliteSnapshot.sourceRunId !== manifest.sourceBackupRunId ||
    manifest.sqliteSnapshot.entry.kind !== 'sqlite_snapshot' ||
    !sqliteEntry ||
    canonicalBackupJson(sqliteEntry) !== canonicalBackupJson(manifest.sqliteSnapshot.entry) ||
    manifest.identityInventory?.deploymentId !== manifest.deploymentId
  ) {
    throw publicationError('manifest-contract-mismatch');
  }
}

export async function validateArtifactTree(
  paths: BackupStagePaths,
  manifest: BackupManifest,
  requireMarker: boolean
): Promise<void> {
  const expectedFiles = new Set<string>([
    BACKUP_STAGE_OWNER_FILE,
    ...((await lstatOrNull(paths.manifest)) ? [BACKUP_ROOT_MANIFEST_FILE] : []),
    ...(requireMarker ? [BACKUP_COMMIT_MARKER_FILE] : []),
  ]);
  const expectedDirectories = new Set<string>();
  const entryIds = new Set<string>();
  for (const entry of manifest.entries) {
    validateManifestEntry(entry);
    if (entryIds.has(entry.entryId)) throw publicationError('manifest-entry-duplicate');
    entryIds.add(entry.entryId);
    expectedFiles.add(entry.entryId);
    for (const ancestor of artifactAncestorEntryIds(entry.entryId))
      expectedDirectories.add(ancestor);
  }

  const observed = await walkTreeNoLinks(paths.directory);
  for (const file of observed.files) {
    if (!expectedFiles.has(file)) throw publicationError('artifact-extra-entry');
  }
  for (const expected of expectedFiles) {
    if (!observed.files.has(expected)) throw publicationError('artifact-missing-entry');
  }
  for (const directory of observed.directories) {
    if (!expectedDirectories.has(directory)) throw publicationError('artifact-extra-directory');
  }
  for (const expected of expectedDirectories) {
    if (!observed.directories.has(expected)) throw publicationError('artifact-missing-directory');
  }

  for (const entry of manifest.entries) {
    const measured = await measureRegularFile(
      resolveArtifactPath(paths.directory, entry.entryId),
      entry.entryId
    );
    if (
      measured.byteLength !== entry.byteLength ||
      measured.mode !== entry.mode ||
      measured.sha256 !== entry.sha256
    ) {
      throw publicationError('artifact-measurement-mismatch');
    }
  }
}

export function validateManifestEntry(entry: BackupManifestEntry): void {
  validateArtifactEntryId(entry.entryId);
  if (
    !Number.isSafeInteger(entry.byteLength) ||
    entry.byteLength < 0 ||
    !isFileMode(entry.mode) ||
    !Number.isSafeInteger(entry.schemaVersion) ||
    entry.schemaVersion < 0
  ) {
    throw publicationError('manifest-entry-invalid');
  }
  parseSha256Digest(entry.sha256);
  requireNonEmpty(entry.participantId, 'participant-id');
  requireNonEmpty(entry.logicalOwner, 'logical-owner');
  requireNonEmpty(entry.logicalType, 'logical-type');
  requireNonEmpty(entry.sourceGeneration, 'source-generation');
}

export function validateArtifactWriteRequest(request: BackupArtifactWriteRequest): void {
  validateArtifactEntryId(request.entryId);
  requireNonEmpty(request.participantId, 'participant-id');
  requireNonEmpty(request.logicalOwner, 'logical-owner');
  requireNonEmpty(request.logicalType, 'logical-type');
  requireNonEmpty(request.sourceGeneration, 'source-generation');
  if (!(request.bytes instanceof Uint8Array)) throw publicationError('artifact-bytes-invalid');
  if (!Number.isSafeInteger(request.schemaVersion) || request.schemaVersion < 0) {
    throw publicationError('artifact-schema-version-invalid');
  }
  if (!isFileMode(request.mode)) throw publicationError('artifact-mode-invalid');
}

export function requireNonEmpty(value: string, field: string): void {
  if (typeof value !== 'string' || value.length === 0) throw publicationError(`${field}-invalid`);
}

export function isFileMode(mode: number): boolean {
  return Number.isInteger(mode) && mode >= 0 && mode <= 0o777 && (mode & 0o400) !== 0;
}

export async function createArtifactParents(directory: string, entryId: string): Promise<void> {
  const segments = validateArtifactEntryId(entryId);
  let current = directory;
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    try {
      await fs.promises.mkdir(current, { mode: BACKUP_DIRECTORY_MODE });
      await fsyncDirectory(path.dirname(current));
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
    await requireDirectory(current, BACKUP_DIRECTORY_MODE, directory);
  }
}

export async function fsyncArtifactParents(directory: string, entryId: string): Promise<void> {
  const ancestors = [...artifactAncestorEntryIds(entryId)].reverse();
  for (const relative of ancestors) await fsyncDirectory(resolveArtifactPath(directory, relative));
  await fsyncDirectory(directory);
}

export async function createOrRequirePrivateDirectory(
  directory: string,
  parent: string
): Promise<void> {
  try {
    await fs.promises.mkdir(directory, { mode: BACKUP_DIRECTORY_MODE });
    await fsyncDirectory(parent);
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  }
  await requireDirectory(directory, BACKUP_DIRECTORY_MODE, parent);
}

export async function requireDirectory(
  directory: string,
  expectedMode: number,
  parent: string
): Promise<void> {
  const stat = await fs.promises.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== expectedMode) {
    throw publicationError('directory-invalid');
  }
  const realDirectory = await fs.promises.realpath(directory);
  const realParent = await fs.promises.realpath(parent);
  if (!isPathInside(realParent, realDirectory)) throw publicationError('directory-path-escape');
  const after = await fs.promises.lstat(directory);
  if (
    !sameIdentity(stat, after) ||
    !after.isDirectory() ||
    after.isSymbolicLink() ||
    after.mode !== stat.mode
  ) {
    throw publicationError('directory-identity-race');
  }
}

export async function requireOwnedStage(
  paths: BackupStagePaths,
  backupRunId: BackupRunId,
  parent: string
): Promise<void> {
  await requireDirectory(paths.directory, BACKUP_DIRECTORY_MODE, parent);
  const owner = await readTypedMetadata<StageOwner>(paths.owner);
  if (canonicalBackupJson(owner) !== canonicalBackupJson(ownerFor(backupRunId))) {
    throw publicationError('stage-owner-mismatch');
  }
}

export async function requireUnsealedAndManifestFree(paths: BackupStagePaths): Promise<void> {
  if (await lstatOrNull(paths.marker)) throw publicationError('stage-sealed');
  if (await lstatOrNull(paths.manifest)) throw publicationError('stage-manifest-written');
}

export async function writeIdempotentMetadata(filePath: string, value: unknown): Promise<void> {
  const bytes = Buffer.from(canonicalBackupJson(value), 'utf8');
  const existing = await lstatOrNull(filePath);
  if (!existing) {
    await writeExclusiveFile(filePath, bytes, BACKUP_METADATA_FILE_MODE);
    return;
  }
  await requireMetadataMode(filePath, existing);
  const observed = await readRegularFileNoFollow(
    filePath,
    MAX_METADATA_BYTES,
    BACKUP_METADATA_FILE_MODE
  );
  if (!observed.equals(bytes)) throw publicationError('metadata-mismatch');
}

export async function readTypedMetadata<T>(filePath: string): Promise<T> {
  const stat = await fs.promises.lstat(filePath);
  await requireMetadataMode(filePath, stat);
  const bytes = await readRegularFileNoFollow(
    filePath,
    MAX_METADATA_BYTES,
    BACKUP_METADATA_FILE_MODE
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw publicationError('metadata-json-invalid');
  }
  if (canonicalBackupJson(parsed) !== bytes.toString('utf8')) {
    throw publicationError('metadata-not-canonical');
  }
  return parsed as T;
}

export async function requireMetadataMode(filePath: string, stat: fs.Stats): Promise<void> {
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    (stat.mode & 0o777) !== BACKUP_METADATA_FILE_MODE
  ) {
    throw publicationError(`metadata-file-invalid:${path.basename(filePath)}`);
  }
}

export async function writeIdempotentFile(
  filePath: string,
  bytes: Buffer,
  mode: number,
  expectedHash: Sha256Digest
): Promise<void> {
  const existing = await lstatOrNull(filePath);
  if (!existing) {
    await writeExclusiveFile(filePath, bytes, mode);
    return;
  }
  const measured = await measureRegularFile(filePath, path.basename(filePath));
  if (
    measured.byteLength !== bytes.byteLength ||
    measured.mode !== mode ||
    measured.sha256 !== expectedHash
  ) {
    throw publicationError('artifact-existing-mismatch');
  }
}

export async function writeExclusiveFile(
  filePath: string,
  bytes: Buffer,
  mode: number
): Promise<void> {
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(
      filePath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW,
      mode
    );
    await handle.chmod(mode);
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

export async function measureRegularFile(
  filePath: string,
  entryId: string
): Promise<MeasuredBackupEntry> {
  const stat = await fs.promises.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw publicationError('artifact-not-regular-file');
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | NO_FOLLOW);
    const descriptorStat = await handle.stat();
    if (!descriptorStat.isFile() || !sameIdentity(stat, descriptorStat)) {
      throw publicationError('artifact-identity-race');
    }
    const hash = createHash('sha256');
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (offset < descriptorStat.size) {
      const { bytesRead } = await handle.read(
        chunk,
        0,
        Math.min(chunk.byteLength, descriptorStat.size - offset),
        offset
      );
      if (bytesRead === 0) throw publicationError('artifact-short-read');
      hash.update(chunk.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const afterDescriptor = await handle.stat();
    const afterPath = await fs.promises.lstat(filePath);
    if (
      !sameIdentity(descriptorStat, afterDescriptor) ||
      descriptorStat.size !== afterDescriptor.size ||
      descriptorStat.mode !== afterDescriptor.mode ||
      !sameIdentity(afterDescriptor, afterPath) ||
      afterPath.isSymbolicLink()
    ) {
      throw publicationError('artifact-changed-during-read');
    }
    return {
      entryId,
      byteLength: descriptorStat.size,
      mode: descriptorStat.mode & 0o777,
      sha256: parseSha256Digest(hash.digest('hex')),
    };
  } finally {
    await handle?.close();
  }
}

export async function readRegularFileNoFollow(
  filePath: string,
  maximumBytes: number,
  expectedMode: number
): Promise<Buffer> {
  const before = await fs.promises.lstat(filePath);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size > maximumBytes ||
    (before.mode & 0o777) !== expectedMode
  ) {
    throw publicationError('metadata-read-invalid');
  }
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | NO_FOLLOW);
    const descriptor = await handle.stat();
    if (
      !sameIdentity(before, descriptor) ||
      descriptor.size > maximumBytes ||
      descriptor.mode !== before.mode
    ) {
      throw publicationError('metadata-identity-race');
    }
    const bytes = await handle.readFile();
    const after = await fs.promises.lstat(filePath);
    if (
      bytes.byteLength !== descriptor.size ||
      !sameIdentity(descriptor, after) ||
      after.isSymbolicLink() ||
      after.mode !== descriptor.mode
    ) {
      throw publicationError('metadata-changed-during-read');
    }
    return bytes;
  } finally {
    await handle?.close();
  }
}

export async function walkTreeNoLinks(
  root: string
): Promise<{ readonly files: ReadonlySet<string>; readonly directories: ReadonlySet<string> }> {
  const files = new Set<string>();
  const directories = new Set<string>();

  async function visit(directory: string): Promise<void> {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      const stat = await fs.promises.lstat(candidate);
      if (stat.isSymbolicLink()) throw publicationError('symlink-refused');
      const relative = path.relative(root, candidate).split(path.sep).join('/');
      if (stat.isDirectory()) {
        if ((stat.mode & 0o777) !== BACKUP_DIRECTORY_MODE) {
          throw publicationError('directory-mode-mismatch');
        }
        directories.add(relative);
        await visit(candidate);
      } else if (stat.isFile()) {
        files.add(relative);
      } else {
        throw publicationError('non-file-entry-refused');
      }
    }
  }

  await visit(root);
  return { files, directories };
}

export async function fsyncDirectory(directory: string): Promise<void> {
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(directory, fs.constants.O_RDONLY | DIRECTORY_ONLY | NO_FOLLOW);
    const stat = await handle.stat();
    if (!stat.isDirectory()) throw publicationError('fsync-target-not-directory');
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

export async function reapOwnedPreparationDirectories(
  layout: BackupPathLayout,
  backupRunId: BackupRunId
): Promise<void> {
  const prefix = `.prepare-${backupRunId}-`;
  const names = await fs.promises.readdir(layout.stagingRoot);
  for (const name of names) {
    const suffix = name.slice(prefix.length);
    if (!name.startsWith(prefix) || !PREPARATION_DIRECTORY_SUFFIX_PATTERN.test(suffix)) continue;
    await removeOwnedPreparationDirectory(
      pathsForDirectory(path.join(layout.stagingRoot, name)),
      backupRunId,
      layout.stagingRoot
    );
  }
}

export async function removeOwnedPreparationDirectory(
  paths: BackupStagePaths,
  backupRunId: BackupRunId,
  parent: string
): Promise<void> {
  const stat = await lstatOrNull(paths.directory);
  if (!stat) return;
  try {
    await requireOwnedStage(paths, backupRunId, parent);
    const observed = await walkTreeNoLinks(paths.directory);
    if (
      observed.directories.size === 0 &&
      observed.files.size === 1 &&
      observed.files.has(BACKUP_STAGE_OWNER_FILE)
    ) {
      await fs.promises.rm(paths.directory, { recursive: true });
      await fsyncDirectory(parent);
    }
  } catch {
    // A preparation path that no longer proves ownership is deliberately left untouched.
  }
}

export async function removeOwnedMarkerTemporaryFiles(
  paths: BackupStagePaths,
  backupRunId: BackupRunId,
  stagingRoot: string
): Promise<void> {
  await requireOwnedStage(paths, backupRunId, stagingRoot);
  const names = await fs.promises.readdir(paths.directory);
  for (const name of names) {
    const suffix = name.slice(MARKER_TEMPORARY_PREFIX.length);
    if (
      !name.startsWith(MARKER_TEMPORARY_PREFIX) ||
      !MARKER_TEMPORARY_SUFFIX_PATTERN.test(suffix)
    ) {
      continue;
    }
    await removePrivateTemporaryFile(path.join(paths.directory, name), paths.directory);
  }
}

export async function removePrivateTemporaryFile(filePath: string, parent: string): Promise<void> {
  const stat = await lstatOrNull(filePath);
  if (
    !stat ||
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o777) !== BACKUP_METADATA_FILE_MODE
  ) {
    return;
  }
  await fs.promises.unlink(filePath);
  await fsyncDirectory(parent);
}

export async function lstatOrNull(filePath: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.lstat(filePath);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

export async function unlinkIfSameIdentity(filePath: string, expected: fs.Stats): Promise<void> {
  const observed = await lstatOrNull(filePath);
  if (!observed) return;
  if (!sameIdentity(expected, observed) || observed.isSymbolicLink() || !observed.isFile()) {
    throw publicationError('sqlite-artifact-cleanup-identity-mismatch');
  }
  await fs.promises.unlink(filePath);
}

export function sameIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export function markerMatchesManifest(
  marker: BackupCommitMarker,
  manifest: BackupManifest,
  backupRunId: BackupRunId
): boolean {
  return (
    marker.backupRunId === backupRunId &&
    manifest.backupRunId === backupRunId &&
    marker.format === COORDINATION_BACKUP_COMMIT_MARKER_FORMAT &&
    manifest.format === COORDINATION_BACKUP_FORMAT &&
    marker.manifestHash === manifest.manifestHash &&
    marker.deploymentId === manifest.deploymentId &&
    marker.sealedAt === manifest.sealedAt
  );
}

export function ownerFor(backupRunId: BackupRunId): StageOwner {
  return Object.freeze({ format: OWNER_FORMAT, backupRunId });
}

export function committedPublication(
  backupRunId: BackupRunId,
  manifestHash: Sha256Digest
): CommittedBackupPublication {
  return Object.freeze({
    backupRunId,
    manifestHash,
    immutableGeneration: generationName(backupRunId, manifestHash),
  });
}

export function pathsForDirectory(directory: string): BackupStagePaths {
  return {
    directory,
    owner: path.join(directory, BACKUP_STAGE_OWNER_FILE),
    manifest: path.join(directory, BACKUP_ROOT_MANIFEST_FILE),
    marker: path.join(directory, BACKUP_COMMIT_MARKER_FILE),
  };
}

export function publicationError(code: string): BackupPublicationError {
  return new BackupPublicationError(code);
}

export function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

export function isAlreadyExists(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'EEXIST' || code === 'ENOTEMPTY';
}
