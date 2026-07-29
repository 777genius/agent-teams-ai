import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';

import {
  parseLegacyTeamKey,
  parseTeamIdentityRecord,
  type TeamIdentityRecord,
} from '@features/internal-storage/contracts';
import { parseDeploymentId, parseTeamId, type QueryContext } from '@shared/contracts/hosted';

import { isRecord } from './teamLifecycleReadShared';

const MAX_HOSTED_TEAM_CONFIG_BYTES = 2 * 1024 * 1024;
const MAX_HOSTED_TEAM_IDENTITY_BYTES = 4 * 1024;
const NO_FOLLOW = fs.constants.O_NOFOLLOW;

interface DirectoryEntryIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

export interface HostedReadOnlyTeamSummarySource {
  readTeamSummary(input: {
    readonly claudeRoot: string;
    readonly identity: TeamIdentityRecord;
    readonly context: QueryContext;
    readonly assertActive: () => void;
  }): Promise<Readonly<Record<PropertyKey, unknown>> | null>;
}

function isCanonicalTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function assertCanonicalIdentityFile(
  serialized: string,
  expectedIdentity: TeamIdentityRecord
): void {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error('team-lifecycle-read-canonical-identity-invalid');
  }
  if (!isRecord(value)) throw new Error('team-lifecycle-read-canonical-identity-invalid');

  const expectedKeys =
    value.originDeploymentId === undefined
      ? ['createdAt', 'schemaVersion', 'teamId']
      : ['createdAt', 'originDeploymentId', 'schemaVersion', 'teamId'];
  const keys = Reflect.ownKeys(value).sort();
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index]) ||
    value.schemaVersion !== 1 ||
    !isCanonicalTimestamp(value.createdAt)
  ) {
    throw new Error('team-lifecycle-read-canonical-identity-invalid');
  }

  const canonicalIdentity: Record<string, unknown> = {
    schemaVersion: 1,
    teamId: parseTeamId(value.teamId),
    createdAt: value.createdAt,
  };
  if (value.originDeploymentId !== undefined) {
    canonicalIdentity.originDeploymentId = parseDeploymentId(value.originDeploymentId);
  }
  const canonicalSerialized = `${JSON.stringify(canonicalIdentity, null, 2)}\n`;
  if (
    serialized !== canonicalSerialized ||
    canonicalIdentity.teamId !== expectedIdentity.teamId ||
    canonicalIdentity.createdAt !== expectedIdentity.createdAt ||
    expectedIdentity.identityChecksum === null ||
    createHash('sha256').update(serialized, 'utf8').digest('hex') !==
      expectedIdentity.identityChecksum
  ) {
    throw new Error('team-lifecycle-read-canonical-identity-mismatch');
  }
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === 'ENOENT'
  );
}

interface EntryIdentity {
  readonly device: number;
  readonly inode: number;
}

function entryIdentity(stat: fs.Stats): EntryIdentity {
  return Object.freeze({ device: stat.dev, inode: stat.ino });
}

function sameEntry(stat: fs.Stats, expected: EntryIdentity): boolean {
  return stat.dev === expected.device && stat.ino === expected.inode;
}

function directoryEntryIdentity(stat: fs.BigIntStats): DirectoryEntryIdentity {
  return Object.freeze({ device: stat.dev, inode: stat.ino });
}

function sameDirectoryEntry(stat: fs.BigIntStats, expected: DirectoryEntryIdentity): boolean {
  return stat.dev === expected.device && stat.ino === expected.inode;
}

function canonicalDirectoryInstanceFingerprint(
  canonicalPath: string,
  stat: fs.BigIntStats
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        schemaVersion: 1,
        canonicalPath,
        device: stat.dev.toString(),
        inode: stat.ino.toString(),
      }),
      'utf8'
    )
    .digest('hex');
}

function noFollowReadFlags(): number {
  if (!Number.isSafeInteger(NO_FOLLOW) || NO_FOLLOW <= 0) {
    throw new Error('team-lifecycle-read-no-follow-unavailable');
  }
  return fs.constants.O_RDONLY | NO_FOLLOW;
}

function stableFile(before: fs.Stats, after: fs.Stats): boolean {
  return (
    sameEntry(after, entryIdentity(before)) &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  );
}

function assertDirectChild(root: string, candidate: string, expectedRelativePath: string): void {
  const actualRelativePath = relative(root, candidate);
  if (
    actualRelativePath !== expectedRelativePath ||
    actualRelativePath.startsWith('..') ||
    isAbsolute(actualRelativePath)
  ) {
    throw new Error('team-lifecycle-read-root-containment-invalid');
  }
}

async function activeFileIo<TResult>(
  assertActive: () => void,
  operation: () => Promise<TResult>
): Promise<TResult> {
  assertActive();
  try {
    const value = await operation();
    assertActive();
    return value;
  } catch (error) {
    assertActive();
    throw error;
  }
}

async function closeActiveFileHandle(
  handle: fs.promises.FileHandle,
  assertActive: () => void
): Promise<void> {
  let firstError: unknown;
  try {
    assertActive();
  } catch (error) {
    firstError = error;
  }
  try {
    await handle.close();
  } catch (error) {
    firstError ??= error;
  }
  try {
    assertActive();
  } catch (error) {
    firstError ??= error;
  }
  if (firstError === undefined) return;
  if (firstError instanceof Error) throw firstError;
  throw new Error('team-lifecycle-read-file-handle-close-failed', { cause: firstError });
}

async function openActiveFileHandle(
  filePath: string,
  assertActive: () => void
): Promise<fs.promises.FileHandle> {
  assertActive();
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(filePath, noFollowReadFlags());
    assertActive();
    return handle;
  } catch (error) {
    if (handle) await closeActiveFileHandle(handle, assertActive);
    else assertActive();
    throw error;
  }
}

async function readActiveAtMost(
  handle: fs.promises.FileHandle,
  maxBytes: number,
  assertActive: () => void
): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(maxBytes + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await activeFileIo(assertActive, () =>
      handle.read(buffer, offset, buffer.length - offset, offset)
    );
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return buffer.subarray(0, offset);
}

async function readCanonicalDirectory(
  directoryPath: string,
  expectedParent: string | null,
  expectedName: string | null,
  assertActive: () => void
): Promise<{ readonly canonicalPath: string; readonly stat: fs.BigIntStats }> {
  const stat = await activeFileIo(assertActive, () =>
    fs.promises.lstat(directoryPath, { bigint: true })
  );
  const canonicalPath = await activeFileIo(assertActive, () => fs.promises.realpath(directoryPath));
  if (!stat.isDirectory() || stat.isSymbolicLink() || canonicalPath !== directoryPath) {
    throw new Error('team-lifecycle-read-directory-binding-invalid');
  }
  if (expectedParent !== null && expectedName !== null) {
    assertDirectChild(expectedParent, canonicalPath, expectedName);
  }
  return Object.freeze({ canonicalPath, stat });
}

export class ExplicitRootReadOnlyTeamSummarySource implements HostedReadOnlyTeamSummarySource {
  async readTeamSummary(input: {
    readonly claudeRoot: string;
    readonly identity: TeamIdentityRecord;
    readonly context: QueryContext;
    readonly assertActive: () => void;
  }): Promise<Readonly<Record<PropertyKey, unknown>> | null> {
    const identity = parseTeamIdentityRecord(input.identity);
    if (identity.state !== 'active') {
      throw new Error('team-lifecycle-read-canonical-identity-state-invalid');
    }
    const legacyTeamName = parseLegacyTeamKey(identity.legacyKey);

    try {
      const claudeRoot = await readCanonicalDirectory(
        input.claudeRoot,
        null,
        null,
        input.assertActive
      );
      const teamsRoot = await readCanonicalDirectory(
        join(claudeRoot.canonicalPath, 'teams'),
        claudeRoot.canonicalPath,
        'teams',
        input.assertActive
      );
      const teamRoot = await readCanonicalDirectory(
        join(teamsRoot.canonicalPath, legacyTeamName),
        teamsRoot.canonicalPath,
        legacyTeamName,
        input.assertActive
      );
      const identityName = 'team.identity.json';
      const identityPath = join(teamRoot.canonicalPath, identityName);
      const identityStat = await activeFileIo(input.assertActive, () =>
        fs.promises.lstat(identityPath)
      );
      const canonicalIdentityPath = await activeFileIo(input.assertActive, () =>
        fs.promises.realpath(identityPath)
      );
      assertDirectChild(teamRoot.canonicalPath, canonicalIdentityPath, identityName);
      if (
        !identityStat.isFile() ||
        identityStat.isSymbolicLink() ||
        canonicalIdentityPath !== identityPath ||
        identityStat.size < 1 ||
        identityStat.size > MAX_HOSTED_TEAM_IDENTITY_BYTES
      ) {
        throw new Error('team-lifecycle-read-canonical-identity-invalid');
      }

      const identityHandle = await openActiveFileHandle(identityPath, input.assertActive);
      let serializedIdentityBuffer: Buffer;
      try {
        const openedIdentityStat = await activeFileIo(input.assertActive, () =>
          identityHandle.stat()
        );
        if (!openedIdentityStat.isFile() || !stableFile(identityStat, openedIdentityStat)) {
          throw new Error('team-lifecycle-read-canonical-identity-replaced');
        }
        serializedIdentityBuffer = await readActiveAtMost(
          identityHandle,
          MAX_HOSTED_TEAM_IDENTITY_BYTES,
          input.assertActive
        );
        const afterIdentityReadStat = await activeFileIo(input.assertActive, () =>
          identityHandle.stat()
        );
        if (
          serializedIdentityBuffer.length > MAX_HOSTED_TEAM_IDENTITY_BYTES ||
          !stableFile(openedIdentityStat, afterIdentityReadStat) ||
          afterIdentityReadStat.size !== serializedIdentityBuffer.length
        ) {
          throw new Error('team-lifecycle-read-canonical-identity-changed');
        }
      } finally {
        await closeActiveFileHandle(identityHandle, input.assertActive);
      }
      assertCanonicalIdentityFile(serializedIdentityBuffer.toString('utf8'), identity);

      const fingerprintedTeamRoot = await readCanonicalDirectory(
        teamRoot.canonicalPath,
        teamsRoot.canonicalPath,
        legacyTeamName,
        input.assertActive
      );
      if (
        !sameDirectoryEntry(fingerprintedTeamRoot.stat, directoryEntryIdentity(teamRoot.stat)) ||
        canonicalDirectoryInstanceFingerprint(
          fingerprintedTeamRoot.canonicalPath,
          fingerprintedTeamRoot.stat
        ) !== identity.directoryFingerprint
      ) {
        throw new Error('team-lifecycle-read-directory-fingerprint-mismatch');
      }

      const configName = 'config.json';
      const configPath = join(teamRoot.canonicalPath, configName);
      const configStat = await activeFileIo(input.assertActive, () =>
        fs.promises.lstat(configPath)
      );
      const canonicalConfigPath = await activeFileIo(input.assertActive, () =>
        fs.promises.realpath(configPath)
      );
      assertDirectChild(teamRoot.canonicalPath, canonicalConfigPath, configName);
      if (
        !configStat.isFile() ||
        configStat.isSymbolicLink() ||
        canonicalConfigPath !== configPath ||
        configStat.size < 0 ||
        configStat.size > MAX_HOSTED_TEAM_CONFIG_BYTES
      ) {
        input.assertActive();
        return null;
      }

      const handle = await openActiveFileHandle(configPath, input.assertActive);
      let serializedBuffer: Buffer;
      try {
        const openedStat = await activeFileIo(input.assertActive, () => handle.stat());
        if (!openedStat.isFile() || !stableFile(configStat, openedStat)) {
          throw new Error('team-lifecycle-read-config-replaced');
        }
        serializedBuffer = await readActiveAtMost(
          handle,
          MAX_HOSTED_TEAM_CONFIG_BYTES,
          input.assertActive
        );
        const afterReadStat = await activeFileIo(input.assertActive, () => handle.stat());
        if (
          serializedBuffer.length > MAX_HOSTED_TEAM_CONFIG_BYTES ||
          !stableFile(openedStat, afterReadStat) ||
          afterReadStat.size !== serializedBuffer.length
        ) {
          throw new Error('team-lifecycle-read-config-changed');
        }
      } finally {
        await closeActiveFileHandle(handle, input.assertActive);
      }

      const claudeRootAfter = await readCanonicalDirectory(
        input.claudeRoot,
        null,
        null,
        input.assertActive
      );
      const teamsRootAfter = await readCanonicalDirectory(
        teamsRoot.canonicalPath,
        claudeRoot.canonicalPath,
        'teams',
        input.assertActive
      );
      const teamRootAfter = await readCanonicalDirectory(
        teamRoot.canonicalPath,
        teamsRoot.canonicalPath,
        legacyTeamName,
        input.assertActive
      );
      const identityAfter = await activeFileIo(input.assertActive, () =>
        fs.promises.lstat(identityPath)
      );
      const identityPathAfter = await activeFileIo(input.assertActive, () =>
        fs.promises.realpath(identityPath)
      );
      assertDirectChild(teamRoot.canonicalPath, identityPathAfter, identityName);
      const configAfter = await activeFileIo(input.assertActive, () =>
        fs.promises.lstat(configPath)
      );
      const configPathAfter = await activeFileIo(input.assertActive, () =>
        fs.promises.realpath(configPath)
      );
      assertDirectChild(teamRoot.canonicalPath, configPathAfter, configName);
      if (
        !sameDirectoryEntry(claudeRootAfter.stat, directoryEntryIdentity(claudeRoot.stat)) ||
        !sameDirectoryEntry(teamsRootAfter.stat, directoryEntryIdentity(teamsRoot.stat)) ||
        !sameDirectoryEntry(
          teamRootAfter.stat,
          directoryEntryIdentity(fingerprintedTeamRoot.stat)
        ) ||
        !stableFile(identityStat, identityAfter) ||
        identityPathAfter !== canonicalIdentityPath ||
        !stableFile(configStat, configAfter) ||
        configPathAfter !== canonicalConfigPath
      ) {
        throw new Error('team-lifecycle-read-config-binding-changed');
      }

      input.assertActive();
      const serialized = serializedBuffer.toString('utf8');
      const config = JSON.parse(serialized) as unknown;
      if (!isRecord(config) || config.name !== legacyTeamName) {
        input.assertActive();
        return null;
      }

      const summary: Record<string, unknown> = { teamName: legacyTeamName };
      if (typeof config.deletedAt === 'string') summary.deletedAt = config.deletedAt;
      if (config.pendingCreate === true) summary.pendingCreate = true;
      if (config.partialLaunchFailure === true) summary.partialLaunchFailure = true;
      input.assertActive();
      return Object.freeze(summary);
    } catch (error) {
      input.assertActive();
      if (isMissingPathError(error)) {
        input.assertActive();
        return null;
      }
      throw error;
    }
  }
}
