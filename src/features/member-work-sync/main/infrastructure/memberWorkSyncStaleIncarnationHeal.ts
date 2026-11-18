import { lstat, mkdir, readdir, readFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  InternalStorageOperationInterruptedError,
  listPreSqliteArchiveGenerations,
} from '@features/internal-storage/main';
import {
  atomicWriteAsync,
  syncDirectoryDurably,
} from '@main/utils/atomicWrite';

import {
  decodeMemberWorkSyncStoredStatus,
  MemberWorkSyncStatusDecodeError,
} from './decodeMemberWorkSyncStoredStatus';
import { readIncarnationMismatch } from './memberWorkSyncPreparationDiagnostics';
import { areSnapshotRecordSetsEquivalent } from './memberWorkSyncSqliteMappers';

import type { MemberWorkSyncStoreSnapshot } from './JsonMemberWorkSyncStore';
import type { MemberWorkSyncStorePaths } from './MemberWorkSyncStorePaths';
import type {
  MemberWorkSyncStatusDeleteTarget,
  MemberWorkSyncTeamSnapshotRecords,
} from '@features/internal-storage/contracts/internalStorageContracts';
import type { MemberWorkSyncStorageGateway } from '@features/internal-storage/main';
import type { InternalStorageJsonReplica } from '@features/internal-storage/main/infrastructure/InternalStorageJsonReplica';

export type StaleIncarnationHealOutcome = 'healed' | 'not_applicable' | 'refused' | 'failed';

export interface StaleIncarnationHealInput {
  teamName: string;
  /** Current incarnation, taken from the lifecycle owner inside its fence. */
  incarnation: string;
  backend: 'sqlite' | 'json';
  /** The preparation failure that triggered this attempt. */
  error: unknown;
  gateway: MemberWorkSyncStorageGateway;
  paths: MemberWorkSyncStorePaths;
  replica: InternalStorageJsonReplica<MemberWorkSyncStoreSnapshot>;
  logger?: { warn(message: string, metadata?: Record<string, unknown>): void };
}

type Source = 'primary' | 'active' | 'archive' | 'replica';
interface Entry {
  source: Source;
  memberName: string;
  foreignIncarnation: string;
  statusJson?: string;
  teamKey?: string;
  memberKey?: string;
  path?: string;
}
type FileOp =
  | { kind: 'quarantine'; path: string }
  | { kind: 'rewrite'; path: string; rawBefore: string; next: string };
interface ReplicaOp {
  state: 'clean' | 'dirty';
  snapshot: MemberWorkSyncStoreSnapshot;
  rawBefore: string;
}
interface Plan {
  entries: Entry[];
  evidenceTimes: number[];
  primaryKept: MemberWorkSyncTeamSnapshotRecords | null;
  primaryDelete: MemberWorkSyncStatusDeleteTarget[];
  files: FileOp[];
  replica: ReplicaOp | null;
  refusal: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Node may substitute ctime for birthtime on filesystems without creation timestamps.
 * Only a distinct, earlier birthtime is positive evidence of the directory's age.
 */
export function getVerifiedTeamRootBirthtimeMs(stats: {
  birthtimeMs: number;
  ctimeMs: number;
  isDirectory(): boolean;
}): number | null {
  if (
    !stats.isDirectory() ||
    !Number.isFinite(stats.birthtimeMs) ||
    stats.birthtimeMs <= 0 ||
    !Number.isFinite(stats.ctimeMs) ||
    stats.ctimeMs <= stats.birthtimeMs
  )
    return null;
  return stats.birthtimeMs;
}

/** A status is stale only when it decodes cleanly in every way except its recorded incarnation. */
function foreignIncarnationOf(
  input: StaleIncarnationHealInput,
  memberName: string,
  value: unknown
): { foreign: string; evaluatedAt: number } | null {
  try {
    decodeMemberWorkSyncStoredStatus(value, {
      teamName: input.teamName,
      memberName,
      incarnation: input.incarnation,
    });
    return null;
  } catch (error) {
    if (!(error instanceof MemberWorkSyncStatusDecodeError)) return null;
    if (error.reason !== 'incarnation_mismatch') return null;
    const evaluatedAt = Date.parse(String((value as { evaluatedAt?: unknown }).evaluatedAt));
    return { foreign: error.foreignIncarnation ?? '', evaluatedAt };
  }
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function parseOptional(raw: string | null): unknown {
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

async function planStatusFile(
  input: StaleIncarnationHealInput,
  plan: Plan,
  source: 'active' | 'archive',
  path: string,
  memberName: string | undefined
): Promise<void> {
  const raw = await readOptional(path);
  const value = parseOptional(raw);
  if (!isRecord(value) || raw === null) return;
  if (memberName !== undefined) {
    // Per-member envelope: { schemaVersion: 2, status }.
    if (value.schemaVersion !== 2 || !isRecord(value.status)) return;
    const found = foreignIncarnationOf(input, memberName, value.status);
    if (!found) return;
    plan.entries.push({ source, memberName, foreignIncarnation: found.foreign, path });
    plan.evidenceTimes.push(found.evaluatedAt);
    plan.files.push({ kind: 'quarantine', path });
    return;
  }
  // Legacy envelope: { schemaVersion: 1, members: { [memberKey]: status } }.
  if (value.schemaVersion !== 1 || !isRecord(value.members)) return;
  const kept: Record<string, unknown> = {};
  let removed = 0;
  for (const [memberKey, status] of Object.entries(value.members)) {
    const found = foreignIncarnationOf(input, memberKey, status);
    if (!found) {
      kept[memberKey] = status;
      continue;
    }
    removed += 1;
    plan.entries.push({ source, memberName: memberKey, foreignIncarnation: found.foreign, path });
    plan.evidenceTimes.push(found.evaluatedAt);
  }
  if (removed === 0) return;
  plan.files.push(
    Object.keys(kept).length === 0
      ? { kind: 'quarantine', path }
      : {
          kind: 'rewrite',
          path,
          rawBefore: raw,
          next: `${JSON.stringify({ ...value, members: kept }, null, 2)}\n`,
        }
  );
}

async function planFiles(input: StaleIncarnationHealInput, plan: Plan): Promise<void> {
  const { paths, teamName } = input;
  const inspect = async (path: string, memberName?: string): Promise<void> => {
    await planStatusFile(input, plan, 'active', path, memberName);
    for (const archive of await listPreSqliteArchiveGenerations(path))
      await planStatusFile(input, plan, 'archive', archive.filePath, memberName);
  };
  await inspect(paths.getLegacyStatusPath(teamName));
  const membersRoot = join(paths.getTeamRootDir(teamName), 'members');
  let directories: string[] = [];
  try {
    directories = await readdir(membersRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  for (const directory of directories) {
    let memberName: string;
    try {
      memberName = decodeURIComponent(directory);
    } catch {
      continue;
    }
    if (!memberName.trim() || paths.getMemberKey(memberName) !== directory) continue;
    await inspect(paths.getMemberStatusPath(teamName, memberName), memberName);
  }
}

async function planPrimary(input: StaleIncarnationHealInput, plan: Plan): Promise<void> {
  const records = await input.gateway.listTeamSnapshot(input.teamName);
  const kept = records.statuses.filter((row) => {
    let value: unknown;
    try {
      value = JSON.parse(row.statusJson);
    } catch {
      return true;
    }
    const found = foreignIncarnationOf(input, row.memberKey, value);
    if (!found) return true;
    plan.entries.push({
      source: 'primary',
      memberName: row.memberName,
      foreignIncarnation: found.foreign,
      statusJson: row.statusJson,
      teamKey: row.teamName,
      memberKey: row.memberKey,
    });
    plan.evidenceTimes.push(found.evaluatedAt);
    plan.primaryDelete.push({
      teamName: row.teamName,
      memberKey: row.memberKey,
      statusJson: row.statusJson,
    });
    return false;
  });
  if (kept.length !== records.statuses.length) plan.primaryKept = { ...records, statuses: kept };
}

async function planReplica(input: StaleIncarnationHealInput, plan: Plan): Promise<void> {
  const raw = await readOptional(input.paths.getSqliteFallbackReplicaPath(input.teamName));
  const envelope = parseOptional(raw);
  if (!isRecord(envelope) || raw === null || envelope.schemaVersion !== 1) return;
  if (envelope.state !== 'clean' && envelope.state !== 'dirty') return;
  const wrapperForeign =
    typeof envelope.incarnation === 'string' && envelope.incarnation !== input.incarnation;
  // A legacy dirty fence carries no trusted candidate, so none of it is ever validated or merged.
  if (envelope.state === 'dirty' && envelope.incarnation === undefined) return;
  if (!isRecord(envelope.snapshot) || !Array.isArray(envelope.snapshot.statuses)) return;
  if (wrapperForeign) {
    // Only status entries have trustworthy incarnation evidence. Never rebind
    // an old replica's outbox, report intents, metrics or file operations.
    const collections = [
      envelope.snapshot.reportIntents,
      envelope.snapshot.outboxItems,
      envelope.snapshot.metricEvents,
      envelope.snapshot.filesToArchive,
    ];
    if (collections.some((values) => !Array.isArray(values) || values.length > 0)) {
      plan.refusal = 'foreign_replica_non_status_data';
      return;
    }
  }
  const statuses = envelope.snapshot.statuses as unknown[];
  const kept = statuses.filter((status) => {
    const memberName =
      isRecord(status) && typeof status.memberName === 'string' ? status.memberName : '';
    const found = foreignIncarnationOf(input, memberName, status);
    if (!found) return true;
    plan.entries.push({ source: 'replica', memberName, foreignIncarnation: found.foreign });
    plan.evidenceTimes.push(found.evaluatedAt);
    return false;
  });
  if (!wrapperForeign && kept.length === statuses.length) return;
  if (envelope.state === 'dirty' && wrapperForeign) {
    // A dirty fence written under another identity is continuity evidence we cannot bridge.
    plan.refusal = 'dirty_replica_from_another_identity';
    return;
  }
  if (wrapperForeign) {
    const updatedAt = Date.parse(String(envelope.updatedAt));
    plan.evidenceTimes.push(updatedAt);
    if (kept.length === statuses.length)
      plan.entries.push({
        source: 'replica',
        memberName: '(replica wrapper)',
        foreignIncarnation: String(envelope.incarnation),
      });
  }
  plan.replica = {
    state: envelope.state,
    snapshot: { ...envelope.snapshot, statuses: kept } as unknown as MemberWorkSyncStoreSnapshot,
    rawBefore: raw,
  };
}

/** Evidence that the identity is the established one and the stale state predates this team. */
async function corroborate(input: StaleIncarnationHealInput, plan: Plan): Promise<string | null> {
  const root = input.paths.getTeamRootDir(input.teamName);
  let config: unknown;
  try {
    config = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'));
  } catch {
    return 'identity_unconfirmed';
  }
  if (!isRecord(config) || config._backupIdentityId !== input.incarnation)
    return 'identity_unconfirmed';
  try {
    await lstat(input.paths.getPendingPrimaryPurgePath(input.teamName));
    return 'purge_pending';
  } catch (error) {
    // A permission or I/O error cannot prove the absence of a deletion marker.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return 'purge_marker_unreadable';
  }
  let birth: number | null;
  try {
    birth = getVerifiedTeamRootBirthtimeMs(await lstat(root));
  } catch {
    return 'team_root_unreadable';
  }
  if (birth === null) return 'team_root_age_unknown';
  // Rows newer than the directory could be this team's own state under a re-minted marker.
  return plan.evidenceTimes.every((time) => Number.isFinite(time) && time <= birth)
    ? null
    : 'state_not_older_than_team';
}

async function execute(input: StaleIncarnationHealInput, plan: Plan): Promise<string> {
  const { paths, teamName, incarnation } = input;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const quarantine = join(paths.getTeamDir(teamName), `stale-incarnation-${stamp}.json`);
  const firstCreated = await mkdir(dirname(quarantine), { recursive: true });
  if (firstCreated) await syncDirectoryDurably(dirname(firstCreated));
  // Everything removed is recorded first, so a stale state is never unrecoverable.
  await atomicWriteAsync(
    quarantine,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        teamName,
        incarnation,
        quarantinedAt: new Date().toISOString(),
        entries: plan.entries,
        rewrittenFiles: plan.files.flatMap((op) =>
          op.kind === 'rewrite' ? [{ path: op.path, rawBefore: op.rawBefore }] : []
        ),
        ...(plan.replica ? { replicaBefore: plan.replica.rawBefore } : {}),
      },
      null,
      2
    )}\n`,
    { durability: 'strict', syncDirectory: true }
  );
  if (plan.primaryKept) {
    const removed = await input.gateway.statusDeleteMatching(teamName, plan.primaryDelete);
    if (removed !== plan.primaryDelete.length)
      throw new Error('member-work-sync stale status cleanup removed an unexpected row count');
    const roundTrip = await input.gateway.listTeamSnapshot(teamName);
    if (!areSnapshotRecordSetsEquivalent(roundTrip, plan.primaryKept))
      throw new Error(
        `member-work-sync stale status cleanup verification failed for "${teamName}"`
      );
  }
  for (const op of plan.files) {
    if (op.kind === 'quarantine') {
      await rename(op.path, `${op.path}.stale-incarnation.${stamp}`);
    } else {
      await atomicWriteAsync(op.path, op.next, { durability: 'strict', syncDirectory: true });
    }
    await syncDirectoryDurably(dirname(op.path));
  }
  if (plan.replica) {
    if (plan.replica.state === 'clean')
      await input.replica.writeClean(teamName, plan.replica.snapshot, incarnation);
    else
      await input.replica.markDirtyWithRecoveryCandidate(
        teamName,
        incarnation,
        plan.replica.snapshot
      );
  }
  return quarantine;
}

/**
 * Removes ONLY status entries that were written under an earlier identity of this team: stale
 * SQLite rows, stale JSON status files/entries (active and pre-sqlite archives) and the stale
 * parts of the fallback replica. Report intents, outbox, metrics, journals, the token secret,
 * current-incarnation state and every other team are never touched. Fail-closed on anything
 * unproven. Must run inside the lifecycle fence and the team mutex of the caller; one attempt
 * per preparation, the caller never loops.
 */
export async function healStaleIncarnationStatuses(
  input: StaleIncarnationHealInput
): Promise<StaleIncarnationHealOutcome> {
  if (!readIncarnationMismatch(input.error)) return 'not_applicable';
  const plan: Plan = {
    entries: [],
    evidenceTimes: [],
    primaryKept: null,
    primaryDelete: [],
    files: [],
    replica: null,
    refusal: null,
  };
  try {
    // Snapshot the state only after any interrupted worker can no longer write to it.
    await input.gateway.waitForSettling?.();
    await planReplica(input, plan);
    if (input.backend === 'sqlite') await planPrimary(input, plan);
    await planFiles(input, plan);
    if (plan.entries.length === 0 && !plan.replica && !plan.refusal) return 'not_applicable';
    const refusal = plan.refusal ?? (await corroborate(input, plan));
    if (refusal) {
      input.logger?.warn('member-work-sync stale status cleanup refused', {
        teamName: input.teamName,
        incarnation: input.incarnation,
        reason: refusal,
      });
      return 'refused';
    }
    const quarantine = await execute(input, plan);
    const sources: Record<string, number> = {};
    for (const entry of plan.entries) sources[entry.source] = (sources[entry.source] ?? 0) + 1;
    input.logger?.warn('member-work-sync healed stale status state from an earlier team identity', {
      teamName: input.teamName,
      incarnation: input.incarnation,
      removed: plan.entries.length,
      sources,
      foreignIncarnations: [...new Set(plan.entries.map((entry) => entry.foreignIncarnation))],
      quarantine,
    });
    return 'healed';
  } catch (error) {
    input.logger?.warn('member-work-sync stale status cleanup failed', {
      teamName: input.teamName,
      incarnation: input.incarnation,
      error: String(error),
    });
    // The authority must retain the identity fence until the interrupted writer settles.
    if (error instanceof InternalStorageOperationInterruptedError) throw error;
    return 'failed';
  }
}
