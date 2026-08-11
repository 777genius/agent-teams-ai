import { createHash } from 'node:crypto';
import { type BigIntStats, constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, normalize } from 'node:path';

import {
  parseLegacyTeamKey,
  parseTeamIdentityRecord,
  type TeamIdentityRecord,
} from '@features/internal-storage/contracts';

import type { InboxMessage } from '@shared/types';
import type { FileHandle } from 'node:fs/promises';

const MAXIMUM_INBOX_FILES = 128;
const MAXIMUM_INBOX_FILE_BYTES = 10 * 1024 * 1024;
const MAXIMUM_TOTAL_BYTES = 32 * 1024 * 1024;
const MAXIMUM_MESSAGES = 20_000;
const MAXIMUM_TEAM_IDENTITY_FILE_BYTES = 4 * 1024;
const MEMBER_FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/u;

export interface HostedInboxOwnerProvenance {
  readonly schemaVersion: 1;
  readonly domain: 'agent-teams.hosted-team-message.inbox-provenance/v1';
  readonly actorId: string;
  readonly deploymentId: string;
  readonly bootId: string;
  readonly workspaceId: string;
  readonly mountGeneration: number;
  readonly teamId: string;
  readonly messageId: string;
  readonly from: string;
  readonly to: string | null;
  readonly target: string;
  readonly textHash: string;
  readonly createdAtMs: number;
  readonly ownerAuthority: string;
  readonly ownerGeneration: number;
  readonly ownerSessionId: string;
  readonly ownerProof: string;
}

export interface DescriptorSafeHostedInboxMessage extends InboxMessage {
  readonly hostedOwnerProvenance?: unknown;
  /** Canonical inbox filename target, derived from the descriptor-safe directory entry. */
  readonly hostedInboxTarget?: string;
}

export interface DescriptorSafeHostedInboxCursor {
  readonly timestampMs: number;
  readonly messageId: string;
  readonly messageIdentity: string;
}

export interface DescriptorSafeHostedInboxWindow {
  readonly messages: readonly DescriptorSafeHostedInboxMessage[];
  readonly truncated: boolean;
  readonly sourceRevision: string;
  readonly sourceMessageCount: number;
}

export interface DescriptorSafeHostedInboxReaderOptions {
  readonly teamsRoot: string;
  readonly beforeFinalValidation?: () => void | Promise<void>;
}

function descriptorPath(handle: FileHandle, child?: string): string {
  const root = `/proc/self/fd/${handle.fd}`;
  return child === undefined ? root : `${root}/${child}`;
}

function assertDirectory(stat: BigIntStats): void {
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.nlink < 2n ||
    Number(stat.mode & 0o022n) !== 0
  ) {
    throw new Error('hosted-inbox-directory-invalid');
  }
}

function assertFile(stat: BigIntStats, maximumBytes = MAXIMUM_INBOX_FILE_BYTES): void {
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1n ||
    stat.size < 1n ||
    stat.size > BigInt(maximumBytes) ||
    Number(stat.mode & 0o022n) !== 0
  ) {
    throw new Error('hosted-inbox-file-invalid');
  }
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return (
    sameIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function assertMembership(
  handle: FileHandle,
  path: string,
  directory: boolean
): Promise<void> {
  const [descriptor, current] = await Promise.all([
    handle.stat({ bigint: true }),
    lstat(path, { bigint: true }),
  ]);
  if (current.isSymbolicLink() || !sameIdentity(descriptor, current)) {
    throw new Error('hosted-inbox-path-substituted');
  }
  if (directory) assertDirectory(descriptor);
  else assertFile(descriptor);
}

async function openDirectory(path: string): Promise<FileHandle> {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    assertDirectory(await handle.stat({ bigint: true }));
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

function directoryFingerprint(canonicalPath: string, stat: BigIntStats): string {
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

function assertTeamIdentityAnchor(serialized: string, expected: TeamIdentityRecord): void {
  const value: unknown = JSON.parse(serialized);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('hosted-inbox-team-identity-invalid');
  }
  const record = value as Record<PropertyKey, unknown>;
  const hasOriginDeploymentId = record.originDeploymentId !== undefined;
  const expectedKeys = hasOriginDeploymentId
    ? ['createdAt', 'originDeploymentId', 'schemaVersion', 'teamId']
    : ['createdAt', 'schemaVersion', 'teamId'];
  const keys = Reflect.ownKeys(record).sort();
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index]) ||
    record.schemaVersion !== 1 ||
    record.teamId !== expected.teamId ||
    typeof record.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(record.createdAt)) ||
    new Date(record.createdAt).toISOString() !== record.createdAt ||
    record.createdAt !== expected.createdAt ||
    (hasOriginDeploymentId && typeof record.originDeploymentId !== 'string') ||
    expected.identityChecksum === null ||
    createHash('sha256').update(serialized, 'utf8').digest('hex') !== expected.identityChecksum
  ) {
    throw new Error('hosted-inbox-team-identity-invalid');
  }
  const canonical = {
    schemaVersion: 1,
    teamId: expected.teamId,
    createdAt: expected.createdAt,
    ...(hasOriginDeploymentId ? { originDeploymentId: record.originDeploymentId } : {}),
  };
  if (`${JSON.stringify(canonical, null, 2)}\n` !== serialized) {
    throw new Error('hosted-inbox-team-identity-invalid');
  }
}

function hasErrnoCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && Reflect.get(error, 'code') === code;
}

async function assertPathMissing(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (hasErrnoCode(error, 'ENOENT')) return;
    throw error;
  }
  throw new Error('hosted-inbox-path-appeared');
}

function cursorIdentity(message: DescriptorSafeHostedInboxMessage): string {
  return JSON.stringify([message.messageId ?? '', message.from, message.to ?? '']);
}

function compareNewestFirst(
  left: DescriptorSafeHostedInboxMessage,
  right: DescriptorSafeHostedInboxMessage
): number {
  const leftMs = Date.parse(left.timestamp);
  const rightMs = Date.parse(right.timestamp);
  if (Number.isFinite(leftMs) && Number.isFinite(rightMs) && leftMs !== rightMs) {
    return rightMs - leftMs;
  }
  return cursorIdentity(left).localeCompare(cursorIdentity(right));
}

function isAfterCursor(
  message: DescriptorSafeHostedInboxMessage,
  cursor: DescriptorSafeHostedInboxCursor | null
): boolean {
  if (cursor === null) return true;
  const timestampMs = Date.parse(message.timestamp);
  if (timestampMs < cursor.timestampMs) return true;
  if (timestampMs > cursor.timestampMs) return false;
  return cursorIdentity(message).localeCompare(cursor.messageIdentity) > 0;
}

function normalizeMessage(
  value: unknown,
  member: string,
  ordinal: number
): DescriptorSafeHostedInboxMessage | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    typeof row.from !== 'string' ||
    typeof row.text !== 'string' ||
    typeof row.timestamp !== 'string' ||
    !Number.isFinite(Date.parse(row.timestamp))
  ) {
    return null;
  }
  const to = typeof row.to === 'string' ? row.to : member;
  const messageId =
    typeof row.messageId === 'string' && row.messageId.trim().length > 0
      ? row.messageId.trim()
      : `raw_${createHash('sha256')
          .update(JSON.stringify([row.from, to, row.text, row.timestamp, ordinal]), 'utf8')
          .digest('hex')}`;
  return Object.freeze({
    ...(row as unknown as InboxMessage),
    from: row.from,
    to,
    text: row.text,
    timestamp: row.timestamp,
    read: typeof row.read === 'boolean' ? row.read : false,
    messageId,
    hostedInboxTarget: member,
    ...(Object.hasOwn(row, 'hostedOwnerProvenance')
      ? { hostedOwnerProvenance: row.hostedOwnerProvenance }
      : {}),
  });
}

interface OpenPinnedFile {
  readonly handle: FileHandle;
  readonly originalPath: string;
  readonly stat: BigIntStats;
  readonly text: string;
  readonly maximumBytes: number;
}

async function openPinnedFile(
  parent: FileHandle,
  originalPath: string,
  name: string,
  maximumBytes = MAXIMUM_INBOX_FILE_BYTES
): Promise<OpenPinnedFile> {
  const handle = await open(
    descriptorPath(parent, name),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    const before = await handle.stat({ bigint: true });
    assertFile(before, maximumBytes);
    const buffer = Buffer.alloc(Number(before.size) + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
    const after = await handle.stat({ bigint: true });
    assertFile(after, maximumBytes);
    if (bytesRead !== Number(before.size) || !sameFileSnapshot(before, after)) {
      throw new Error('hosted-inbox-file-raced');
    }
    await assertMembership(handle, originalPath, false);
    return Object.freeze({
      handle,
      originalPath,
      text: buffer.toString('utf8', 0, bytesRead),
      stat: after,
      maximumBytes,
    });
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function assertPinnedFileUnchanged(file: OpenPinnedFile): Promise<void> {
  const current = await file.handle.stat({ bigint: true });
  assertFile(current, file.maximumBytes);
  if (!sameFileSnapshot(file.stat, current)) throw new Error('hosted-inbox-file-raced');
  await assertMembership(file.handle, file.originalPath, false);
}

async function readPinnedFile(
  parent: FileHandle,
  originalPath: string,
  name: string
): Promise<Readonly<{ text: string; stat: BigIntStats }>> {
  const file = await openPinnedFile(parent, originalPath, name);
  try {
    return Object.freeze({ text: file.text, stat: file.stat });
  } finally {
    await file.handle.close();
  }
}

/** Linux-hosted descriptor-relative inbox reader. Any unsupported or raced layout fails closed. */
export class DescriptorSafeHostedInboxReader {
  private readonly teamsRoot: string;

  constructor(private readonly options: DescriptorSafeHostedInboxReaderOptions) {
    if (
      typeof options.teamsRoot !== 'string' ||
      !isAbsolute(options.teamsRoot) ||
      normalize(options.teamsRoot) !== options.teamsRoot ||
      options.teamsRoot.includes('\0')
    ) {
      throw new TypeError('hosted-inbox-root-invalid');
    }
    this.teamsRoot = options.teamsRoot;
  }

  async getMessagesWindow(
    identityValue: TeamIdentityRecord,
    options: { readonly cursor?: DescriptorSafeHostedInboxCursor | null; readonly limit: number }
  ): Promise<DescriptorSafeHostedInboxWindow> {
    const identity = parseTeamIdentityRecord(identityValue);
    if (
      identity.state !== 'active' ||
      identity.workspaceBinding === null ||
      identity.identityChecksum === null
    ) {
      throw new TypeError('hosted-inbox-team-identity-inactive');
    }
    const legacyKey = parseLegacyTeamKey(identity.legacyKey);
    if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 1_280) {
      throw new TypeError('hosted-inbox-limit-invalid');
    }
    const teamPath = join(this.teamsRoot, legacyKey);
    const inboxesPath = join(teamPath, 'inboxes');
    const root = await openDirectory(this.teamsRoot);
    try {
      await assertMembership(root, this.teamsRoot, true);
      if ((await realpath(descriptorPath(root))) !== this.teamsRoot) {
        throw new Error('hosted-inbox-root-path-mismatch');
      }
      const team = await openDirectory(descriptorPath(root, legacyKey));
      try {
        await assertMembership(team, teamPath, true);
        const canonicalTeamPath = await realpath(descriptorPath(team));
        if (canonicalTeamPath !== teamPath) {
          throw new Error('hosted-inbox-team-path-mismatch');
        }
        const teamStat = await team.stat({ bigint: true });
        assertDirectory(teamStat);
        if (directoryFingerprint(canonicalTeamPath, teamStat) !== identity.directoryFingerprint) {
          throw new Error('hosted-inbox-team-directory-fingerprint-mismatch');
        }
        const identityPath = join(teamPath, 'team.identity.json');
        const identityFile = await openPinnedFile(
          team,
          identityPath,
          'team.identity.json',
          MAXIMUM_TEAM_IDENTITY_FILE_BYTES
        );
        try {
          assertTeamIdentityAnchor(identityFile.text, identity);
          let inboxes: FileHandle;
          try {
            inboxes = await openDirectory(descriptorPath(team, 'inboxes'));
          } catch (error) {
            if (!hasErrnoCode(error, 'ENOENT')) throw error;
            await assertPathMissing(inboxesPath);
            await this.options.beforeFinalValidation?.();
            await Promise.all([
              assertPathMissing(inboxesPath),
              assertPinnedFileUnchanged(identityFile),
              assertMembership(team, teamPath, true),
              assertMembership(root, this.teamsRoot, true),
            ]);
            return Object.freeze({
              messages: Object.freeze([]),
              truncated: false,
              sourceRevision: createHash('sha256').digest('hex'),
              sourceMessageCount: 0,
            });
          }
          try {
            await assertMembership(inboxes, inboxesPath, true);
            const entries = await readdir(descriptorPath(inboxes), { withFileTypes: true });
            if (entries.length > MAXIMUM_INBOX_FILES) {
              throw new Error('hosted-inbox-file-count-exceeded');
            }
            const files = entries
              .filter((entry) => !entry.name.startsWith('.'))
              .sort((left, right) => left.name.localeCompare(right.name));
            const revision = createHash('sha256');
            const messages: DescriptorSafeHostedInboxMessage[] = [];
            let sourceMessageCount = 0;
            let totalBytes = 0;
            for (const entry of files) {
              if (
                !MEMBER_FILE_PATTERN.test(entry.name) ||
                !entry.isFile() ||
                entry.isSymbolicLink()
              ) {
                throw new Error('hosted-inbox-entry-invalid');
              }
              const member = entry.name.slice(0, -'.json'.length);
              const originalPath = join(inboxesPath, entry.name);
              const file = await readPinnedFile(inboxes, originalPath, entry.name);
              totalBytes += Number(file.stat.size);
              if (totalBytes > MAXIMUM_TOTAL_BYTES) {
                throw new Error('hosted-inbox-total-bytes-exceeded');
              }
              const parsed: unknown = JSON.parse(file.text);
              if (!Array.isArray(parsed)) throw new Error('hosted-inbox-json-invalid');
              revision.update(
                `${entry.name}:${file.stat.dev}:${file.stat.ino}:${file.stat.size}:${file.stat.mtimeNs}:${file.stat.ctimeNs}\n`
              );
              for (let index = 0; index < parsed.length; index += 1) {
                if (!Object.hasOwn(parsed, index)) throw new Error('hosted-inbox-json-invalid');
                const message = normalizeMessage(parsed[index], member, index);
                if (message === null) continue;
                sourceMessageCount += 1;
                if (sourceMessageCount > MAXIMUM_MESSAGES) {
                  throw new Error('hosted-inbox-message-count-exceeded');
                }
                revision.update(JSON.stringify(message));
                revision.update('\n');
                if (isAfterCursor(message, options.cursor ?? null)) messages.push(message);
              }
            }
            messages.sort(compareNewestFirst);
            await this.options.beforeFinalValidation?.();
            await Promise.all([
              assertPinnedFileUnchanged(identityFile),
              assertMembership(inboxes, inboxesPath, true),
              assertMembership(team, teamPath, true),
              assertMembership(root, this.teamsRoot, true),
            ]);
            return Object.freeze({
              messages: Object.freeze(messages.slice(0, options.limit)),
              truncated: messages.length > options.limit,
              sourceRevision: revision.digest('hex'),
              sourceMessageCount,
            });
          } finally {
            await inboxes.close();
          }
        } finally {
          await identityFile.handle.close();
        }
      } finally {
        await team.close();
      }
    } finally {
      await root.close();
    }
  }
}
