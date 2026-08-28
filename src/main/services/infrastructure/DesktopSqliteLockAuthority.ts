import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const AUTHORITY_NAMESPACE_VERSION = 1;
const TEST_ROOT_ENV = 'AGENT_TEAMS_SQLITE_LOCK_ROOT_FOR_TESTS';
const WINDOWS_DIRECTORY_SYNC_UNSUPPORTED = new Set(['EACCES', 'EPERM', 'EISDIR', 'EBADF']);

interface PhysicalDirectoryIdentity {
  dev: string;
  ino: string;
}

export interface DesktopSqliteLockAuthority {
  readonly databasePath: string;
  assertTargetRoot(): void;
}

export interface DesktopSqliteLockPlatformPolicy {
  caseInsensitiveNames: boolean;
  databaseRoot: 'same-user-application-data';
  legacyFence: 'beside-target';
}

export function getDesktopSqliteLockPlatformPolicy(
  platform: NodeJS.Platform
): DesktopSqliteLockPlatformPolicy {
  return {
    caseInsensitiveNames: platform === 'win32',
    databaseRoot: 'same-user-application-data',
    legacyFence: 'beside-target',
  };
}

export function syncLockDirectory(directoryPath: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(directoryPath, 'r');
    fs.fsyncSync(descriptor);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (
      process.platform !== 'win32' ||
      code === undefined ||
      !WINDOWS_DIRECTORY_SYNC_UNSUPPORTED.has(code)
    ) {
      throw error;
    }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function directoryIdentity(stats: fs.BigIntStats): PhysicalDirectoryIdentity {
  return { dev: stats.dev.toString(), ino: stats.ino.toString() };
}

function sameDirectoryIdentity(
  left: PhysicalDirectoryIdentity,
  right: PhysicalDirectoryIdentity
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function normalizedName(value: string, platform: NodeJS.Platform): string {
  return getDesktopSqliteLockPlatformPolicy(platform).caseInsensitiveNames
    ? value.toLocaleLowerCase('en-US')
    : value;
}

function authorityRoot(): string {
  const testRoot = process.env.NODE_ENV === 'test' ? process.env[TEST_ROOT_ENV] : undefined;
  return testRoot ?? path.join(os.homedir(), '.agent-teams-ai', 'transaction-locks', 'v1');
}

function prepareAuthorityRoot(root: string): string {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const requestedStats = fs.lstatSync(root);
  if (requestedStats.isSymbolicLink() || !requestedStats.isDirectory()) {
    throw new Error(`Unsafe Desktop SQLite lock root: ${root}`);
  }
  const canonicalRoot = fs.realpathSync.native(root);
  if (
    process.platform !== 'win32' &&
    typeof process.getuid === 'function' &&
    requestedStats.uid !== process.getuid()
  ) {
    throw new Error(`Unsafe Desktop SQLite lock root: ${root}`);
  }
  if (process.platform !== 'win32') fs.chmodSync(canonicalRoot, 0o700);
  return canonicalRoot;
}

function authorityKey(
  canonicalParent: string,
  parentIdentity: PhysicalDirectoryIdentity,
  targetName: string,
  platform: NodeJS.Platform
): string {
  let targetIdentity: PhysicalDirectoryIdentity | undefined;
  try {
    const targetStats = fs.statSync(path.join(canonicalParent, targetName), { bigint: true });
    targetIdentity = { dev: targetStats.dev.toString(), ino: targetStats.ino.toString() };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const binding = JSON.stringify({
    version: AUTHORITY_NAMESPACE_VERSION,
    scope: targetIdentity
      ? { kind: 'existing-target', identity: targetIdentity }
      : {
          kind: 'parent-name',
          platform,
          canonicalParent: normalizedName(canonicalParent, platform),
          parentIdentity,
          targetName: normalizedName(targetName, platform),
        },
  });
  return createHash('sha256').update(binding).digest('hex');
}

/**
 * Moves SQLite's pathname-based I/O out of the mutable project tree while binding
 * every process to the same physical parent/name scope. The beside-target legacy
 * fence remains responsible for excluding older application versions.
 */
export function resolveDesktopSqliteLockAuthority(
  logicalTargetPath: string,
  platform: NodeJS.Platform = process.platform
): DesktopSqliteLockAuthority {
  const canonicalParent = fs.realpathSync.native(path.dirname(logicalTargetPath));
  const parentStats = fs.lstatSync(canonicalParent, { bigint: true });
  if (parentStats.isSymbolicLink() || !parentStats.isDirectory()) {
    throw new Error(`Unsafe Desktop SQLite lock target root: ${canonicalParent}`);
  }
  const parentIdentity = directoryIdentity(parentStats);
  const key = authorityKey(
    canonicalParent,
    parentIdentity,
    path.basename(logicalTargetPath),
    platform
  );
  const databasePath = path.join(prepareAuthorityRoot(authorityRoot()), `${key}.lock.sqlite3`);

  return {
    databasePath,
    assertTargetRoot(): void {
      const currentCanonicalParent = fs.realpathSync.native(path.dirname(logicalTargetPath));
      const currentStats = fs.lstatSync(canonicalParent, { bigint: true });
      if (
        currentCanonicalParent !== canonicalParent ||
        currentStats.isSymbolicLink() ||
        !currentStats.isDirectory() ||
        !sameDirectoryIdentity(parentIdentity, directoryIdentity(currentStats))
      ) {
        throw new Error(`Desktop SQLite lock target root changed: ${logicalTargetPath}`);
      }
    },
  };
}
