import { createHash } from 'node:crypto';

import * as fs from 'fs';
import * as path from 'path';

declare const projectRootAuthorityKeyBrand: unique symbol;

/** Opaque, process-internal physical project identity used for provider authority maps. */
export type ProjectRootAuthorityKey = string & {
  readonly [projectRootAuthorityKeyBrand]: true;
};

export interface ProjectRootIdentity {
  requestedPath: string;
  canonicalPath: string;
  stableFileId: string;
}

export interface ProjectRootIdentityLease {
  readonly identity: ProjectRootIdentity;
  readonly authorityKey: ProjectRootAuthorityKey;
  isCurrent(cwd?: string): boolean;
  matchesCurrentAuthority(authorityKey: ProjectRootAuthorityKey): boolean;
  close(): void;
}

interface ProjectRootFileStats {
  readonly dev: bigint;
  readonly ino: bigint;
  isDirectory(): boolean;
}

/** Injectable filesystem seam for platform-independent contract tests. */
export interface ProjectRootIdentityLeaseFileSystem {
  realpath(requestedPath: string): string;
  stat(requestedPath: string): ProjectRootFileStats;
  openDirectory(requestedPath: string): number;
  fstat(handle: number): ProjectRootFileStats;
  close(handle: number): void;
}

export interface ProjectRootIdentityLeaseOptions {
  platform?: NodeJS.Platform;
  fileSystem?: ProjectRootIdentityLeaseFileSystem;
  fallbackLexicalPath?: string;
}

const nodeFileSystem: ProjectRootIdentityLeaseFileSystem = {
  realpath: (requestedPath) => fs.realpathSync.native(requestedPath),
  stat: (requestedPath) => fs.statSync(requestedPath, { bigint: true }),
  openDirectory: (requestedPath) =>
    fs.openSync(requestedPath, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0)),
  fstat: (handle) => fs.fstatSync(handle, { bigint: true }),
  close: (handle) => fs.closeSync(handle),
};

export function canonicalProjectPathComparisonKey(
  canonicalPath: string,
  platform: NodeJS.Platform = process.platform
): string {
  const normalized =
    platform === 'win32'
      ? path.win32.normalize(canonicalPath.trim())
      : path.normalize(canonicalPath.trim());
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function stableFileId(stats: ProjectRootFileStats): string {
  const device = stats.dev.toString();
  const inode = stats.ino.toString();
  if (device === '0' || inode === '0') {
    throw new Error('Launch authorization cannot establish a stable project filesystem identity');
  }
  return `device:${device}:inode:${inode}`;
}

function opaqueAuthorityKey(kind: 'physical' | 'lexical', ...parts: string[]) {
  return createHash('sha256')
    .update(JSON.stringify([kind, ...parts]))
    .digest('hex') as ProjectRootAuthorityKey;
}

export function projectRootAuthorityKey(
  identity: Pick<ProjectRootIdentity, 'canonicalPath' | 'stableFileId'>
): ProjectRootAuthorityKey {
  return opaqueAuthorityKey('physical', identity.canonicalPath, identity.stableFileId);
}

function resolveRequestedPath(cwd: string, platform: NodeJS.Platform): string {
  const trimmed = cwd.trim();
  if (!trimmed) throw new Error('Launch authorization requires cwd to be a directory');
  return platform === 'win32' ? path.win32.resolve(trimmed) : path.resolve(trimmed);
}

function captureIdentity(
  cwd: string,
  platform: NodeJS.Platform,
  fileSystem: ProjectRootIdentityLeaseFileSystem
): { identity: ProjectRootIdentity; canonicalFsPath: string } {
  const requestedFsPath = resolveRequestedPath(cwd, platform);
  let canonicalFsPath: string;
  let stats: ProjectRootFileStats;
  try {
    canonicalFsPath = fileSystem.realpath(requestedFsPath);
    stats = fileSystem.stat(canonicalFsPath);
  } catch {
    throw new Error('Launch authorization requires an existing canonical project directory');
  }
  if (!stats.isDirectory()) throw new Error('Launch authorization requires cwd to be a directory');
  return {
    identity: {
      requestedPath: canonicalProjectPathComparisonKey(requestedFsPath, platform),
      canonicalPath: canonicalProjectPathComparisonKey(canonicalFsPath, platform),
      stableFileId: stableFileId(stats),
    },
    canonicalFsPath,
  };
}

/** Resolves an existing directory to a physical authority key without retaining a descriptor. */
export function resolveProjectRootAuthorityKey(
  cwd: string,
  options: ProjectRootIdentityLeaseOptions = {}
): ProjectRootAuthorityKey {
  const platform = options.platform ?? process.platform;
  const fileSystem = options.fileSystem ?? nodeFileSystem;
  return projectRootAuthorityKey(captureIdentity(cwd, platform, fileSystem).identity);
}

/**
 * Missing, remote, or identity-poor roots remain isolated by their normalized
 * lexical request path instead of being merged into an unverifiable scope.
 */
export function resolveConservativeProjectRootAuthorityKey(
  cwd: string,
  options: ProjectRootIdentityLeaseOptions = {}
): ProjectRootAuthorityKey {
  try {
    return resolveProjectRootAuthorityKey(cwd, options);
  } catch {
    const platform = options.platform ?? process.platform;
    const lexicalPath =
      options.fallbackLexicalPath !== undefined
        ? canonicalProjectPathComparisonKey(options.fallbackLexicalPath, platform)
        : canonicalProjectPathComparisonKey(resolveRequestedPath(cwd, platform), platform);
    return opaqueAuthorityKey('lexical', lexicalPath);
  }
}

function sameIdentity(left: ProjectRootIdentity, right: ProjectRootIdentity): boolean {
  return (
    left.requestedPath === right.requestedPath &&
    left.canonicalPath === right.canonicalPath &&
    left.stableFileId === right.stableFileId
  );
}

export function captureProjectRootIdentityLease(
  cwd: string,
  options: ProjectRootIdentityLeaseOptions = {}
): ProjectRootIdentityLease {
  const platform = options.platform ?? process.platform;
  const fileSystem = options.fileSystem ?? nodeFileSystem;
  const captured = captureIdentity(cwd, platform, fileSystem);
  const identity = captured.identity;
  const authorityKey = projectRootAuthorityKey(identity);
  let handle: number | null = null;
  let closed = false;
  try {
    // On Windows libuv opens directories through CreateFileW with
    // FILE_FLAG_BACKUP_SEMANTICS and FILE_SHARE_DELETE. fstat exposes the
    // volume serial and file index through dev/ino.
    handle = fileSystem.openDirectory(captured.canonicalFsPath);
    const heldStats = fileSystem.fstat(handle);
    if (!heldStats.isDirectory() || stableFileId(heldStats) !== identity.stableFileId) {
      throw new Error('Launch authorization project identity changed during capture');
    }
  } catch (error) {
    if (handle !== null) fileSystem.close(handle);
    throw error;
  }

  return {
    identity,
    authorityKey,
    isCurrent(candidateCwd?: string): boolean {
      if (closed || handle === null) return false;
      try {
        const heldStats = fileSystem.fstat(handle);
        const candidate = captureIdentity(
          candidateCwd ?? resolveRequestedPath(cwd, platform),
          platform,
          fileSystem
        ).identity;
        return (
          heldStats.isDirectory() &&
          stableFileId(heldStats) === identity.stableFileId &&
          sameIdentity(candidate, identity)
        );
      } catch {
        return false;
      }
    },
    matchesCurrentAuthority(candidateAuthorityKey: ProjectRootAuthorityKey): boolean {
      if (closed || handle === null || candidateAuthorityKey !== authorityKey) return false;
      try {
        const heldStats = fileSystem.fstat(handle);
        return heldStats.isDirectory() && stableFileId(heldStats) === identity.stableFileId;
      } catch {
        return false;
      }
    },
    close(): void {
      if (closed) return;
      closed = true;
      const ownedHandle = handle;
      handle = null;
      if (ownedHandle !== null) fileSystem.close(ownedHandle);
    },
  };
}
