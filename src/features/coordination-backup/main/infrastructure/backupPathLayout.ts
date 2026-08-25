import path from 'node:path';

import type { BackupRunId, Sha256Digest } from '../../contracts';

export const BACKUP_STAGING_DIRECTORY = '.coordination-backup-staging';
export const BACKUP_GENERATIONS_DIRECTORY = 'coordination-backup-generations';
export const BACKUP_STAGE_OWNER_FILE = '.coordination-backup-stage.json';
export const BACKUP_ROOT_MANIFEST_FILE = 'manifest.json';
export const BACKUP_COMMIT_MARKER_FILE = 'commit-marker.json';

export const BACKUP_DIRECTORY_MODE = 0o700;
export const BACKUP_METADATA_FILE_MODE = 0o600;

const SHA256_TEXT_PATTERN = /^[0-9a-f]{64}$/;

export interface BackupPathLayout {
  readonly root: string;
  readonly stagingRoot: string;
  readonly generationsRoot: string;
}

export interface BackupStagePaths {
  readonly directory: string;
  readonly owner: string;
  readonly manifest: string;
  readonly marker: string;
}

export function createBackupPathLayout(root: string): BackupPathLayout {
  if (typeof root !== 'string' || root.length === 0 || !path.isAbsolute(root)) {
    throw new TypeError('coordination-backup-root-must-be-absolute');
  }
  const normalized = path.resolve(root);
  if (normalized === path.parse(normalized).root) {
    throw new TypeError('coordination-backup-root-too-broad');
  }
  return Object.freeze({
    root: normalized,
    stagingRoot: path.join(normalized, BACKUP_STAGING_DIRECTORY),
    generationsRoot: path.join(normalized, BACKUP_GENERATIONS_DIRECTORY),
  });
}

export function stagePaths(layout: BackupPathLayout, backupRunId: BackupRunId): BackupStagePaths {
  return pathsForDirectory(path.join(layout.stagingRoot, backupRunId));
}

export function generationName(backupRunId: BackupRunId, manifestHash: Sha256Digest): string {
  return `${backupRunId}.${manifestHash}`;
}

export function generationPaths(
  layout: BackupPathLayout,
  backupRunId: BackupRunId,
  manifestHash: Sha256Digest
): BackupStagePaths {
  return pathsForDirectory(
    path.join(layout.generationsRoot, generationName(backupRunId, manifestHash))
  );
}

export function isGenerationNameForRun(name: string, backupRunId: BackupRunId): boolean {
  const prefix = `${backupRunId}.`;
  return name.startsWith(prefix) && SHA256_TEXT_PATTERN.test(name.slice(prefix.length));
}

export function manifestHashFromGenerationName(
  name: string,
  backupRunId: BackupRunId
): string | null {
  if (!isGenerationNameForRun(name, backupRunId)) return null;
  return name.slice(backupRunId.length + 1);
}

export function resolveArtifactPath(directory: string, entryId: string): string {
  const segments = validateArtifactEntryId(entryId);
  const candidate = path.resolve(directory, ...segments);
  if (!isPathInside(directory, candidate)) {
    throw new TypeError('coordination-backup-artifact-path-escape');
  }
  return candidate;
}

export function validateArtifactEntryId(entryId: string): readonly string[] {
  if (
    typeof entryId !== 'string' ||
    entryId.length === 0 ||
    entryId.length > 512 ||
    entryId.includes('\\') ||
    entryId.includes('\0') ||
    path.posix.isAbsolute(entryId)
  ) {
    throw new TypeError('coordination-backup-artifact-entry-id-invalid');
  }
  const segments = entryId.split('/');
  if (
    segments.some(
      (segment) =>
        segment.length === 0 || segment === '.' || segment === '..' || segment.length > 255
    )
  ) {
    throw new TypeError('coordination-backup-artifact-entry-id-invalid');
  }
  if (
    segments.length === 1 &&
    [BACKUP_STAGE_OWNER_FILE, BACKUP_ROOT_MANIFEST_FILE, BACKUP_COMMIT_MARKER_FILE].includes(
      segments[0]
    )
  ) {
    throw new TypeError('coordination-backup-artifact-entry-id-reserved');
  }
  return Object.freeze(segments);
}

export function artifactAncestorEntryIds(entryId: string): readonly string[] {
  const segments = validateArtifactEntryId(entryId);
  const result: string[] = [];
  for (let index = 1; index < segments.length; index += 1) {
    result.push(segments.slice(0, index).join('/'));
  }
  return Object.freeze(result);
}

export function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative.length > 0 && !relative.startsWith(`..${path.sep}`) && relative !== '..';
}

function pathsForDirectory(directory: string): BackupStagePaths {
  return Object.freeze({
    directory,
    owner: path.join(directory, BACKUP_STAGE_OWNER_FILE),
    manifest: path.join(directory, BACKUP_ROOT_MANIFEST_FILE),
    marker: path.join(directory, BACKUP_COMMIT_MARKER_FILE),
  });
}
