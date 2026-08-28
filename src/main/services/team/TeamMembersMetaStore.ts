import { syncDirectoryDurably } from '@main/utils/atomicWrite';
import { FileReadTimeoutError, readFileUtf8WithTimeout } from '@main/utils/fsRead';
import { getTeamsBasePath } from '@main/utils/pathDecoder';
import { isTeamEffortLevel } from '@shared/utils/effortLevels';
import {
  isLegacyCodexProviderBackendId,
  isTeamProviderBackendId,
  migrateProviderBackendId,
  normalizePersistedProviderBackendId,
} from '@shared/utils/providerBackend';
import { normalizeTeamMemberMcpPolicy } from '@shared/utils/teamMemberMcpPolicy';
import { createCliAutoSuffixNameGuard } from '@shared/utils/teamMemberName';
import { normalizeTeamMemberRuntimeSelectionProvenance } from '@shared/utils/teamMemberRuntimeSelectionProvenance';
import { normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';
import { AsyncLocalStorage } from 'async_hooks';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { RosterLaunchKnownNoStartError } from './provisioning/TeamProvisioningRosterLaunchOutcome';
import { atomicWriteAsync } from './atomicWrite';
import {
  canonicalRosterRawFromStore,
  parseStrictCurrentRosterMembers,
} from './buildCanonicalRosterAuthorizationRaw';
import { withFileLock } from './fileLock';
import { reconcileRosterAdmissionIndexUnderLock } from './reconcileRosterAdmissionIndex';
import { TeamRosterAuthorizationLedger } from './TeamRosterAuthorizationLedger';

import type { AuthoritativeModelExecutionInvocationLease } from './TeamLaunchExecutionProofAuthority';
import type { ReplaceMembersRequest, TeamMember } from '@shared/types';

export interface TeamMembersMetaFile {
  version: 1 | 2;
  providerBackendId?: string;
  members: TeamMember[];
}

const MAX_META_FILE_BYTES = 256 * 1024;
const rosterLocks = new Map<string, Promise<void>>();
interface RosterReservationContext {
  transactionId: string;
  beforeInvocation?: () => Promise<AuthoritativeModelExecutionInvocationLease>;
  authorityLease?: AuthoritativeModelExecutionInvocationLease;
  boundaryClaimed: boolean;
  invocationStarted: boolean;
}

export interface RosterLaunchInvocationLease {
  invoke<T>(invocation: () => T): T;
}

const rosterReservationContext = new AsyncLocalStorage<RosterReservationContext>();

export function runWithRosterReservation<T>(
  transactionId: string,
  operation: () => Promise<T>,
  beforeInvocation?: () => Promise<AuthoritativeModelExecutionInvocationLease>
): Promise<T> {
  const context: RosterReservationContext = {
    transactionId,
    beforeInvocation,
    boundaryClaimed: false,
    invocationStarted: false,
  };
  return rosterReservationContext.run(context, async () => {
    try {
      return await operation();
    } finally {
      context.authorityLease?.close();
    }
  });
}

/** Persist production dispatch exactly at the irreversible adapter/spawn boundary. */
export async function crossRosterLaunchInvocationBoundary(): Promise<RosterLaunchInvocationLease> {
  const context = rosterReservationContext.getStore();
  if (!context) return { invoke: (invocation) => invocation() };
  if (context.boundaryClaimed || context.invocationStarted) {
    throw new RosterLaunchKnownNoStartError('Launch invocation authority was already claimed');
  }
  context.boundaryClaimed = true;
  let authorityLease: AuthoritativeModelExecutionInvocationLease;
  try {
    if (!context.beforeInvocation) {
      throw new RosterLaunchKnownNoStartError('Launch invocation authority is unavailable');
    }
    authorityLease = await context.beforeInvocation();
    context.authorityLease = authorityLease;
    if (!authorityLease.isCurrent()) {
      authorityLease.close();
      throw new RosterLaunchKnownNoStartError(
        'Launch authorization expired or was invalidated before invocation'
      );
    }
  } catch (error) {
    context.boundaryClaimed = false;
    throw error;
  }
  return {
    invoke<T>(invocation: () => T): T {
      if (context.invocationStarted) {
        authorityLease.close();
        throw new RosterLaunchKnownNoStartError('Launch invocation authority was already used');
      }
      const started = authorityLease.beginInvocation(() => {
        context.invocationStarted = true;
        return invocation();
      });
      if (!started.started) {
        throw new RosterLaunchKnownNoStartError(
          'Launch authorization expired or was invalidated before invocation'
        );
      }
      return started.value;
    },
  };
}

export interface DurableTeamMembersMetaSnapshot {
  raw: string | null;
  fingerprint: string;
}

export class RosterCompareAndSwapConflictError extends Error {
  constructor(readonly currentFingerprint: string) {
    super('Roster changed during compare-and-swap');
    this.name = 'RosterCompareAndSwapConflictError';
  }
}

export class UnsupportedTeamMembersMetaVersionError extends Error {
  constructor(readonly version: unknown) {
    super(`Unsupported members.meta.json version: ${String(version)}`);
    this.name = 'UnsupportedTeamMembersMetaVersionError';
  }
}

export interface TeamMembersWriteOptions {
  providerBackendId?: string;
  /** Only the owning roster transaction may mutate while its reservation is active. */
  reservationTransactionId?: string;
}

const ACTIVE_ROSTER_TRANSACTION_STATUSES = new Set([
  'pending',
  'applied',
  'prepared',
  'launch-unknown',
]);

export function fingerprintDurableTeamMembersMetaRaw(raw: string | null): string {
  return createHash('sha256')
    .update(raw === null ? 'missing\0' : `present\0${raw}`)
    .digest('hex');
}

function normalizeOptionalBackendId(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function normalizeRootProviderBackendId(
  value: unknown,
  source: 'legacy-storage' | 'explicit-selection'
): string | undefined {
  const normalized = normalizeOptionalBackendId(value);
  if (!isTeamProviderBackendId(normalized)) return undefined;
  if (source === 'legacy-storage' && isLegacyCodexProviderBackendId(normalized)) {
    return migrateProviderBackendId('codex', normalized, source);
  }
  return normalized;
}

function normalizeFastMode(value: unknown): TeamMember['fastMode'] {
  return value === 'inherit' || value === 'on' || value === 'off' ? value : undefined;
}

async function assertMembersMetaMutableForMutation(metaPath: string): Promise<void> {
  let raw: string;
  try {
    raw = await fs.promises.readFile(metaPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error('Existing members.meta.json is malformed', { cause: error });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Existing members.meta.json is malformed');
  }
  const record = parsed as Record<string, unknown>;
  if (record.version !== undefined && record.version !== 1 && record.version !== 2) {
    throw new UnsupportedTeamMembersMetaVersionError(record.version);
  }
  if (!Array.isArray(record.members)) {
    throw new Error('Existing members.meta.json is malformed');
  }
  if (record.version === 2 && !parseStrictCurrentRosterMembers(record.members)) {
    throw new Error('Existing members.meta.json current roster is malformed');
  }
}

function normalizeMember(
  member: TeamMember,
  source: 'legacy-storage' | 'explicit-selection'
): TeamMember | null {
  const trimmedName = member.name?.trim();
  if (!trimmedName) {
    return null;
  }
  const providerId = normalizeOptionalTeamProviderId(member.providerId);
  return {
    name: trimmedName,
    role: typeof member.role === 'string' ? member.role.trim() || undefined : undefined,
    workflow: typeof member.workflow === 'string' ? member.workflow.trim() || undefined : undefined,
    isolation: member.isolation === 'worktree' ? ('worktree' as const) : undefined,
    providerId,
    providerBackendId: normalizePersistedProviderBackendId(
      providerId,
      normalizeOptionalBackendId(member.providerBackendId),
      source === 'explicit-selection' ? 'current-version' : 'legacy-unversioned'
    ),
    model: typeof member.model === 'string' ? member.model.trim() || undefined : undefined,
    effort: isTeamEffortLevel(member.effort) ? member.effort : undefined,
    runtimeSelectionProvenance: normalizeTeamMemberRuntimeSelectionProvenance(
      member.runtimeSelectionProvenance
    ),
    fastMode: normalizeFastMode(member.fastMode),
    mcpPolicy: normalizeTeamMemberMcpPolicy(member.mcpPolicy),
    agentType:
      typeof member.agentType === 'string' ? member.agentType.trim() || undefined : undefined,
    color: typeof member.color === 'string' ? member.color.trim() || undefined : undefined,
    joinedAt: typeof member.joinedAt === 'number' ? member.joinedAt : undefined,
    agentId: typeof member.agentId === 'string' ? member.agentId : undefined,
    cwd: typeof member.cwd === 'string' ? member.cwd.trim() || undefined : undefined,
    removedAt: typeof member.removedAt === 'number' ? member.removedAt : undefined,
  };
}

function buildActiveNameGuard(membersByName: Map<string, TeamMember>): (name: string) => boolean {
  const activeNames = Array.from(membersByName.values())
    .filter((member) => !member.removedAt)
    .map((member) => member.name);
  return createCliAutoSuffixNameGuard(activeNames);
}

export class TeamMembersMetaStore {
  constructor(private readonly teamsBasePath: string = getTeamsBasePath()) {}

  normalizeRootBackend(
    value: unknown,
    source: 'legacy-storage' | 'explicit-selection'
  ): string | undefined {
    return normalizeRootProviderBackendId(value, source);
  }

  canonicalRaw(
    priorRaw: string | null,
    existing: readonly TeamMember[],
    requested: ReplaceMembersRequest['members'],
    replacement: readonly TeamMember[]
  ): string {
    return canonicalRosterRawFromStore(priorRaw, existing, requested, replacement, this);
  }
  private getMetaPath(teamName: string): string {
    return path.join(this.teamsBasePath, teamName, 'members.meta.json');
  }

  async assertMutable(teamName: string): Promise<void> {
    await assertMembersMetaMutableForMutation(this.getMetaPath(teamName));
  }

  async getMeta(teamName: string): Promise<TeamMembersMetaFile | null> {
    const metaPath = this.getMetaPath(teamName);
    try {
      const stat = await fs.promises.stat(metaPath);
      if (!stat.isFile()) {
        return null;
      }
      if (stat.isFile() && stat.size > MAX_META_FILE_BYTES) {
        return null;
      }
    } catch {
      // ignore - readFile below will handle ENOENT and throw on other errors
    }
    let raw: string;
    try {
      raw = await readFileUtf8WithTimeout(metaPath, 5_000);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      if (error instanceof FileReadTimeoutError) {
        return null;
      }
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }

    const file = parsed as Partial<TeamMembersMetaFile>;
    if (!Array.isArray(file.members)) {
      return null;
    }
    if (file.version !== undefined && file.version !== 1 && file.version !== 2) {
      throw new UnsupportedTeamMembersMetaVersionError(file.version);
    }
    const version = file.version === 2 ? 2 : 1;
    const migrationSource = version === 2 ? 'explicit-selection' : 'legacy-storage';

    const deduped = new Map<string, TeamMember>();
    for (const item of file.members) {
      if (!item || typeof item !== 'object') {
        continue;
      }
      const normalized = normalizeMember(item, migrationSource);
      if (!normalized) {
        continue;
      }
      deduped.set(normalized.name, normalized);
    }

    // Defense: drop CLI auto-suffixed duplicates (alice-2) only when the base
    // name is still active. Removed base members must not hide active suffixed
    // teammates after live mutation / rollback flows.
    const allNames = Array.from(deduped.keys());
    const keepName = buildActiveNameGuard(deduped);
    for (const name of allNames) {
      if (!keepName(name)) {
        deduped.delete(name);
      }
    }

    return {
      version,
      providerBackendId: normalizeRootProviderBackendId(file.providerBackendId, migrationSource),
      members: Array.from(deduped.values()).sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  async getMembers(teamName: string): Promise<TeamMember[]> {
    return (await this.getMeta(teamName))?.members ?? [];
  }

  async withRosterLock<T>(teamName: string, operation: () => Promise<T>): Promise<T> {
    const lockKey = this.getMetaPath(teamName);
    const previous = rosterLocks.get(lockKey) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    rosterLocks.set(lockKey, queued);
    await previous;
    try {
      // The promise queue protects one Electron main instance. The file lock is
      // the serialization authority shared by every app process/worktree.
      return await withFileLock(
        { authorityRoot: this.teamsBasePath, targetPath: `${lockKey}.roster-cas` },
        operation
      );
    } finally {
      release();
      if (rosterLocks.get(lockKey) === queued) rosterLocks.delete(lockKey);
    }
  }

  async readDurableSnapshotUnderLock(teamName: string): Promise<DurableTeamMembersMetaSnapshot> {
    let raw: string | null;
    try {
      raw = await fs.promises.readFile(this.getMetaPath(teamName), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      raw = null;
    }
    return { raw, fingerprint: fingerprintDurableTeamMembersMetaRaw(raw) };
  }

  async restoreDurableSnapshotUnderLock(
    teamName: string,
    snapshot: DurableTeamMembersMetaSnapshot,
    reservationTransactionId?: string
  ): Promise<void> {
    await this.assertMutable(teamName);
    await this.assertRosterMutationUnreservedUnderLock(teamName, reservationTransactionId);
    if (snapshot.raw === null) {
      await fs.promises.unlink(this.getMetaPath(teamName)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
      await syncDirectoryDurably(path.dirname(this.getMetaPath(teamName)));
      return;
    }
    await atomicWriteAsync(this.getMetaPath(teamName), snapshot.raw, {
      durability: 'strict',
      syncDirectory: true,
    });
  }

  async restoreDurableSnapshotCasUnderLock(
    teamName: string,
    snapshot: DurableTeamMembersMetaSnapshot,
    expectedFingerprint: string,
    reservationTransactionId: string
  ): Promise<void> {
    await this.assertMutable(teamName);
    await this.assertRosterMutationUnreservedUnderLock(teamName, reservationTransactionId);
    await this.assertCurrentFingerprint(teamName, expectedFingerprint);
    if (snapshot.raw === null) {
      await this.assertCurrentFingerprint(teamName, expectedFingerprint);
      await fs.promises.unlink(this.getMetaPath(teamName));
      await syncDirectoryDurably(path.dirname(this.getMetaPath(teamName)));
      return;
    }
    await atomicWriteAsync(this.getMetaPath(teamName), snapshot.raw, {
      durability: 'strict',
      syncDirectory: true,
      beforeCommit: () => this.assertCurrentFingerprint(teamName, expectedFingerprint),
    });
  }

  async writeMembers(
    teamName: string,
    members: TeamMember[],
    options?: TeamMembersWriteOptions
  ): Promise<void> {
    await this.withRosterLock(teamName, () =>
      this.writeMembersUnderLock(teamName, members, options)
    );
  }

  async writeMembersUnderLock(
    teamName: string,
    members: TeamMember[],
    options?: TeamMembersWriteOptions
  ): Promise<void> {
    await this.assertMutable(teamName);
    const existing = await this.getMeta(teamName);
    const hasExplicitRootBackend = Object.prototype.hasOwnProperty.call(
      options ?? {},
      'providerBackendId'
    );
    const providerBackendId = hasExplicitRootBackend
      ? normalizeRootProviderBackendId(options?.providerBackendId, 'explicit-selection')
      : existing?.providerBackendId;
    const raw = this.serializeMembers(members, { providerBackendId });
    await this.assertRosterMutationUnreservedUnderLock(
      teamName,
      options?.reservationTransactionId,
      fingerprintDurableTeamMembersMetaRaw(raw)
    );
    await atomicWriteAsync(this.getMetaPath(teamName), raw, {
      durability: 'strict',
      syncDirectory: true,
    });
  }

  serializeMembers(
    members: TeamMember[],
    options?: Pick<TeamMembersWriteOptions, 'providerBackendId'>
  ): string {
    const deduped = new Map<string, TeamMember>();
    for (const member of members) {
      const normalized = normalizeMember(member, 'explicit-selection');
      if (!normalized) {
        continue;
      }
      deduped.set(normalized.name, normalized);
    }

    // Defense: drop CLI auto-suffixed duplicates (alice-2) only when the base
    // name is still active. Removed base members must not hide active suffixed
    // teammates after live mutation / rollback flows.
    const allNames = Array.from(deduped.keys());
    const keepName = buildActiveNameGuard(deduped);
    for (const name of allNames) {
      if (!keepName(name)) {
        deduped.delete(name);
      }
    }

    const payload: TeamMembersMetaFile = {
      version: 2,
      providerBackendId: normalizeRootProviderBackendId(
        options?.providerBackendId,
        'explicit-selection'
      ),
      members: Array.from(deduped.values()).sort((a, b) => a.name.localeCompare(b.name)),
    };

    return JSON.stringify(payload, null, 2);
  }

  async writeDurableRawUnderLock(
    teamName: string,
    raw: string,
    reservationTransactionId: string
  ): Promise<void> {
    await this.assertMutable(teamName);
    await this.assertRosterMutationUnreservedUnderLock(teamName, reservationTransactionId);
    await atomicWriteAsync(this.getMetaPath(teamName), raw, {
      durability: 'strict',
      syncDirectory: true,
    });
  }

  async writeDurableRawCasUnderLock(
    teamName: string,
    raw: string,
    expectedFingerprint: string,
    reservationTransactionId: string
  ): Promise<void> {
    await this.assertMutable(teamName);
    await this.assertRosterMutationUnreservedUnderLock(teamName, reservationTransactionId);
    await this.assertCurrentFingerprint(teamName, expectedFingerprint);
    await atomicWriteAsync(this.getMetaPath(teamName), raw, {
      durability: 'strict',
      syncDirectory: true,
      beforeCommit: () => this.assertCurrentFingerprint(teamName, expectedFingerprint),
    });
  }

  private async assertCurrentFingerprint(
    teamName: string,
    expectedFingerprint: string
  ): Promise<void> {
    const current = await this.readDurableSnapshotUnderLock(teamName);
    if (current.fingerprint !== expectedFingerprint) {
      throw new RosterCompareAndSwapConflictError(current.fingerprint);
    }
  }

  private async assertRosterMutationUnreservedUnderLock(
    teamName: string,
    reservationTransactionId?: string,
    intendedFingerprint?: string
  ): Promise<void> {
    const effectiveReservationId =
      reservationTransactionId ?? rosterReservationContext.getStore()?.transactionId;
    const ledger = new TeamRosterAuthorizationLedger(() => 30_000);
    const record = await reconcileRosterAdmissionIndexUnderLock(ledger, teamName);
    if (!record) return;
    if (!ACTIVE_ROSTER_TRANSACTION_STATUSES.has(record.status)) return;
    if (record.transactionId !== effectiveReservationId) {
      throw new Error(`Roster is busy with authorization transaction ${record.transactionId}`);
    }
    if (
      reservationTransactionId === undefined &&
      intendedFingerprint !== undefined &&
      record.targetFingerprint !== intendedFingerprint
    ) {
      throw new Error('Roster launch consumption differs from the reserved transaction target');
    }
  }
}
