import fs from 'node:fs';
import path from 'node:path';

import {
  type BackupCommitMarker,
  type BackupIdentityInventory,
  type BackupManifest,
  type BackupRunId,
  type CopiedSourceBackupRun,
  type ImmutableBackupInspection,
  type ImmutableBackupVerification,
  type MeasuredBackupEntry,
  parseSha256Digest,
} from '../../contracts';
import { validateImmutableBackupInspection } from '../../core/domain';

import {
  artifactAncestorEntryIds,
  BACKUP_COMMIT_MARKER_FILE,
  BACKUP_DIRECTORY_MODE,
  BACKUP_GENERATIONS_DIRECTORY,
  BACKUP_METADATA_FILE_MODE,
  BACKUP_ROOT_MANIFEST_FILE,
  BACKUP_STAGE_OWNER_FILE,
  BACKUP_STAGING_DIRECTORY,
  type BackupPathLayout,
  type BackupStagePaths,
  createBackupPathLayout,
  generationName,
  generationPaths,
  isPathInside,
  resolveArtifactPath,
  stagePaths,
  validateArtifactEntryId,
} from './backupPathLayout';
import { canonicalBackupJson } from './canonicalBackupJson';
import { NodeBackupManifestHasher } from './NodeBackupManifestHasher';
import { measureRegularFile } from './NodeBackupPublication';

import type { ImmutableBackupVerifierPort } from '../../core/application';

const NO_FOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const OWNER_FORMAT = 'coordination-backup-private-stage/v1' as const;
const MAX_METADATA_BYTES = 16 * 1024 * 1024;

export interface NodeImmutableBackupVerifierOptions {
  readonly backupRoot: string;
}

export class NodeImmutableBackupVerifier implements ImmutableBackupVerifierPort {
  private readonly layout: BackupPathLayout;
  private readonly manifestHasher = new NodeBackupManifestHasher();

  constructor(options: NodeImmutableBackupVerifierOptions | string) {
    this.layout = createBackupPathLayout(
      typeof options === 'string' ? options : options.backupRoot
    );
  }

  async verify(
    request: Parameters<ImmutableBackupVerifierPort['verify']>[0]
  ): Promise<ImmutableBackupVerification> {
    try {
      return await this.verifyOrThrow(request);
    } catch (error) {
      return {
        status: 'invalid',
        reasons: Object.freeze([verificationReason(error)]),
      };
    }
  }

  private async verifyOrThrow(
    request: Parameters<ImmutableBackupVerifierPort['verify']>[0]
  ): Promise<ImmutableBackupVerification> {
    const layout = await bindReadOnlyLayout(this.layout);
    const paths = await resolveUnambiguousLocation(
      layout,
      request.backupRunId,
      request.location,
      request.expectedPlan.manifest.manifestHash
    );
    await requireDirectory(paths.directory, layout.root);

    const expectedOwner = canonicalBackupJson({
      format: OWNER_FORMAT,
      backupRunId: request.backupRunId,
    });
    const observedOwner = await readCanonicalMetadata(paths.owner);
    if (observedOwner.serialized !== expectedOwner) throw verifierError('stage-owner-mismatch');

    const observedManifest = await readCanonicalMetadata(paths.manifest);
    const observedMarker = await readCanonicalMetadata(paths.marker);
    const expectedManifestJson = canonicalBackupJson(request.expectedPlan.manifest);
    const expectedMarkerJson = canonicalBackupJson(request.expectedPlan.marker);
    if (observedManifest.serialized !== expectedManifestJson) {
      throw verifierError('manifest-mismatch');
    }
    if (observedMarker.serialized !== expectedMarkerJson) {
      throw verifierError('commit-marker-mismatch');
    }

    const manifest = observedManifest.value as BackupManifest;
    const marker = observedMarker.value as BackupCommitMarker;
    const { manifestHash, ...manifestBody } = manifest;
    const computedManifestHash = await this.manifestHasher.hashCanonicalManifest(manifestBody);
    if (
      parseSha256Digest(manifestHash) !== computedManifestHash ||
      marker.manifestHash !== computedManifestHash
    ) {
      throw verifierError('manifest-digest-mismatch');
    }
    if (
      marker.backupRunId !== request.backupRunId ||
      manifest.backupRunId !== request.backupRunId ||
      marker.deploymentId !== manifest.deploymentId ||
      marker.sealedAt !== manifest.sealedAt
    ) {
      throw verifierError('marker-manifest-binding-mismatch');
    }

    const measuredEntries = await verifyExactTree(paths, manifest);
    const inspection = buildInspection(manifest, marker, computedManifestHash, measuredEntries);
    const domainValidation = validateImmutableBackupInspection(inspection);
    if (domainValidation.status === 'invalid') {
      return { status: 'invalid', reasons: domainValidation.reasons };
    }
    return { status: 'verified', inspection };
  }
}

async function bindReadOnlyLayout(configured: BackupPathLayout): Promise<BackupPathLayout> {
  const rootStat = await fs.promises.lstat(configured.root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw verifierError('root-invalid');
  const realRoot = await fs.promises.realpath(configured.root);
  const layout = createBackupPathLayout(realRoot);
  await requirePrivateDirectory(layout.stagingRoot, layout.root, BACKUP_STAGING_DIRECTORY);
  await requirePrivateDirectory(layout.generationsRoot, layout.root, BACKUP_GENERATIONS_DIRECTORY);
  return layout;
}

async function resolveUnambiguousLocation(
  layout: BackupPathLayout,
  backupRunId: BackupRunId,
  location: 'staging' | 'committed',
  manifestHash: BackupManifest['manifestHash']
): Promise<BackupStagePaths> {
  const stage = stagePaths(layout, backupRunId);
  const stageExists = (await lstatOrNull(stage.directory)) !== null;
  const prefix = `${backupRunId}.`;
  const candidates = (await fs.promises.readdir(layout.generationsRoot)).filter((name) =>
    name.startsWith(prefix)
  );
  if (location === 'staging') {
    if (!stageExists || candidates.length !== 0) throw verifierError('publication-ambiguous');
    return stage;
  }
  const expectedName = generationName(backupRunId, manifestHash);
  if (stageExists || candidates.length !== 1 || candidates[0] !== expectedName) {
    throw verifierError('publication-ambiguous');
  }
  return generationPaths(layout, backupRunId, manifestHash);
}

async function verifyExactTree(
  paths: BackupStagePaths,
  manifest: BackupManifest
): Promise<readonly MeasuredBackupEntry[]> {
  const expectedFiles = new Set<string>([
    BACKUP_STAGE_OWNER_FILE,
    BACKUP_ROOT_MANIFEST_FILE,
    BACKUP_COMMIT_MARKER_FILE,
  ]);
  const expectedDirectories = new Set<string>();
  const entryIds = new Set<string>();
  for (const entry of manifest.entries) {
    validateArtifactEntryId(entry.entryId);
    if (entryIds.has(entry.entryId)) throw verifierError('manifest-entry-duplicate');
    entryIds.add(entry.entryId);
    expectedFiles.add(entry.entryId);
    for (const ancestor of artifactAncestorEntryIds(entry.entryId)) {
      expectedDirectories.add(ancestor);
    }
  }

  const observed = await walkExactTree(paths.directory);
  requireSameSet(observed.files, expectedFiles, 'file-set-mismatch');
  requireSameSet(observed.directories, expectedDirectories, 'directory-set-mismatch');

  const measuredEntries: MeasuredBackupEntry[] = [];
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
      throw verifierError('artifact-digest-size-or-mode-mismatch');
    }
    measuredEntries.push(Object.freeze(measured));
  }
  return Object.freeze(measuredEntries);
}

function buildInspection(
  manifest: BackupManifest,
  marker: BackupCommitMarker,
  computedManifestHash: BackupManifest['manifestHash'],
  measuredEntries: readonly MeasuredBackupEntry[]
): ImmutableBackupInspection {
  /*
   * The independently checked SQLite digest binds the previously recorded integrity/inventory
   * evidence. Re-projecting these typed values from that hash-bound manifest does not reopen or copy
   * SQLite/WAL/SHM and cannot invent a different source generation.
   */
  const observedIdentityInventory: BackupIdentityInventory = manifest.identityInventory;
  const copiedSourceRun: CopiedSourceBackupRun = Object.freeze({
    backupRunId: manifest.sourceBackupRunId,
    deploymentId: manifest.deploymentId,
    productKind: manifest.productKind,
    purpose: manifest.purpose,
    state: 'sqlite_snapshot',
    fenceGeneration: manifest.fenceGeneration,
    coordinationBarrier: manifest.coordinationBarrier,
    participants: manifest.participants,
    identityInventory: manifest.identityInventory,
  });
  return Object.freeze({
    manifest,
    marker,
    computedManifestHash,
    measuredEntries,
    observedIdentityInventory,
    copiedSourceRun,
  });
}

async function readCanonicalMetadata(
  filePath: string
): Promise<{ readonly serialized: string; readonly value: unknown }> {
  const stat = await fs.promises.lstat(filePath);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size > MAX_METADATA_BYTES ||
    (stat.mode & 0o777) !== BACKUP_METADATA_FILE_MODE
  ) {
    throw verifierError('metadata-file-invalid');
  }
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | NO_FOLLOW);
    const descriptor = await handle.stat();
    if (
      !descriptor.isFile() ||
      !sameIdentity(stat, descriptor) ||
      descriptor.size > MAX_METADATA_BYTES ||
      descriptor.mode !== stat.mode
    ) {
      throw verifierError('metadata-identity-race');
    }
    const bytes = await handle.readFile();
    const after = await fs.promises.lstat(filePath);
    if (
      bytes.byteLength !== descriptor.size ||
      !sameIdentity(descriptor, after) ||
      after.isSymbolicLink() ||
      after.mode !== descriptor.mode
    ) {
      throw verifierError('metadata-changed-during-read');
    }
    const serialized = bytes.toString('utf8');
    let value: unknown;
    try {
      value = JSON.parse(serialized);
    } catch {
      throw verifierError('metadata-json-invalid');
    }
    if (canonicalBackupJson(value) !== serialized) throw verifierError('metadata-not-canonical');
    return { serialized, value };
  } finally {
    await handle?.close();
  }
}

async function walkExactTree(
  root: string
): Promise<{ readonly files: ReadonlySet<string>; readonly directories: ReadonlySet<string> }> {
  const files = new Set<string>();
  const directories = new Set<string>();

  async function visit(directory: string): Promise<void> {
    for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      const stat = await fs.promises.lstat(candidate);
      if (stat.isSymbolicLink()) throw verifierError('symlink-refused');
      const relative = path.relative(root, candidate).split(path.sep).join('/');
      if (stat.isDirectory()) {
        if ((stat.mode & 0o777) !== BACKUP_DIRECTORY_MODE) {
          throw verifierError('directory-mode-mismatch');
        }
        directories.add(relative);
        await visit(candidate);
      } else if (stat.isFile()) {
        files.add(relative);
      } else {
        throw verifierError('non-file-entry-refused');
      }
    }
  }

  await visit(root);
  return { files, directories };
}

async function requirePrivateDirectory(
  directory: string,
  root: string,
  expectedName: string
): Promise<void> {
  if (path.basename(directory) !== expectedName) throw verifierError('layout-invalid');
  await requireDirectory(directory, root);
}

async function requireDirectory(directory: string, parent: string): Promise<void> {
  const stat = await fs.promises.lstat(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o777) !== BACKUP_DIRECTORY_MODE
  ) {
    throw verifierError('directory-invalid');
  }
  const [realDirectory, realParent] = await Promise.all([
    fs.promises.realpath(directory),
    fs.promises.realpath(parent),
  ]);
  if (!isPathInside(realParent, realDirectory)) throw verifierError('directory-path-escape');
  const after = await fs.promises.lstat(directory);
  if (
    !sameIdentity(stat, after) ||
    !after.isDirectory() ||
    after.isSymbolicLink() ||
    after.mode !== stat.mode
  ) {
    throw verifierError('directory-identity-race');
  }
}

function requireSameSet(
  observed: ReadonlySet<string>,
  expected: ReadonlySet<string>,
  reason: string
): void {
  if (
    observed.size !== expected.size ||
    [...observed].some((entry) => !expected.has(entry)) ||
    [...expected].some((entry) => !observed.has(entry))
  ) {
    throw verifierError(reason);
  }
}

async function lstatOrNull(filePath: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return null;
    throw error;
  }
}

function sameIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function verifierError(reason: string): Error {
  return new Error(`coordination-backup-verifier-${reason}`);
}

function verificationReason(error: unknown): string {
  if (error instanceof Error && error.message.startsWith('coordination-backup-verifier-')) {
    return error.message.slice('coordination-backup-verifier-'.length);
  }
  if (error instanceof Error && error.message.startsWith('coordination-backup-publication-')) {
    return error.message.slice('coordination-backup-publication-'.length);
  }
  if (error instanceof TypeError && error.message.startsWith('coordination-backup-')) {
    return error.message.slice('coordination-backup-'.length);
  }
  return 'verification-boundary-failed';
}
