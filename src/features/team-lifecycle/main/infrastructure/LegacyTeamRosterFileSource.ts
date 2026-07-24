import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  parseDeploymentId,
  parseLegacyMemberKey,
  parseTeamId,
  type TeamId,
} from '@shared/contracts/hosted';

import { TEAM_IDENTITY_FILE_NAME } from '../../core/application/ports/TeamIdentityPersistence';

import type {
  LegacyTeamRosterEvidenceReadResult,
  LegacyTeamRosterEvidenceSource,
} from '../../core/application';
import type { LegacyTeamRosterMemberEvidence } from '../../core/domain';
import type {
  TeamIdentityReadGateway,
  TeamIdentityRecord,
} from '@features/internal-storage/contracts';
import type { TeamProviderId } from '@shared/types';

const MAX_LEGACY_ROSTER_FILE_BYTES = 256 * 1024;
const MAX_TEAM_IDENTITY_FILE_BYTES = 4 * 1024;
const NO_FOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const LEAD_AGENT_TYPES = new Set(['lead', 'orchestrator', 'team-lead']);
const TEAM_PROVIDER_IDS = new Set<TeamProviderId>(['anthropic', 'codex', 'gemini', 'opencode']);

interface LegacyFileReadResult {
  readonly exists: boolean;
  readonly serialized?: string;
  readonly value?: unknown;
}

export type LegacyTeamRosterFileOpen = (
  targetPath: fs.PathLike,
  flags: string | number
) => Promise<fs.promises.FileHandle>;

class UnsafeTeamDirectoryError extends Error {
  constructor() {
    super('team-roster-directory-capability-changed');
    this.name = 'UnsafeTeamDirectoryError';
  }
}

export interface LegacyTeamRosterFileSourceDependencies {
  readonly teamsRootPath: string;
  readonly teamIdentityGateway: TeamIdentityReadGateway;
  readonly openFile?: LegacyTeamRosterFileOpen;
}

export class LegacyTeamRosterFileSource implements LegacyTeamRosterEvidenceSource {
  constructor(private readonly dependencies: LegacyTeamRosterFileSourceDependencies) {}

  async readLegacyTeamRosterEvidence(
    teamIdValue: TeamId
  ): Promise<LegacyTeamRosterEvidenceReadResult> {
    const teamId = parseTeamId(teamIdValue);
    const openFile = this.dependencies.openFile ?? openNodeFile;
    let identity;
    try {
      identity = await this.dependencies.teamIdentityGateway.getTeamIdentity(teamId);
    } catch {
      return Object.freeze({ status: 'blocked', reason: 'team_identity_unavailable' });
    }
    if (identity?.state !== 'active') {
      return Object.freeze({ status: 'blocked', reason: 'team_identity_unavailable' });
    }

    let directoryPath: string;
    try {
      directoryPath = await resolveSafeTeamDirectory(
        this.dependencies.teamsRootPath,
        identity.legacyKey,
        identity.directoryFingerprint
      );
    } catch {
      return Object.freeze({ status: 'blocked', reason: 'unsafe_team_directory' });
    }

    try {
      const identityFile = await readVerifiedDirectoryJsonFile(
        directoryPath,
        TEAM_IDENTITY_FILE_NAME,
        identity.directoryFingerprint,
        openFile,
        MAX_TEAM_IDENTITY_FILE_BYTES
      );
      assertCanonicalIdentityFile(identityFile, identity);
    } catch (error) {
      if (error instanceof UnsafeTeamDirectoryError) {
        return Object.freeze({ status: 'blocked', reason: 'unsafe_team_directory' });
      }
      return Object.freeze({ status: 'blocked', reason: 'team_identity_unavailable' });
    }

    let config: LegacyFileReadResult;
    let membersMeta: LegacyFileReadResult;
    try {
      config = await readVerifiedDirectoryJsonFile(
        directoryPath,
        'config.json',
        identity.directoryFingerprint,
        openFile
      );
      membersMeta = await readVerifiedDirectoryJsonFile(
        directoryPath,
        'members.meta.json',
        identity.directoryFingerprint,
        openFile
      );
    } catch (error) {
      if (error instanceof UnsafeTeamDirectoryError) {
        return Object.freeze({ status: 'blocked', reason: 'unsafe_team_directory' });
      }
      return Object.freeze({ status: 'blocked', reason: 'legacy_evidence_invalid' });
    }
    if (!config.exists && !membersMeta.exists) {
      return Object.freeze({ status: 'blocked', reason: 'legacy_evidence_unavailable' });
    }

    try {
      const members = [
        ...parseConfigMembers(config.value),
        ...parseMembersMetaMembers(membersMeta.value),
      ];
      return Object.freeze({
        status: 'available',
        evidence: Object.freeze({
          teamId,
          members: Object.freeze(members),
        }),
      });
    } catch {
      return Object.freeze({ status: 'blocked', reason: 'legacy_evidence_invalid' });
    }
  }
}

async function resolveSafeTeamDirectory(
  teamsRootPath: string,
  legacyKeyValue: string,
  expectedDirectoryFingerprint: string
): Promise<string> {
  const legacyKey = parseLegacyMemberKey(legacyKeyValue);
  if (!path.isAbsolute(teamsRootPath)) throw new Error('team-roster-root-not-absolute');
  const [rootStat, canonicalRoot] = await Promise.all([
    fs.promises.lstat(teamsRootPath, { bigint: true }),
    fs.promises.realpath(teamsRootPath),
  ]);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('team-roster-root-unsafe');
  }
  const candidate = path.join(teamsRootPath, legacyKey);
  const [candidateStat, canonicalCandidate] = await Promise.all([
    fs.promises.lstat(candidate, { bigint: true }),
    fs.promises.realpath(candidate),
  ]);
  if (
    !candidateStat.isDirectory() ||
    candidateStat.isSymbolicLink() ||
    path.dirname(canonicalCandidate) !== canonicalRoot ||
    directoryFingerprint(canonicalCandidate, candidateStat) !== expectedDirectoryFingerprint
  ) {
    throw new Error('team-roster-directory-unsafe');
  }
  return canonicalCandidate;
}

async function assertDirectoryFingerprint(
  canonicalDirectoryPath: string,
  expectedDirectoryFingerprint: string
): Promise<void> {
  const [stat, observedCanonicalPath] = await Promise.all([
    fs.promises.lstat(canonicalDirectoryPath, { bigint: true }),
    fs.promises.realpath(canonicalDirectoryPath),
  ]);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    observedCanonicalPath !== canonicalDirectoryPath ||
    directoryFingerprint(canonicalDirectoryPath, stat) !== expectedDirectoryFingerprint
  ) {
    throw new Error('team-roster-directory-fingerprint-mismatch');
  }
}

function directoryFingerprint(canonicalPath: string, stat: fs.BigIntStats): string {
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

async function readVerifiedDirectoryJsonFile(
  canonicalDirectoryPath: string,
  filename: string,
  expectedDirectoryFingerprint: string,
  openFile: LegacyTeamRosterFileOpen,
  maximumBytes = MAX_LEGACY_ROSTER_FILE_BYTES
): Promise<LegacyFileReadResult> {
  try {
    await assertDirectoryFingerprint(canonicalDirectoryPath, expectedDirectoryFingerprint);
  } catch {
    throw new UnsafeTeamDirectoryError();
  }

  let result: LegacyFileReadResult | undefined;
  let readFailed = false;
  let readError: unknown;
  try {
    result = await readBoundedJsonFile(canonicalDirectoryPath, filename, openFile, maximumBytes);
  } catch (error) {
    readFailed = true;
    readError = error;
  }

  try {
    await assertDirectoryFingerprint(canonicalDirectoryPath, expectedDirectoryFingerprint);
  } catch {
    throw new UnsafeTeamDirectoryError();
  }
  if (readFailed) {
    throw readError instanceof Error
      ? readError
      : new Error('team-roster-evidence-read-failed', { cause: readError });
  }
  if (result === undefined) throw new Error('team-roster-evidence-read-missing');
  return result;
}

async function readBoundedJsonFile(
  directoryPath: string,
  filename: string,
  openFile: LegacyTeamRosterFileOpen,
  maximumBytes = MAX_LEGACY_ROSTER_FILE_BYTES
): Promise<LegacyFileReadResult> {
  const targetPath = path.join(directoryPath, filename);
  let handle: fs.promises.FileHandle | null = null;
  try {
    const entry = await fs.promises.lstat(targetPath);
    if (
      !entry.isFile() ||
      entry.isSymbolicLink() ||
      entry.nlink !== 1 ||
      entry.size > maximumBytes
    ) {
      throw new Error('team-roster-evidence-file-unsafe');
    }
    handle = await openFile(targetPath, safeReadOpenFlags());
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1 ||
      before.size > maximumBytes ||
      before.dev !== entry.dev ||
      before.ino !== entry.ino
    ) {
      throw new Error('team-roster-evidence-file-unsafe');
    }
    const buffer = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (
      offset > maximumBytes ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      throw new Error('team-roster-evidence-file-changed');
    }
    const serialized = buffer.subarray(0, offset).toString('utf8');
    return { exists: true, serialized, value: JSON.parse(serialized) };
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      return { exists: false };
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function safeReadOpenFlags(): number {
  const nonBlockingFlag: unknown = fs.constants.O_NONBLOCK;
  if (typeof nonBlockingFlag === 'number') {
    return fs.constants.O_RDONLY | NO_FOLLOW | nonBlockingFlag;
  }
  if (process.platform === 'win32') {
    return fs.constants.O_RDONLY | NO_FOLLOW;
  }
  throw new Error('team-roster-nonblocking-open-unavailable');
}

const openNodeFile: LegacyTeamRosterFileOpen = (targetPath, flags) =>
  fs.promises.open(targetPath, flags);

function assertCanonicalIdentityFile(
  file: LegacyFileReadResult,
  identity: TeamIdentityRecord
): void {
  if (!file.exists || file.serialized === undefined) {
    throw new Error('team-roster-canonical-identity-missing');
  }
  const record = jsonRecord(file.value);
  const hasOriginDeploymentId = record.originDeploymentId !== undefined;
  const expectedKeys = hasOriginDeploymentId
    ? ['createdAt', 'originDeploymentId', 'schemaVersion', 'teamId']
    : ['createdAt', 'schemaVersion', 'teamId'];
  const ownKeys = Reflect.ownKeys(record);
  if (
    ownKeys.some((key) => typeof key !== 'string') ||
    ownKeys.length !== expectedKeys.length ||
    (ownKeys as string[])
      .sort((left, right) => left.localeCompare(right))
      .some((key, index) => key !== expectedKeys[index]) ||
    record.schemaVersion !== 1 ||
    !isCanonicalTimestamp(record.createdAt)
  ) {
    throw new Error('team-roster-canonical-identity-invalid');
  }
  const canonicalTeamId = parseTeamId(record.teamId);
  const canonicalCreatedAt = record.createdAt;
  const canonicalIdentity: Record<string, unknown> = {
    schemaVersion: 1,
    teamId: canonicalTeamId,
    createdAt: canonicalCreatedAt,
  };
  if (hasOriginDeploymentId) {
    canonicalIdentity.originDeploymentId = parseDeploymentId(record.originDeploymentId);
  }
  const canonicalSerialized = `${JSON.stringify(canonicalIdentity, null, 2)}\n`;
  const observedIdentityChecksum = createHash('sha256')
    .update(file.serialized, 'utf8')
    .digest('hex');
  const expectedIdentityChecksum: string | null = identity.identityChecksum;
  if (
    file.serialized !== canonicalSerialized ||
    canonicalTeamId !== identity.teamId ||
    canonicalCreatedAt !== identity.createdAt ||
    expectedIdentityChecksum === null ||
    observedIdentityChecksum !== expectedIdentityChecksum
  ) {
    throw new Error('team-roster-canonical-identity-mismatch');
  }
}

function isCanonicalTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function parseConfigMembers(value: unknown): LegacyTeamRosterMemberEvidence[] {
  if (value === undefined) return [];
  const record = jsonRecord(value);
  if (record.members === undefined) return [];
  if (!Array.isArray(record.members)) throw new TypeError('team-roster-config-members-invalid');
  return parseMembers(record.members, 'config');
}

function parseMembersMetaMembers(value: unknown): LegacyTeamRosterMemberEvidence[] {
  if (value === undefined) return [];
  const record = jsonRecord(value);
  if (record.version !== 1 || !Array.isArray(record.members)) {
    throw new TypeError('team-roster-members-meta-invalid');
  }
  return parseMembers(record.members, 'members_meta');
}

function parseMembers(
  values: readonly unknown[],
  source: LegacyTeamRosterMemberEvidence['source']
): LegacyTeamRosterMemberEvidence[] {
  const members: LegacyTeamRosterMemberEvidence[] = [];
  for (const [sourceOrdinal, value] of values.entries()) {
    if (!Object.hasOwn(values, sourceOrdinal)) {
      throw new TypeError('team-roster-legacy-members-sparse');
    }
    const record = jsonRecord(value);
    if (isNonRosterMember(record)) continue;
    const name = parseExactMemberName(record.name);
    const removedAt = record.removedAt;
    if (removedAt !== undefined && (typeof removedAt !== 'number' || !Number.isFinite(removedAt))) {
      throw new TypeError('team-roster-legacy-removed-at-invalid');
    }
    const providerId = reconcileProviderFields(record);
    const isolation = record.isolation;
    if (isolation !== undefined && isolation !== 'worktree') {
      throw new TypeError('team-roster-legacy-isolation-invalid');
    }
    members.push({
      source,
      sourceOrdinal,
      legacyMemberKey: name,
      state: removedAt === undefined ? 'active' : 'removed',
      providerId,
      model: parseOptionalText(record.model, 512),
      role: parseOptionalText(record.role, 4_096),
      workflow: parseOptionalText(record.workflow, 131_072),
      isolation: isolation ?? null,
    });
  }
  return members;
}

function isNonRosterMember(record: Record<string, unknown>): boolean {
  const name = typeof record.name === 'string' ? record.name.toLowerCase() : '';
  const agentType = typeof record.agentType === 'string' ? record.agentType : '';
  return name === 'team-lead' || name === 'user' || LEAD_AGENT_TYPES.has(agentType);
}

function parseExactMemberName(value: unknown): string {
  if (typeof value !== 'string' || value !== value.trim()) {
    throw new TypeError('team-roster-legacy-member-name-invalid');
  }
  return parseLegacyMemberKey(value);
}

function parseOptionalProvider(value: unknown): TeamProviderId | null {
  if (value === undefined) return null;
  if (!TEAM_PROVIDER_IDS.has(value as TeamProviderId)) {
    throw new TypeError('team-roster-legacy-provider-invalid');
  }
  return value as TeamProviderId;
}

function reconcileProviderFields(record: Record<string, unknown>): TeamProviderId | null {
  const providerId = parseOptionalProvider(record.providerId);
  const legacyProvider = parseOptionalProvider(record.provider);
  if (providerId !== null && legacyProvider !== null && providerId !== legacyProvider) {
    throw new TypeError('team-roster-legacy-provider-conflict');
  }
  return providerId ?? legacyProvider;
}

function parseOptionalText(value: unknown, maximumLength: number): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string') throw new TypeError('team-roster-legacy-text-invalid');
  const normalized = value.trim();
  if (normalized.length === 0) return null;
  if (normalized.length > maximumLength) throw new TypeError('team-roster-legacy-text-invalid');
  return normalized;
}

function jsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('team-roster-legacy-record-invalid');
  }
  return value as Record<string, unknown>;
}
