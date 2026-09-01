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
  type MeasuredBackupEntry,
  parseSha256Digest,
  type Sha256Digest,
} from '../../contracts';

import {
  BACKUP_COMMIT_MARKER_FILE,
  BACKUP_DIRECTORY_MODE,
  BACKUP_METADATA_FILE_MODE,
  type BackupPathLayout,
  createBackupPathLayout,
  generationPaths,
  manifestHashFromGenerationName,
  resolveArtifactPath,
  stagePaths,
  validateArtifactEntryId,
} from './backupPathLayout';
import { canonicalBackupJson } from './canonicalBackupJson';
import { NodeBackupManifestHasher } from './NodeBackupManifestHasher';
import {
  committedPublication,
  createArtifactParents,
  createOrRequirePrivateDirectory,
  fsyncArtifactParents,
  fsyncDirectory,
  generationCandidates,
  isAlreadyExists,
  lstatOrNull,
  markerMatchesManifest,
  measureRegularFile,
  ownerFor,
  pathsForDirectory,
  publicationError,
  readSealedMetadata,
  readTypedMetadata,
  reapOwnedPreparationDirectories,
  removeOwnedMarkerTemporaryFiles,
  removeOwnedPreparationDirectory,
  removePrivateTemporaryFile,
  requireDirectory,
  requireMetadataMode,
  requireOwnedStage,
  requireUnsealedAndManifestFree,
  sameIdentity,
  unlinkIfSameIdentity,
  validateArtifactTree,
  validateArtifactWriteRequest,
  validateManifestHash,
  walkTreeNoLinks,
  writeExclusiveFile,
  writeIdempotentFile,
  writeIdempotentMetadata,
} from './nodeBackupPublicationFs';
import {
  type BackupArtifactMeasureRequest,
  type BackupArtifactWriteRequest,
  type BackupPublicationArtifactWriter,
  type NodeBackupPublicationOptions,
  type SqliteBackupArtifactChunk,
  type SqliteBackupArtifactPublisher,
} from './nodeBackupPublicationTypes';

import type { BackupPublicationPort } from '../../core/application';

const NO_FOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const MARKER_TEMPORARY_PREFIX = `.${BACKUP_COMMIT_MARKER_FILE}.prepare-`;

interface BoundRootIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

async function readRootIdentity(root: string): Promise<BoundRootIdentity> {
  const stat = await fs.promises.stat(root, { bigint: true });
  if (!stat.isDirectory()) throw publicationError('root-invalid');
  return { dev: stat.dev, ino: stat.ino };
}

function sameRootIdentity(left: BoundRootIdentity, right: BoundRootIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export { measureRegularFile } from './nodeBackupPublicationFs';
export {
  type BackupArtifactMeasureRequest,
  type BackupArtifactWriteRequest,
  type BackupPublicationArtifactWriter,
  BackupPublicationError,
  type NodeBackupPublicationOptions,
  type SqliteBackupArtifactChunk,
  type SqliteBackupArtifactPublisher,
} from './nodeBackupPublicationTypes';

export class NodeBackupPublication
  implements BackupPublicationPort, BackupPublicationArtifactWriter, SqliteBackupArtifactPublisher
{
  private readonly configuredLayout: BackupPathLayout;
  private readonly manifestHasher = new NodeBackupManifestHasher();
  private readonly runLocks = new Map<string, Promise<void>>();
  private boundLayout: BackupPathLayout | null = null;
  private boundRootIdentity: BoundRootIdentity | null = null;

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
    if (this.boundRootIdentity && !(await lstatOrNull(this.configuredLayout.root))) {
      throw publicationError('root-binding-changed');
    }
    await fs.promises.mkdir(this.configuredLayout.root, {
      recursive: true,
      mode: BACKUP_DIRECTORY_MODE,
    });
    const rootStat = await fs.promises.lstat(this.configuredLayout.root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
      throw publicationError('root-invalid');
    const canonicalRoot = await fs.promises.realpath(this.configuredLayout.root);
    const candidate = createBackupPathLayout(canonicalRoot);
    const identity = await readRootIdentity(canonicalRoot);
    if (
      this.boundLayout &&
      (this.boundLayout.root !== candidate.root ||
        !this.boundRootIdentity ||
        !sameRootIdentity(this.boundRootIdentity, identity))
    ) {
      throw publicationError('root-binding-changed');
    }
    this.boundLayout = candidate;
    this.boundRootIdentity = identity;

    await createOrRequirePrivateDirectory(candidate.stagingRoot, candidate.root);
    await createOrRequirePrivateDirectory(candidate.generationsRoot, candidate.root);
    return candidate;
  }

  private async findExistingLayout(): Promise<BackupPathLayout | null> {
    const rootStat = await lstatOrNull(this.configuredLayout.root);
    if (!rootStat) {
      if (this.boundRootIdentity) throw publicationError('root-binding-changed');
      return null;
    }
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
      throw publicationError('root-invalid');
    const canonicalRoot = await fs.promises.realpath(this.configuredLayout.root);
    const candidate = createBackupPathLayout(canonicalRoot);
    const identity = await readRootIdentity(canonicalRoot);
    if (
      this.boundLayout &&
      (this.boundLayout.root !== candidate.root ||
        !this.boundRootIdentity ||
        !sameRootIdentity(this.boundRootIdentity, identity))
    ) {
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
    this.boundRootIdentity = identity;
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
