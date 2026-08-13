import { createHash } from 'node:crypto';
import {
  type BigIntStats,
  constants as fsConstants,
  type Dirent,
  lstatSync,
  realpathSync,
} from 'node:fs';
import { type FileHandle, lstat, open, opendir, realpath } from 'node:fs/promises';
import { isAbsolute, join, parse, resolve } from 'node:path';

import { hostedTaskBoardDirectoryFingerprint } from './hostedTaskBoardKanbanState';
import { assertHostedTaskBoardTeamIdentity } from './hostedTaskBoardRosterAuthority';

import type {
  HostedExternalWriterInventorySnapshot,
  HostedExternalWriterInventorySource,
  HostedExternalWriterRetiredTeamProof,
} from './hostedExternalWriterInventorySupervisor';
import type { RegisteredExternalFileDefinition } from '@features/external-writer-coordination/main';
import type { TeamIdentityRecord } from '@features/internal-storage/contracts';

const DEFAULT_MAX_FILES_PER_TEAM = 10_000;
const DEFAULT_MAX_FILES = 100_000;
const DEFAULT_MAX_IDENTITIES = 1_024;
const DEFAULT_MAX_DIRECTORY_ENTRIES_PER_TEAM = 20_000;
const DEFAULT_MAX_TASK_BYTES = 4 * 1024 * 1024;
const MAX_TEAM_IDENTITY_BYTES = 4 * 1024;
const TASK_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,239}\.json$/u;

export interface HostedExternalWriterTaskInventoryOptions {
  readonly admittedClaudeRoot: string;
  readonly teamIdentities: {
    captureExternalWriterTeamIdentities(input: {
      retirementCandidates: readonly TeamIdentityRecord['teamId'][];
    }): Promise<{
      active: readonly TeamIdentityRecord[];
      retiredCandidates: readonly HostedExternalWriterRetiredTeamProof[];
    }>;
    getTeamIdentity(teamId: TeamIdentityRecord['teamId']): Promise<TeamIdentityRecord | null>;
  };
  readonly maxFiles?: number;
  readonly maxFilesPerTeam?: number;
  readonly maxIdentities?: number;
  readonly maxDirectoryEntriesPerTeam?: number;
  readonly maxTaskBytes?: number;
}

interface AdmittedRootIdentity {
  readonly path: string;
  readonly device: bigint;
  readonly inode: bigint;
}

interface AdmittedDirectory {
  readonly path: string;
  readonly handle: FileHandle;
  readonly stat: BigIntStats;
}

interface AdmittedIdentityFile {
  readonly path: string;
  readonly handle: FileHandle;
  readonly stat: BigIntStats;
  readonly text: string;
}

function admitRoot(candidate: string): AdmittedRootIdentity {
  if (
    !isAbsolute(candidate) ||
    resolve(candidate) !== candidate ||
    candidate === parse(candidate).root
  ) {
    throw new TypeError('hosted-external-writer-root-not-admitted');
  }
  const stat = lstatSync(candidate, { bigint: true });
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    realpathSync.native(candidate) !== candidate
  ) {
    throw new TypeError('hosted-external-writer-root-not-admitted');
  }
  return Object.freeze({ path: candidate, device: stat.dev, inode: stat.ino });
}

function assertRootCurrent(root: AdmittedRootIdentity): void {
  const stat = lstatSync(root.path, { bigint: true });
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.dev !== root.device ||
    stat.ino !== root.inode ||
    realpathSync.native(root.path) !== root.path
  ) {
    throw new Error('hosted-external-writer-root-replaced');
  }
}

function sameDirectoryInstance(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileInstance(left: BigIntStats, right: BigIntStats): boolean {
  return (
    sameDirectoryInstance(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function noFollowFlags(directory: boolean): number {
  const noFollow = fsConstants.O_NOFOLLOW;
  if (!Number.isSafeInteger(noFollow) || noFollow <= 0) {
    throw new Error('hosted-external-writer-no-follow-unavailable');
  }
  return fsConstants.O_RDONLY | noFollow | (directory ? (fsConstants.O_DIRECTORY ?? 0) : 0);
}

async function openAdmittedDirectory(path: string): Promise<AdmittedDirectory> {
  const handle = await open(path, noFollowFlags(true));
  try {
    const [opened, named, canonicalPath] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(path, { bigint: true }),
      realpath(path),
    ]);
    if (
      !opened.isDirectory() ||
      opened.isSymbolicLink() ||
      !named.isDirectory() ||
      named.isSymbolicLink() ||
      canonicalPath !== path ||
      !sameDirectoryInstance(opened, named)
    ) {
      throw new Error('hosted-external-writer-directory-not-admitted');
    }
    return Object.freeze({ path, handle, stat: opened });
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function revalidateDirectory(directory: AdmittedDirectory): Promise<void> {
  const [opened, named, canonicalPath] = await Promise.all([
    directory.handle.stat({ bigint: true }),
    lstat(directory.path, { bigint: true }),
    realpath(directory.path),
  ]);
  if (
    !opened.isDirectory() ||
    opened.isSymbolicLink() ||
    !named.isDirectory() ||
    named.isSymbolicLink() ||
    canonicalPath !== directory.path ||
    !sameDirectoryInstance(directory.stat, opened) ||
    !sameDirectoryInstance(directory.stat, named)
  ) {
    throw new Error('hosted-external-writer-directory-replaced');
  }
}

async function openAdmittedIdentityFile(path: string): Promise<AdmittedIdentityFile> {
  const handle = await open(path, noFollowFlags(false));
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.size < 1n ||
      before.size > BigInt(MAX_TEAM_IDENTITY_BYTES)
    ) {
      throw new Error('hosted-external-writer-team-identity-invalid');
    }
    const buffer = Buffer.allocUnsafe(MAX_TEAM_IDENTITY_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const result = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    const [after, named, canonicalPath] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(path, { bigint: true }),
      realpath(path),
    ]);
    if (
      offset > MAX_TEAM_IDENTITY_BYTES ||
      after.size !== BigInt(offset) ||
      canonicalPath !== path ||
      !sameFileInstance(before, after) ||
      !sameFileInstance(before, named)
    ) {
      throw new Error('hosted-external-writer-team-identity-raced');
    }
    return Object.freeze({
      path,
      handle,
      stat: before,
      text: buffer.subarray(0, offset).toString('utf8'),
    });
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function revalidateIdentityFile(file: AdmittedIdentityFile): Promise<void> {
  const [opened, named, canonicalPath] = await Promise.all([
    file.handle.stat({ bigint: true }),
    lstat(file.path, { bigint: true }),
    realpath(file.path),
  ]);
  if (
    canonicalPath !== file.path ||
    !sameFileInstance(file.stat, opened) ||
    !sameFileInstance(file.stat, named)
  ) {
    throw new Error('hosted-external-writer-team-identity-replaced');
  }
}

function positiveBoundedInteger(value: number | undefined, fallback: number): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1) {
    throw new TypeError('hosted-external-writer-inventory-limit-invalid');
  }
  return selected;
}

function definitionKey(definition: RegisteredExternalFileDefinition): string {
  const { registration } = definition;
  return [
    registration.scope.teamId,
    registration.scope.featureKey,
    registration.fileKey,
    definition.rootPath,
    definition.filePath,
    definition.admittedRootIdentity?.device ?? '',
    definition.admittedRootIdentity?.inode ?? '',
    definition.admittedParentIdentity?.device ?? '',
    definition.admittedParentIdentity?.inode ?? '',
    registration.maxBytes,
    registration.attributionPolicy,
  ].join('\0');
}

function sameIdentityEvidence(
  expected: TeamIdentityRecord,
  current: TeamIdentityRecord | null
): boolean {
  return (
    current !== null &&
    current.state === 'active' &&
    current.teamId === expected.teamId &&
    current.legacyKey === expected.legacyKey &&
    current.directoryFingerprint === expected.directoryFingerprint &&
    current.identityChecksum === expected.identityChecksum &&
    current.createdAt === expected.createdAt
  );
}

/**
 * Enumerates only direct-child task JSON files for active durable identities.
 * The admitted root identity is revalidated before and after every inventory.
 */
export class HostedExternalWriterTaskInventory implements HostedExternalWriterInventorySource {
  private readonly root: AdmittedRootIdentity;
  private readonly maxFiles: number;
  private readonly maxFilesPerTeam: number;
  private readonly maxTaskBytes: number;
  private readonly maxIdentities: number;
  private readonly maxDirectoryEntriesPerTeam: number;

  constructor(private readonly options: HostedExternalWriterTaskInventoryOptions) {
    this.root = admitRoot(options.admittedClaudeRoot);
    this.maxFiles = positiveBoundedInteger(options.maxFiles, DEFAULT_MAX_FILES);
    this.maxFilesPerTeam = positiveBoundedInteger(
      options.maxFilesPerTeam,
      DEFAULT_MAX_FILES_PER_TEAM
    );
    this.maxTaskBytes = positiveBoundedInteger(options.maxTaskBytes, DEFAULT_MAX_TASK_BYTES);
    this.maxIdentities = positiveBoundedInteger(options.maxIdentities, DEFAULT_MAX_IDENTITIES);
    this.maxDirectoryEntriesPerTeam = positiveBoundedInteger(
      options.maxDirectoryEntriesPerTeam,
      DEFAULT_MAX_DIRECTORY_ENTRIES_PER_TEAM
    );
  }

  async capture(
    retirementCandidates: readonly TeamIdentityRecord['teamId'][] = []
  ): Promise<HostedExternalWriterInventorySnapshot> {
    assertRootCurrent(this.root);
    const identityInventory = await this.options.teamIdentities.captureExternalWriterTeamIdentities(
      { retirementCandidates }
    );
    const identities = [...identityInventory.active].sort((left, right) =>
      left.teamId.localeCompare(right.teamId)
    );
    if (identities.length > this.maxIdentities) {
      throw new Error('hosted-external-writer-identity-inventory-overflow');
    }
    const definitions: RegisteredExternalFileDefinition[] = [];
    const identityEvidence: string[] = [];
    for (const identity of identities) {
      const directories: AdmittedDirectory[] = [];
      let identityFile: AdmittedIdentityFile | null = null;
      try {
        const bind = async (expectedPath: string): Promise<AdmittedDirectory> => {
          const directory = await openAdmittedDirectory(expectedPath);
          directories.push(directory);
          return directory;
        };
        await bind(this.root.path);
        await bind(join(this.root.path, 'teams'));
        const teamDirectory = await bind(join(this.root.path, 'teams', identity.legacyKey));
        if (
          hostedTaskBoardDirectoryFingerprint({
            canonicalPath: teamDirectory.path,
            device: teamDirectory.stat.dev,
            inode: teamDirectory.stat.ino,
          }) !== identity.directoryFingerprint
        ) {
          throw new Error('hosted-external-writer-team-directory-fingerprint-mismatch');
        }
        identityFile = await openAdmittedIdentityFile(
          join(teamDirectory.path, 'team.identity.json')
        );
        assertHostedTaskBoardTeamIdentity(identityFile.text, identity);

        let tasksDirectory: AdmittedDirectory;
        try {
          await bind(join(this.root.path, 'tasks'));
          tasksDirectory = await bind(join(this.root.path, 'tasks', identity.legacyKey));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          for (const directory of directories) await revalidateDirectory(directory);
          await revalidateIdentityFile(identityFile);
          if (
            !sameIdentityEvidence(
              identity,
              await this.options.teamIdentities.getTeamIdentity(identity.teamId)
            )
          ) {
            throw new Error('hosted-external-writer-team-identity-changed');
          }
          identityEvidence.push(
            [
              identity.teamId,
              identity.legacyKey,
              identity.directoryFingerprint,
              identity.identityChecksum,
              'tasks-directory-absent',
            ].join('\0')
          );
          continue;
        }

        const taskEntries: Dirent[] = [];
        let inspectedEntries = 0;
        const reader = await opendir(tasksDirectory.path);
        try {
          for await (const entry of reader) {
            inspectedEntries += 1;
            if (inspectedEntries > this.maxDirectoryEntriesPerTeam) {
              throw new Error('hosted-external-writer-directory-inventory-overflow');
            }
            if (entry.name.endsWith('.json')) taskEntries.push(entry);
            if (taskEntries.length > this.maxFilesPerTeam) {
              throw new Error('hosted-external-writer-team-inventory-overflow');
            }
          }
        } finally {
          await reader.close().catch(() => undefined);
        }
        taskEntries.sort((left, right) => left.name.localeCompare(right.name));
        if (taskEntries.length > this.maxFilesPerTeam) {
          throw new Error('hosted-external-writer-team-inventory-overflow');
        }
        for (const entry of taskEntries) {
          if (!entry.isFile() || !TASK_FILE_NAME.test(entry.name)) {
            throw new Error('hosted-external-writer-task-entry-invalid');
          }
          const fileKey = entry.name.slice(0, -'.json'.length);
          definitions.push(
            Object.freeze({
              rootPath: this.root.path,
              filePath: join(tasksDirectory.path, entry.name),
              registration: Object.freeze({
                scope: Object.freeze({ teamId: identity.teamId, featureKey: 'tasks' }),
                fileKey,
                maxBytes: this.maxTaskBytes,
                attributionPolicy: 'external_file_only' as const,
              }),
              admittedRootIdentity: Object.freeze({
                device: this.root.device.toString(),
                inode: this.root.inode.toString(),
              }),
              admittedParentIdentity: Object.freeze({
                device: tasksDirectory.stat.dev.toString(),
                inode: tasksDirectory.stat.ino.toString(),
              }),
            })
          );
          if (definitions.length > this.maxFiles) {
            throw new Error('hosted-external-writer-inventory-overflow');
          }
        }
        for (const directory of directories) await revalidateDirectory(directory);
        await revalidateIdentityFile(identityFile);
        if (
          !sameIdentityEvidence(
            identity,
            await this.options.teamIdentities.getTeamIdentity(identity.teamId)
          )
        ) {
          throw new Error('hosted-external-writer-team-identity-changed');
        }
        identityEvidence.push(
          [
            identity.teamId,
            identity.legacyKey,
            identity.directoryFingerprint,
            identity.identityChecksum,
            tasksDirectory.stat.dev.toString(),
            tasksDirectory.stat.ino.toString(),
          ].join('\0')
        );
      } finally {
        await identityFile?.handle.close().catch(() => undefined);
        await Promise.all(
          directories.map((directory) => directory.handle.close().catch(() => undefined))
        );
      }
    }
    assertRootCurrent(this.root);
    const frozen = Object.freeze(definitions);
    const catalogToken = createHash('sha256')
      .update([...identityEvidence, ...frozen.map(definitionKey)].join('\n'))
      .digest('hex');
    const retiredTeams = Object.freeze([...identityInventory.retiredCandidates]);
    return Object.freeze({ catalogToken, definitions: frozen, retiredTeams });
  }
}
