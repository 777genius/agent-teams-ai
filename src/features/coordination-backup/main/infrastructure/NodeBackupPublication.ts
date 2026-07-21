import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  type BackupCommitMarker,
  type BackupManifest,
  type BackupManifestEntry,
  type BackupPublicationInspection,
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
  createBackupPathLayout,
  generationName,
  generationPaths,
  isPathInside,
  manifestHashFromGenerationName,
  resolveArtifactPath,
  stagePaths,
  validateArtifactEntryId,
} from './backupPathLayout';
import { canonicalBackupJson } from './canonicalBackupJson';
import { NodeBackupManifestHasher } from './NodeBackupManifestHasher';

import type { BackupPublicationPort } from '../../core/application';

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

export interface NodeBackupPublicationOptions {
  readonly backupRoot: string;
}

export interface BackupArtifactWriteRequest {
  readonly backupRunId: BackupRunId;
  readonly entryId: string;
  readonly participantId: string;
  readonly kind: BackupManifestEntry['kind'];
  readonly logicalOwner: string;
  readonly logicalType: string;
  readonly schemaVersion: number;
  readonly sourceGeneration: string;
  readonly bytes: Uint8Array;
  readonly mode: number;
}

export interface BackupArtifactMeasureRequest {
  readonly backupRunId: BackupRunId;
  readonly entryId: string;
}

/** A capability writer for one declared artifact; it never exposes its filesystem location. */
export interface BackupPublicationArtifactWriter {
  writeArtifact(request: BackupArtifactWriteRequest): Promise<BackupManifestEntry>;
  measureStagedArtifact(request: BackupArtifactMeasureRequest): Promise<MeasuredBackupEntry>;
}

export interface SqliteBackupArtifactChunk {
  readonly offset: number;
  readonly totalByteLength: number;
  readonly bytes: Uint8Array;
  readonly eof: boolean;
}

/**
 * A run/entry-bound publication sink. The SQLite worker supplies immutable
 * chunks from its private Online Backup scratch file; no reusable filesystem
 * path capability crosses the main/worker boundary.
 */
export interface SqliteBackupArtifactPublisher {
  publishSqliteSnapshot(request: {
    readonly backupRunId: BackupRunId;
    readonly entryId: string;
    readonly byteLength: number;
    readonly sha256: Sha256Digest;
    readonly readChunk: (offset: number) => Promise<SqliteBackupArtifactChunk>;
  }): Promise<MeasuredBackupEntry>;
}

export class BackupPublicationError extends Error {
  constructor(readonly code: string) {
    super(`coordination-backup-publication-${code}`);
    this.name = 'BackupPublicationError';
  }
}

export class NodeBackupPublication
  implements BackupPublicationPort, BackupPublicationArtifactWriter, SqliteBackupArtifactPublisher
{
  private readonly configuredLayout: BackupPathLayout;
  private readonly manifestHasher = new NodeBackupManifestHasher();
  private readonly runLocks = new Map<string, Promise<void>>();
  private boundLayout: BackupPathLayout | null = null;

  constructor(options: NodeBackupPublicationOptions | string) {
    this.configuredLayout = createBackupPathLayout(
      typeof options === 'string' ? options : options.backupRoot
    );
  }

  async preparePrivateStage(backupRunId: BackupRunId): Promise<void> {
    return this.withRunLock(backupRunId, async () => {
      const layout = await this.ensureLayout();
      await reapOwnedPreparationDirectories(layout, backupRunId);
      const inspection = await this.inspectUnlocked(layout, backupRunId);
      if (
        inspection.status === 'committed' ||
        inspection.status === 'staging_unsealed' ||
        inspection.status === 'staging_sealed'
      ) {
        return;
      }
      if (inspection.status !== 'absent') throw publicationError('prepare-state-ambiguous');

      const temporaryDirectory = await fs.promises.mkdtemp(
        path.join(layout.stagingRoot, `.prepare-${backupRunId}-`)
      );
      const temporaryPaths = pathsForDirectory(temporaryDirectory);
      try {
        await requireDirectory(temporaryDirectory, BACKUP_DIRECTORY_MODE, layout.stagingRoot);
        await writeExclusiveFile(
          temporaryPaths.owner,
          Buffer.from(canonicalBackupJson(ownerFor(backupRunId)), 'utf8'),
          BACKUP_METADATA_FILE_MODE
        );
        await fsyncDirectory(temporaryDirectory);
        const destination = stagePaths(layout, backupRunId).directory;
        try {
          await fs.promises.rename(temporaryDirectory, destination);
          await fsyncDirectory(layout.stagingRoot);
        } catch (error) {
          if (!isAlreadyExists(error)) throw error;
          const raced = await this.inspectUnlocked(layout, backupRunId);
          if (raced.status !== 'staging_unsealed') throw publicationError('prepare-race-ambiguous');
        }
      } finally {
        await removeOwnedPreparationDirectory(temporaryPaths, backupRunId, layout.stagingRoot);
      }
    });
  }

  async inspect(backupRunId: BackupRunId): Promise<BackupPublicationInspection> {
    return this.withRunLock(backupRunId, async () => {
      try {
        const layout = await this.findExistingLayout();
        return layout ? this.inspectUnlocked(layout, backupRunId) : { status: 'absent' };
      } catch {
        return { status: 'ambiguous' };
      }
    });
  }

  async writeArtifact(request: BackupArtifactWriteRequest): Promise<BackupManifestEntry> {
    return this.withRunLock(request.backupRunId, async () => {
      validateArtifactWriteRequest(request);
      const layout = await this.ensureLayout();
      const paths = stagePaths(layout, request.backupRunId);
      await requireOwnedStage(paths, request.backupRunId, layout.stagingRoot);
      await requireUnsealedAndManifestFree(paths);

      const artifactPath = resolveArtifactPath(paths.directory, request.entryId);
      await createArtifactParents(paths.directory, request.entryId);
      const bytes = Buffer.from(request.bytes);
      const expectedHash = parseSha256Digest(createHash('sha256').update(bytes).digest('hex'));
      await writeIdempotentFile(artifactPath, bytes, request.mode, expectedHash);
      await fsyncArtifactParents(paths.directory, request.entryId);

      return Object.freeze({
        entryId: request.entryId,
        participantId: request.participantId,
        kind: request.kind,
        logicalOwner: request.logicalOwner,
        logicalType: request.logicalType,
        schemaVersion: request.schemaVersion,
        byteLength: bytes.byteLength,
        mode: request.mode,
        sha256: expectedHash,
        sourceGeneration: request.sourceGeneration,
      });
    });
  }

  async measureStagedArtifact(request: BackupArtifactMeasureRequest): Promise<MeasuredBackupEntry> {
    return this.withRunLock(request.backupRunId, async () => {
      const layout = await this.ensureLayout();
      const paths = stagePaths(layout, request.backupRunId);
      await requireOwnedStage(paths, request.backupRunId, layout.stagingRoot);
      const measured = await measureRegularFile(
        resolveArtifactPath(paths.directory, request.entryId),
        request.entryId
      );
      return Object.freeze(measured);
    });
  }

  async publishSqliteSnapshot(request: {
    readonly backupRunId: BackupRunId;
    readonly entryId: string;
    readonly byteLength: number;
    readonly sha256: Sha256Digest;
    readonly readChunk: (offset: number) => Promise<SqliteBackupArtifactChunk>;
  }): Promise<MeasuredBackupEntry> {
    return this.withRunLock(request.backupRunId, async () => {
      validateArtifactEntryId(request.entryId);
      if (!Number.isSafeInteger(request.byteLength) || request.byteLength <= 0) {
        throw publicationError('sqlite-source-length-invalid');
      }
      parseSha256Digest(request.sha256);
      const layout = await this.ensureLayout();
      const paths = stagePaths(layout, request.backupRunId);
      await requireOwnedStage(paths, request.backupRunId, layout.stagingRoot);
      await requireUnsealedAndManifestFree(paths);
      await createArtifactParents(paths.directory, request.entryId);
      const artifactPath = resolveArtifactPath(paths.directory, request.entryId);
      const existing = await lstatOrNull(artifactPath);
      if (existing) {
        const measured = await measureRegularFile(artifactPath, request.entryId);
        if (
          measured.byteLength !== request.byteLength ||
          measured.sha256 !== request.sha256 ||
          measured.mode !== BACKUP_METADATA_FILE_MODE
        ) {
          throw publicationError('sqlite-artifact-existing-mismatch');
        }
        return Object.freeze(measured);
      }

      let handle: fs.promises.FileHandle | null = null;
      let createdIdentity: fs.Stats | null = null;
      try {
        handle = await fs.promises.open(
          artifactPath,
          fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NO_FOLLOW,
          BACKUP_METADATA_FILE_MODE
        );
        await handle.chmod(BACKUP_METADATA_FILE_MODE);
        createdIdentity = await handle.stat();
        if (!createdIdentity.isFile()) throw publicationError('sqlite-artifact-not-regular');
        const hash = createHash('sha256');
        let offset = 0;
        while (offset < request.byteLength) {
          const chunk = await request.readChunk(offset);
          if (
            chunk.offset !== offset ||
            chunk.totalByteLength !== request.byteLength ||
            !(chunk.bytes instanceof Uint8Array) ||
            chunk.bytes.byteLength === 0 ||
            offset + chunk.bytes.byteLength > request.byteLength ||
            chunk.eof !== (offset + chunk.bytes.byteLength === request.byteLength)
          ) {
            throw publicationError('sqlite-source-chunk-invalid');
          }
          const bytes = Buffer.from(chunk.bytes);
          let written = 0;
          while (written < bytes.byteLength) {
            const result = await handle.write(
              bytes,
              written,
              bytes.byteLength - written,
              offset + written
            );
            if (result.bytesWritten === 0) throw publicationError('sqlite-artifact-short-write');
            written += result.bytesWritten;
          }
          hash.update(bytes);
          offset += bytes.byteLength;
        }
        if (hash.digest('hex') !== request.sha256) {
          throw publicationError('sqlite-source-digest-mismatch');
        }
        await handle.sync();
        const finalized = await handle.stat();
        if (
          !sameIdentity(createdIdentity, finalized) ||
          finalized.size !== request.byteLength ||
          (finalized.mode & 0o777) !== BACKUP_METADATA_FILE_MODE
        ) {
          throw publicationError('sqlite-artifact-finalize-mismatch');
        }
        await handle.close();
        handle = null;
        await requireOwnedStage(paths, request.backupRunId, layout.stagingRoot);
        await requireUnsealedAndManifestFree(paths);
        await createArtifactParents(paths.directory, request.entryId);
        const measured = await measureRegularFile(artifactPath, request.entryId);
        if (
          measured.byteLength !== request.byteLength ||
          measured.sha256 !== request.sha256 ||
          measured.mode !== BACKUP_METADATA_FILE_MODE
        ) {
          throw publicationError('sqlite-artifact-measurement-mismatch');
        }
        await fsyncArtifactParents(paths.directory, request.entryId);
        return Object.freeze(measured);
      } catch (error) {
        await handle?.close().catch(() => undefined);
        if (createdIdentity) await unlinkIfSameIdentity(artifactPath, createdIdentity);
        throw error;
      }
    });
  }

  async writeRootManifest(request: {
    readonly backupRunId: BackupRunId;
    readonly manifest: BackupManifest;
  }): Promise<void> {
    return this.withRunLock(request.backupRunId, async () => {
      const layout = await this.ensureLayout();
      const paths = stagePaths(layout, request.backupRunId);
      await requireOwnedStage(paths, request.backupRunId, layout.stagingRoot);
      if (await lstatOrNull(paths.marker)) throw publicationError('manifest-after-marker');
      await validateManifestHash(this.manifestHasher, request.manifest);
      await validateArtifactTree(paths, request.manifest, false);
      await writeIdempotentMetadata(paths.manifest, request.manifest);
      await fsyncDirectory(paths.directory);
    });
  }

  async writeCommitMarkerLast(request: {
    readonly backupRunId: BackupRunId;
    readonly marker: BackupCommitMarker;
  }): Promise<void> {
    return this.withRunLock(request.backupRunId, async () => {
      const layout = await this.ensureLayout();
      const paths = stagePaths(layout, request.backupRunId);
      await requireOwnedStage(paths, request.backupRunId, layout.stagingRoot);
      await removeOwnedMarkerTemporaryFiles(paths, request.backupRunId, layout.stagingRoot);
      const manifest = await readTypedMetadata<BackupManifest>(paths.manifest);
      await validateManifestHash(this.manifestHasher, manifest);
      if (!markerMatchesManifest(request.marker, manifest, request.backupRunId)) {
        throw publicationError('commit-marker-manifest-mismatch');
      }
      const markerStat = await lstatOrNull(paths.marker);
      await validateArtifactTree(paths, manifest, markerStat !== null);
      if (markerStat) {
        const existing = await readTypedMetadata<BackupCommitMarker>(paths.marker);
        if (canonicalBackupJson(existing) !== canonicalBackupJson(request.marker)) {
          throw publicationError('commit-marker-mismatch');
        }
        await requireMetadataMode(paths.marker, markerStat);
        return;
      }

      const temporaryMarker = path.join(
        paths.directory,
        `${MARKER_TEMPORARY_PREFIX}${randomUUID()}`
      );
      try {
        await writeExclusiveFile(
          temporaryMarker,
          Buffer.from(canonicalBackupJson(request.marker), 'utf8'),
          BACKUP_METADATA_FILE_MODE
        );
        await fs.promises.rename(temporaryMarker, paths.marker);
        await fsyncDirectory(paths.directory);
        await fsyncDirectory(layout.stagingRoot);
      } finally {
        await removePrivateTemporaryFile(temporaryMarker, paths.directory);
      }
    });
  }

  async commitSealedStage(request: {
    readonly backupRunId: BackupRunId;
    readonly manifestHash: Sha256Digest;
  }): Promise<CommittedBackupPublication> {
    return this.withRunLock(request.backupRunId, async () => {
      const layout = await this.ensureLayout();
      const inspection = await this.inspectUnlocked(layout, request.backupRunId);
      if (inspection.status === 'committed') {
        if (inspection.publication.manifestHash !== request.manifestHash) {
          throw publicationError('committed-generation-mismatch');
        }
        return inspection.publication;
      }
      if (inspection.status !== 'staging_sealed') {
        throw publicationError('stage-not-sealed');
      }

      const source = stagePaths(layout, request.backupRunId);
      const manifest = await readTypedMetadata<BackupManifest>(source.manifest);
      if (manifest.manifestHash !== request.manifestHash) {
        throw publicationError('sealed-manifest-hash-mismatch');
      }
      await validateManifestHash(this.manifestHasher, manifest);
      await validateArtifactTree(source, manifest, true);

      const target = generationPaths(layout, request.backupRunId, request.manifestHash);
      if (await lstatOrNull(target.directory))
        throw publicationError('immutable-generation-exists');
      await fs.promises.rename(source.directory, target.directory);
      // Make the new recoverable name durable before making removal of the old name durable.
      await fsyncDirectory(layout.generationsRoot);
      await fsyncDirectory(layout.stagingRoot);

      return committedPublication(request.backupRunId, request.manifestHash);
    });
  }

  async abortUncommittedStage(backupRunId: BackupRunId): Promise<void> {
    return this.withRunLock(backupRunId, async () => {
      const layout = await this.findExistingLayout();
      if (!layout) return;
      const inspection = await this.inspectUnlocked(layout, backupRunId);
      if (inspection.status === 'absent') return;
      if (inspection.status !== 'staging_unsealed') {
        throw publicationError('abort-refused');
      }
      const paths = stagePaths(layout, backupRunId);
      await requireOwnedStage(paths, backupRunId, layout.stagingRoot);
      await walkTreeNoLinks(paths.directory);
      if (await lstatOrNull(paths.marker)) throw publicationError('abort-sealed-stage');
      await fs.promises.rm(paths.directory, { recursive: true });
      await fsyncDirectory(layout.stagingRoot);
    });
  }

  private async ensureLayout(): Promise<BackupPathLayout> {
    await fs.promises.mkdir(this.configuredLayout.root, {
      recursive: true,
      mode: BACKUP_DIRECTORY_MODE,
    });
    const rootStat = await fs.promises.lstat(this.configuredLayout.root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
      throw publicationError('root-invalid');
    const canonicalRoot = await fs.promises.realpath(this.configuredLayout.root);
    const candidate = createBackupPathLayout(canonicalRoot);
    if (this.boundLayout && this.boundLayout.root !== candidate.root) {
      throw publicationError('root-binding-changed');
    }
    this.boundLayout = candidate;

    await createOrRequirePrivateDirectory(candidate.stagingRoot, candidate.root);
    await createOrRequirePrivateDirectory(candidate.generationsRoot, candidate.root);
    return candidate;
  }

  private async findExistingLayout(): Promise<BackupPathLayout | null> {
    const rootStat = await lstatOrNull(this.configuredLayout.root);
    if (!rootStat) return null;
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
      throw publicationError('root-invalid');
    const canonicalRoot = await fs.promises.realpath(this.configuredLayout.root);
    const candidate = createBackupPathLayout(canonicalRoot);
    if (this.boundLayout && this.boundLayout.root !== candidate.root) {
      throw publicationError('root-binding-changed');
    }
    const [stagingStat, generationsStat] = await Promise.all([
      lstatOrNull(candidate.stagingRoot),
      lstatOrNull(candidate.generationsRoot),
    ]);
    if (!stagingStat && !generationsStat) return null;
    if (!stagingStat || !generationsStat) throw publicationError('layout-partial');
    await requireDirectory(candidate.stagingRoot, BACKUP_DIRECTORY_MODE, candidate.root);
    await requireDirectory(candidate.generationsRoot, BACKUP_DIRECTORY_MODE, candidate.root);
    this.boundLayout = candidate;
    return candidate;
  }

  private async inspectUnlocked(
    layout: BackupPathLayout,
    backupRunId: BackupRunId
  ): Promise<BackupPublicationInspection> {
    try {
      const stage = stagePaths(layout, backupRunId);
      const stageStat = await lstatOrNull(stage.directory);
      const generations = await generationCandidates(layout, backupRunId);
      if (generations.length > 1 || (stageStat && generations.length > 0)) {
        return { status: 'ambiguous' };
      }
      if (generations.length === 1) {
        const candidate = generations[0];
        const hashText = manifestHashFromGenerationName(candidate.name, backupRunId);
        if (!hashText) return { status: 'ambiguous' };
        const hash = parseSha256Digest(hashText);
        const paths = pathsForDirectory(candidate.path);
        await requireOwnedStage(paths, backupRunId, layout.generationsRoot);
        const { manifest, marker } = await readSealedMetadata(paths, backupRunId);
        if (manifest.manifestHash !== hash || marker.manifestHash !== hash) {
          return { status: 'ambiguous' };
        }
        return { status: 'committed', publication: committedPublication(backupRunId, hash) };
      }
      if (!stageStat) return { status: 'absent' };
      if (!stageStat.isDirectory() || stageStat.isSymbolicLink()) return { status: 'ambiguous' };
      await requireOwnedStage(stage, backupRunId, layout.stagingRoot);
      const marker = await lstatOrNull(stage.marker);
      if (!marker) return { status: 'staging_unsealed' };
      await readSealedMetadata(stage, backupRunId);
      return { status: 'staging_sealed' };
    } catch {
      return { status: 'ambiguous' };
    }
  }

  private async withRunLock<T>(backupRunId: BackupRunId, action: () => Promise<T>): Promise<T> {
    const key = backupRunId as string;
    const previous = this.runLocks.get(key) ?? Promise.resolve();
    let release = (): void => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.runLocks.set(key, current);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.runLocks.get(key) === current) this.runLocks.delete(key);
    }
  }
}

async function generationCandidates(
  layout: BackupPathLayout,
  backupRunId: BackupRunId
): Promise<readonly { readonly name: string; readonly path: string }[]> {
  const names = await fs.promises.readdir(layout.generationsRoot);
  const prefix = `${backupRunId}.`;
  return names
    .filter((name) => name.startsWith(prefix))
    .map((name) => ({ name, path: path.join(layout.generationsRoot, name) }));
}

async function readSealedMetadata(
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

async function validateManifestHash(
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

async function validateArtifactTree(
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

function validateManifestEntry(entry: BackupManifestEntry): void {
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

function validateArtifactWriteRequest(request: BackupArtifactWriteRequest): void {
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

function requireNonEmpty(value: string, field: string): void {
  if (typeof value !== 'string' || value.length === 0) throw publicationError(`${field}-invalid`);
}

function isFileMode(mode: number): boolean {
  return Number.isInteger(mode) && mode >= 0 && mode <= 0o777 && (mode & 0o400) !== 0;
}

async function createArtifactParents(directory: string, entryId: string): Promise<void> {
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

async function fsyncArtifactParents(directory: string, entryId: string): Promise<void> {
  const ancestors = [...artifactAncestorEntryIds(entryId)].reverse();
  for (const relative of ancestors) await fsyncDirectory(resolveArtifactPath(directory, relative));
  await fsyncDirectory(directory);
}

async function createOrRequirePrivateDirectory(directory: string, parent: string): Promise<void> {
  try {
    await fs.promises.mkdir(directory, { mode: BACKUP_DIRECTORY_MODE });
    await fsyncDirectory(parent);
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  }
  await requireDirectory(directory, BACKUP_DIRECTORY_MODE, parent);
}

async function requireDirectory(
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

async function requireOwnedStage(
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

async function requireUnsealedAndManifestFree(paths: BackupStagePaths): Promise<void> {
  if (await lstatOrNull(paths.marker)) throw publicationError('stage-sealed');
  if (await lstatOrNull(paths.manifest)) throw publicationError('stage-manifest-written');
}

async function writeIdempotentMetadata(filePath: string, value: unknown): Promise<void> {
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

async function readTypedMetadata<T>(filePath: string): Promise<T> {
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

async function requireMetadataMode(filePath: string, stat: fs.Stats): Promise<void> {
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    (stat.mode & 0o777) !== BACKUP_METADATA_FILE_MODE
  ) {
    throw publicationError(`metadata-file-invalid:${path.basename(filePath)}`);
  }
}

async function writeIdempotentFile(
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

async function writeExclusiveFile(filePath: string, bytes: Buffer, mode: number): Promise<void> {
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

async function readRegularFileNoFollow(
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

async function walkTreeNoLinks(
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

async function fsyncDirectory(directory: string): Promise<void> {
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

async function reapOwnedPreparationDirectories(
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

async function removeOwnedPreparationDirectory(
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

async function removeOwnedMarkerTemporaryFiles(
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

async function removePrivateTemporaryFile(filePath: string, parent: string): Promise<void> {
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

async function lstatOrNull(filePath: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.lstat(filePath);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

async function unlinkIfSameIdentity(filePath: string, expected: fs.Stats): Promise<void> {
  const observed = await lstatOrNull(filePath);
  if (!observed) return;
  if (!sameIdentity(expected, observed) || observed.isSymbolicLink() || !observed.isFile()) {
    throw publicationError('sqlite-artifact-cleanup-identity-mismatch');
  }
  await fs.promises.unlink(filePath);
}

function sameIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function markerMatchesManifest(
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

function ownerFor(backupRunId: BackupRunId): StageOwner {
  return Object.freeze({ format: OWNER_FORMAT, backupRunId });
}

function committedPublication(
  backupRunId: BackupRunId,
  manifestHash: Sha256Digest
): CommittedBackupPublication {
  return Object.freeze({
    backupRunId,
    manifestHash,
    immutableGeneration: generationName(backupRunId, manifestHash),
  });
}

function pathsForDirectory(directory: string): BackupStagePaths {
  return {
    directory,
    owner: path.join(directory, BACKUP_STAGE_OWNER_FILE),
    manifest: path.join(directory, BACKUP_ROOT_MANIFEST_FILE),
    marker: path.join(directory, BACKUP_COMMIT_MARKER_FILE),
  };
}

function publicationError(code: string): BackupPublicationError {
  return new BackupPublicationError(code);
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

function isAlreadyExists(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'EEXIST' || code === 'ENOTEMPTY';
}
