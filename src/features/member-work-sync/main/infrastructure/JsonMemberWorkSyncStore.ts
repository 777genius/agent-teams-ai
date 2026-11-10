import { compareAndWriteMemberWorkSyncJsonStore } from '@agent-teams/legacy-agent-host/work-sync/storage/createMemberWorkSyncJsonBackend';
import { isPendingReportsIndexFile } from '@agent-teams/legacy-agent-host/work-sync/storage/jsonStorePolicy';
import { MemberWorkSyncOutboxOperations } from '@agent-teams/legacy-agent-host/work-sync/storage/MemberWorkSyncOutboxOperations';
import { MemberWorkSyncWriteQueue } from '@agent-teams/legacy-agent-host/work-sync/storage/MemberWorkSyncWriteQueue';
import { scanMemberWorkSyncNames } from '@agent-teams/legacy-agent-host/work-sync/storage/scanMemberWorkSyncNames';

import type { MemberWorkSyncSourcePublication } from './memberWorkSyncStoragePublication';
import type { PendingReportsIndexFile } from '@agent-teams/legacy-agent-host/work-sync/storage/jsonStorePolicy';
export type {
  MetricsIndexFile,
  MetricsIndexMember,
} from '@agent-teams/legacy-agent-host/work-sync/storage/jsonStorePolicy';
export {
  buildMetricEvents,
  normalizeTeamKey,
} from '@agent-teams/legacy-agent-host/work-sync/storage/jsonStorePolicy';
import {
  readJsonFile,
  writeJsonFile,
} from '@agent-teams/legacy-agent-host/work-sync/storage/jsonStoreFiles';
import {
  emptyMetricsIndex,
  isMemberOutboxFile,
  isMetricsIndexFile,
  isOutboxIndexFile,
  isOutboxItemOwnedBy,
  MemberOutboxFile,
  MetricsIndexFile,
  normalizeTeamKey,
  OutboxIndexFile,
  OutboxIndexRoute,
  updateMetricsMember,
} from '@agent-teams/legacy-agent-host/work-sync/storage/jsonStorePolicy';

import { JsonMemberWorkSyncReportJournal } from './JsonMemberWorkSyncReportJournal';
import { buildPendingReportIntentId } from './memberWorkSyncReportIntentId';
import { findCanonicalReportJournalOwner } from './memberWorkSyncReportJournalOwnership';
export { buildPendingReportIntentId };

import { listPreSqliteArchiveGenerations } from '@features/internal-storage/main';
import { withFileLock } from '@main/services/team/fileLock';
import { access, readdir } from 'fs/promises';
import { join } from 'path';

import { decodeMemberWorkSyncImportStatus } from './decodeMemberWorkSyncStoredStatus';
import { readMemberWorkSyncJsonStatus } from './memberWorkSyncJsonStatusPersistence';
import { toMetrics } from './memberWorkSyncMetricsProjection';
import { restoreMemberWorkSyncJsonDelivery } from './restoreMemberWorkSyncJsonDelivery';
import { restoreMemberWorkSyncJsonStatuses } from './restoreMemberWorkSyncJsonStatuses';
export { toMetrics } from './memberWorkSyncMetricsProjection';

import {
  listJsonMemberWorkSyncActiveFilePaths,
  purgeJsonMemberWorkSyncActiveState,
} from './JsonMemberWorkSyncActiveStatePurger';
import {
  mergeDomainSnapshots,
  mergeImportedStatus,
  pickDomainOutboxItem,
  pickDomainReportIntent,
} from './memberWorkSyncDomainSnapshotMerge';
import {
  isMemberStatusFile,
  MemberWorkSyncSafetyJsonReadError,
  readMemberWorkSyncSafetyJson,
} from './memberWorkSyncSafetyJson';
import { normalizeMemberKey } from './memberWorkSyncStoreIdentity';

import type {
  MemberWorkSyncMetricEvent,
  MemberWorkSyncOutboxClaimInput,
  MemberWorkSyncOutboxCountDeliveredForAgendaInput,
  MemberWorkSyncOutboxCountRecentDeliveredInput,
  MemberWorkSyncOutboxEnsureInput,
  MemberWorkSyncOutboxEnsureResult,
  MemberWorkSyncOutboxItem,
  MemberWorkSyncOutboxMarkDeliveredInput,
  MemberWorkSyncOutboxMarkFailedInput,
  MemberWorkSyncOutboxMarkSupersededInput,
  MemberWorkSyncOutboxRecentDeliveredSummary,
  MemberWorkSyncReportIntent,
  MemberWorkSyncReportRequest,
  MemberWorkSyncStatus,
  MemberWorkSyncTeamMetrics,
} from '../../contracts';
import type {
  MemberWorkSyncAuditJournalPort,
  MemberWorkSyncLoggerPort,
  MemberWorkSyncOutboxStorePort,
  MemberWorkSyncReportStorePort,
  MemberWorkSyncStatusStorePort,
} from '../../core/application';
import type { MemberWorkSyncStorePaths } from './MemberWorkSyncStorePaths';

export { normalizeMemberKey } from './memberWorkSyncStoreIdentity';

interface LegacyStatusFile {
  schemaVersion: 1;
  members: Record<string, MemberWorkSyncStatus>;
  metrics?: {
    recentEvents: MemberWorkSyncMetricEvent[];
  };
}

/**
 * Everything currently readable from the JSON backend for one team, read for
 * import into SQLite. A retry after a partial archive can be a strict subset of
 * an earlier snapshot, so consumers must treat these arrays as an overlay:
 * memberKey identifies statuses and id identifies report intents, outbox items,
 * and metric events. Status revisions select winners; missing identities are not
 * deletions. filesToArchive lists every file the snapshot came from.
 */
export interface MemberWorkSyncStoreSnapshot {
  statuses: MemberWorkSyncStatus[];
  reportIntents: MemberWorkSyncReportIntent[];
  outboxItems: MemberWorkSyncOutboxItem[];
  metricEvents: MemberWorkSyncMetricEvent[];
  filesToArchive: string[];
}

const MEMBER_WORK_SYNC_STATUS_STATES = new Set<string>([
  'caught_up',
  'needs_sync',
  'still_working',
  'blocked',
  'inactive',
  'unknown',
]);
const MEMBER_WORK_SYNC_REPORT_STATUSES = new Set<string>([
  'pending',
  'accepted',
  'rejected',
  'superseded',
]);
const MEMBER_WORK_SYNC_OUTBOX_STATUSES = new Set<string>([
  'pending',
  'claimed',
  'delivered',
  'superseded',
  'failed_retryable',
  'failed_terminal',
]);
const MEMBER_WORK_SYNC_METRIC_KINDS = new Set<string>([
  'status_evaluated',
  'would_nudge',
  'fingerprint_changed',
  'report_accepted',
  'report_rejected',
]);

export function isMemberWorkSyncStoreSnapshot(
  value: unknown,
  expectedTeamName?: string
): value is MemberWorkSyncStoreSnapshot {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<MemberWorkSyncStoreSnapshot>;
  const ownsTeam = (teamName: string): boolean =>
    expectedTeamName === undefined ||
    normalizeTeamKey(teamName) === normalizeTeamKey(expectedTeamName);
  return (
    Array.isArray(record.statuses) &&
    record.statuses.every(
      (row) =>
        row &&
        typeof row.teamName === 'string' &&
        ownsTeam(row.teamName) &&
        typeof row.memberName === 'string' &&
        MEMBER_WORK_SYNC_STATUS_STATES.has(row.state) &&
        typeof row.evaluatedAt === 'string' &&
        row.agenda != null &&
        typeof row.agenda === 'object' &&
        typeof row.agenda.teamName === 'string' &&
        ownsTeam(row.agenda.teamName) &&
        typeof row.agenda.memberName === 'string' &&
        typeof row.agenda.fingerprint === 'string' &&
        Array.isArray(row.agenda.items) &&
        Array.isArray(row.agenda.diagnostics) &&
        row.agenda.diagnostics.every((diagnostic) => typeof diagnostic === 'string') &&
        Array.isArray(row.diagnostics) &&
        row.diagnostics.every((diagnostic) => typeof diagnostic === 'string')
    ) &&
    Array.isArray(record.reportIntents) &&
    record.reportIntents.every(
      (row) =>
        row &&
        typeof row.id === 'string' &&
        typeof row.teamName === 'string' &&
        ownsTeam(row.teamName) &&
        typeof row.memberName === 'string' &&
        MEMBER_WORK_SYNC_REPORT_STATUSES.has(row.status) &&
        typeof row.reason === 'string' &&
        typeof row.recordedAt === 'string' &&
        row.request != null &&
        typeof row.request === 'object' &&
        ownsTeam(row.request.teamName)
    ) &&
    Array.isArray(record.outboxItems) &&
    record.outboxItems.every(
      (row) =>
        row &&
        typeof row.id === 'string' &&
        typeof row.teamName === 'string' &&
        ownsTeam(row.teamName) &&
        typeof row.memberName === 'string' &&
        typeof row.agendaFingerprint === 'string' &&
        typeof row.payloadHash === 'string' &&
        MEMBER_WORK_SYNC_OUTBOX_STATUSES.has(row.status) &&
        Number.isInteger(row.attemptGeneration) &&
        row.attemptGeneration >= 0 &&
        row.payload != null &&
        typeof row.payload === 'object' &&
        typeof row.payload.to === 'string' &&
        typeof row.createdAt === 'string' &&
        typeof row.updatedAt === 'string' &&
        (row.status !== 'delivered' || typeof row.deliveredMessageId === 'string')
    ) &&
    Array.isArray(record.metricEvents) &&
    record.metricEvents.every(
      (row) =>
        row &&
        typeof row.id === 'string' &&
        typeof row.teamName === 'string' &&
        ownsTeam(row.teamName) &&
        typeof row.memberName === 'string' &&
        MEMBER_WORK_SYNC_METRIC_KINDS.has(row.kind) &&
        MEMBER_WORK_SYNC_STATUS_STATES.has(row.state) &&
        typeof row.agendaFingerprint === 'string' &&
        typeof row.actionableCount === 'number' &&
        typeof row.recordedAt === 'string'
    ) &&
    Array.isArray(record.filesToArchive) &&
    record.filesToArchive.length === 0
  );
}

/** No mutations: validate every incoming collection before any restore phase publishes data. */
function validateImportSnapshot(teamName: string, snapshot: MemberWorkSyncStoreSnapshot): void {
  if (!isMemberWorkSyncStoreSnapshot({ ...snapshot, filesToArchive: [] }, teamName)) {
    throw new MemberWorkSyncSafetyJsonReadError('corrupt');
  }
  for (const status of snapshot.statuses) {
    decodeMemberWorkSyncImportStatus(status, { teamName, memberName: status.memberName });
  }
  for (const intent of snapshot.reportIntents) {
    if (
      !intent.id.trim() ||
      !normalizeMemberKey(intent.memberName) ||
      normalizeMemberKey(intent.request.memberName) !== normalizeMemberKey(intent.memberName)
    ) {
      throw new MemberWorkSyncSafetyJsonReadError('corrupt');
    }
  }
  for (const item of snapshot.outboxItems) {
    if (!item.id.trim() || !normalizeMemberKey(item.memberName))
      throw new MemberWorkSyncSafetyJsonReadError('corrupt');
  }
}

interface MemberStatusFile {
  schemaVersion: 2;
  status: MemberWorkSyncStatus;
}

interface LegacyPendingReportFile {
  schemaVersion: 1;
  intents: Record<string, MemberWorkSyncReportIntent>;
}

interface MemberReportsFile {
  schemaVersion: 2;
  intents: Record<string, MemberWorkSyncReportIntent>;
}

interface LegacyOutboxFile {
  schemaVersion: 1;
  items: Record<string, MemberWorkSyncOutboxItem>;
}

export interface JsonMemberWorkSyncStoreDeps {
  sourceWriteAdmission?: MemberWorkSyncSourcePublication;
  /** Backup readers reject broken indexes without quarantining source files. */
  strictIndexReads?: boolean;
  auditJournal?: MemberWorkSyncAuditJournalPort;
  logger?: MemberWorkSyncLoggerPort;
  now?: () => Date;
}

function isLegacyStatusFile(value: unknown): value is LegacyStatusFile {
  return (
    value != null &&
    typeof value === 'object' &&
    (value as LegacyStatusFile).schemaVersion === 1 &&
    (value as LegacyStatusFile).members != null &&
    typeof (value as LegacyStatusFile).members === 'object' &&
    !Array.isArray((value as LegacyStatusFile).members)
  );
}

function isLegacyPendingReportFile(value: unknown): value is LegacyPendingReportFile {
  return (
    value != null &&
    typeof value === 'object' &&
    (value as LegacyPendingReportFile).schemaVersion === 1 &&
    (value as LegacyPendingReportFile).intents != null &&
    typeof (value as LegacyPendingReportFile).intents === 'object' &&
    !Array.isArray((value as LegacyPendingReportFile).intents)
  );
}

function isMemberReportsFile(value: unknown): value is MemberReportsFile {
  return (
    value != null &&
    typeof value === 'object' &&
    (value as MemberReportsFile).schemaVersion === 2 &&
    (value as MemberReportsFile).intents != null &&
    typeof (value as MemberReportsFile).intents === 'object' &&
    !Array.isArray((value as MemberReportsFile).intents)
  );
}

function isLegacyOutboxFile(value: unknown): value is LegacyOutboxFile {
  return (
    value != null &&
    typeof value === 'object' &&
    (value as LegacyOutboxFile).schemaVersion === 1 &&
    (value as LegacyOutboxFile).items != null &&
    typeof (value as LegacyOutboxFile).items === 'object' &&
    !Array.isArray((value as LegacyOutboxFile).items)
  );
}

function isReportIntentOwnedBy(
  teamName: string,
  memberName: string,
  intent: MemberWorkSyncReportIntent
): boolean {
  return (
    normalizeTeamKey(intent.teamName) === normalizeTeamKey(teamName) &&
    normalizeMemberKey(intent.memberName) === normalizeMemberKey(memberName)
  );
}

export class JsonMemberWorkSyncStore
  implements
    MemberWorkSyncStatusStorePort,
    MemberWorkSyncReportStorePort,
    MemberWorkSyncOutboxStorePort
{
  private readonly outboxOperations: MemberWorkSyncOutboxOperations;
  private readonly writeQueue = new MemberWorkSyncWriteQueue();
  private readonly now: () => Date;

  constructor(
    private readonly paths: MemberWorkSyncStorePaths,
    private readonly deps: JsonMemberWorkSyncStoreDeps = {}
  ) {
    this.now = deps.now ?? (() => new Date());
    this.outboxOperations = new MemberWorkSyncOutboxOperations({
      paths: this.paths,
      enqueue: (team, operation) => this.enqueue(team, operation),
      readMemberOutboxFile: (team, member) => this.readMemberOutboxFile(team, member),
      writeMemberOutboxFile: (team, member, file) => this.writeMemberOutboxFile(team, member, file),
      readOutboxIndexFile: (team) => this.readOutboxIndexFile(team),
      writeOutboxIndexFile: (team, file) => this.writeOutboxIndexFile(team, file),
      scanMemberNames: (team) => this.scanMemberNames(team),
      readLegacyOutboxFile: (team) => this.readLegacyOutboxFile(team),
      appendAudit: (input) => this.appendAudit(input),
    });
  }

  createReportJournal(): JsonMemberWorkSyncReportJournal {
    return new JsonMemberWorkSyncReportJournal(
      this.paths,
      (team, operation) => this.enqueue(team, operation),
      async (intent) => {
        const index = await this.readPendingReportsIndexFile(intent.teamName);
        index.items[intent.id] = {
          memberKey: this.paths.getMemberKey(intent.memberName),
          memberName: intent.memberName,
          status: intent.status,
          recordedAt: intent.recordedAt,
        };
        await this.writePendingReportsIndexFile(intent.teamName, index);
      }
    );
  }

  async read(input: {
    teamName: string;
    memberName: string;
  }): Promise<MemberWorkSyncStatus | null> {
    const memberFile = await this.readMemberStatusFile(input.teamName, input.memberName);
    if (memberFile) {
      return memberFile.status;
    }

    const legacy = await this.readLegacyStatusFile(input.teamName);
    const legacyStatus = legacy.members[normalizeMemberKey(input.memberName)] ?? null;
    if (legacyStatus) {
      await this.appendAudit({
        teamName: input.teamName,
        memberName: input.memberName,
        event: 'legacy_fallback_used',
        source: 'json_store',
        reason: 'status_v1',
      });
    }
    return legacyStatus;
  }

  readCanonicalStatusSnapshot(input: { teamName: string; memberName: string }) {
    return readMemberWorkSyncJsonStatus(
      this.paths.getMemberStatusPath(input.teamName, input.memberName)
    );
  }

  async compareAndWriteCanonicalStatus(input: {
    expectedRaw: string | null;
    mutationId: string;
    nextStatus: MemberWorkSyncStatus;
  }) {
    return compareAndWriteMemberWorkSyncJsonStore(
      {
        teamName: input.nextStatus.teamName,
        memberName: input.nextStatus.memberName,
        paths: this.paths,
        queue: this.writeQueue,
        assertCurrent() {},
        project: async () => {
          const metrics = await this.readMetricsIndexFile(input.nextStatus.teamName);
          updateMetricsMember(
            metrics,
            input.nextStatus,
            this.paths.getMemberKey(input.nextStatus.memberName)
          );
          await this.writeMetricsIndexFile(input.nextStatus.teamName, metrics);
        },
      },
      input
    );
  }

  async write(status: MemberWorkSyncStatus): Promise<void> {
    const memberKey = this.paths.getMemberKey(status.memberName);
    await this.paths.ensureMemberWorkSyncDir(status.teamName, status.memberName);
    await this.enqueue(status.teamName, async () => {
      await withFileLock(
        this.paths.getMetricsIndexPath(status.teamName),
        async () => {
          await withFileLock(
            this.paths.getMemberStatusPath(status.teamName, status.memberName),
            async () => {
              const metrics = await this.readMetricsIndexFile(status.teamName);
              updateMetricsMember(metrics, status, memberKey);
              await this.writeMemberStatusFile(status);
              await this.writeMetricsIndexFile(status.teamName, metrics);
            },
            { preventLiveOwnerTakeover: true }
          );
        },
        { preventLiveOwnerTakeover: true }
      );
    });
    await this.appendAudit({
      teamName: status.teamName,
      memberName: status.memberName,
      event: 'status_written',
      source: 'json_store',
      agendaFingerprint: status.agenda.fingerprint,
      state: status.state,
      actionableCount: status.agenda.items.length,
      ...(status.shadow?.triggerReasons ? { triggerReasons: status.shadow.triggerReasons } : {}),
      ...(status.providerId ? { providerId: status.providerId } : {}),
    });
  }

  async readTeamMetrics(teamName: string): Promise<MemberWorkSyncTeamMetrics> {
    let file = await this.readMetricsIndexFile(teamName);
    if (Object.keys(file.members).length === 0 && file.recentEvents.length === 0) {
      const repaired = await this.repairMetricsIndex(teamName);
      if (repaired) {
        file = repaired;
      }
    }
    return toMetrics(teamName, file);
  }

  async appendPendingReport(request: MemberWorkSyncReportRequest, reason: string): Promise<void> {
    const id = buildPendingReportIntentId(request);
    const memberKey = this.paths.getMemberKey(request.memberName);
    await this.paths.ensureMemberWorkSyncDir(request.teamName, request.memberName);
    await this.enqueue(request.teamName, async () => {
      await withFileLock(this.paths.getPendingReportsIndexPath(request.teamName), async () => {
        await withFileLock(
          this.paths.getMemberReportsPath(request.teamName, request.memberName),
          async () => {
            const owner = await findCanonicalReportJournalOwner(this.paths, {
              teamName: request.teamName,
              memberName: request.memberName,
              incarnation: 'unbound',
              intentId: id,
              requestDigest: 'unbound',
            });
            if (
              owner.state === 'conflict' ||
              owner.state === 'corrupt' ||
              owner.state === 'unavailable'
            ) {
              throw new Error('Bound report intent requires strict journal API');
            }
            const reports = await this.readMemberReportsFile(request.teamName, request.memberName);
            const current = reports.intents[id];
            if (current?.journal)
              throw new Error('Bound report intent requires strict journal API');
            if (current && current.status !== 'pending') {
              return;
            }
            const intent: MemberWorkSyncReportIntent = {
              id,
              teamName: request.teamName,
              memberName: request.memberName,
              request,
              reason: current?.reason ?? reason,
              status: 'pending',
              recordedAt: current?.recordedAt ?? this.now().toISOString(),
            };
            reports.intents[id] = intent;
            await this.writeMemberReportsFile(request.teamName, request.memberName, reports);

            const index = await this.readPendingReportsIndexFile(request.teamName);
            index.items[id] = {
              memberKey,
              memberName: request.memberName,
              status: intent.status,
              recordedAt: intent.recordedAt,
            };
            await this.writePendingReportsIndexFile(request.teamName, index);
          }
        );
      });
    });
  }

  async listPendingReports(teamName: string): Promise<MemberWorkSyncReportIntent[]> {
    let index = await this.readPendingReportsIndexFile(teamName);
    if (Object.keys(index.items).length === 0) {
      await this.enqueue(teamName, async () => {
        await withFileLock(this.paths.getPendingReportsIndexPath(teamName), async () => {
          index = await this.readPendingReportsIndexFile(teamName);
          if (Object.keys(index.items).length === 0) {
            index = await this.repairPendingReportsIndex(teamName);
          }
        });
      });
    }
    let staleIndex = false;
    const pending: MemberWorkSyncReportIntent[] = [];
    for (const [id, route] of Object.entries(index.items)) {
      if (route.status !== 'pending') {
        continue;
      }
      const file = await this.readMemberReportsFile(teamName, route.memberName);
      const intent = file.intents[id];
      if (intent?.status === 'pending') {
        pending.push(intent);
      } else {
        staleIndex = true;
      }
    }
    const unindexedOrStaleIndexedPending = staleIndex
      ? false
      : await this.hasUnindexedOrStaleIndexedPendingReport(teamName, index);
    if (staleIndex || unindexedOrStaleIndexedPending) {
      await this.enqueue(teamName, async () => {
        await withFileLock(this.paths.getPendingReportsIndexPath(teamName), async () => {
          index = await this.repairPendingReportsIndex(teamName);
        });
      });
      pending.length = 0;
      for (const [id, route] of Object.entries(index.items)) {
        if (route.status !== 'pending') {
          continue;
        }
        const file = await this.readMemberReportsFile(teamName, route.memberName);
        const intent = file.intents[id];
        if (intent?.status === 'pending') {
          pending.push(intent);
        }
      }
    }
    return pending.sort((left, right) => left.recordedAt.localeCompare(right.recordedAt));
  }

  async markPendingReportProcessed(
    teamName: string,
    id: string,
    result: {
      status: MemberWorkSyncReportIntent['status'];
      resultCode: string;
      processedAt: string;
    }
  ): Promise<void> {
    await this.enqueue(teamName, async () => {
      await withFileLock(this.paths.getPendingReportsIndexPath(teamName), async () => {
        let index = await this.readPendingReportsIndexFile(teamName);
        if (!index.items[id]) {
          index = await this.repairPendingReportsIndex(teamName);
        }
        const route = index.items[id];
        if (!route) {
          return;
        }
        const updateRoute = async (
          targetRoute: PendingReportsIndexFile['items'][string]
        ): Promise<boolean> => {
          let staleRoute = false;
          await withFileLock(
            this.paths.getMemberReportsPath(teamName, targetRoute.memberName),
            async () => {
              const reports = await this.readMemberReportsFile(teamName, targetRoute.memberName);
              const current = reports.intents[id];
              if (!current) {
                delete index.items[id];
                staleRoute = true;
                return;
              }
              if (!isReportIntentOwnedBy(teamName, targetRoute.memberName, current)) {
                delete index.items[id];
                staleRoute = true;
                return;
              }
              if (current.status !== 'pending') {
                return;
              }
              if (current.journal)
                throw new Error('Bound report intent requires strict journal API');
              const next: MemberWorkSyncReportIntent = {
                ...current,
                status: result.status,
                resultCode: result.resultCode,
                processedAt: result.processedAt,
              };
              reports.intents[id] = next;
              await this.writeMemberReportsFile(teamName, targetRoute.memberName, reports);
              index.items[id] = toPendingReportIndexItem(
                next,
                this.paths.getMemberKey(next.memberName)
              );
              await this.writePendingReportsIndexFile(teamName, index);
            }
          );
          return staleRoute;
        };

        let staleRoute = await updateRoute(route);
        if (staleRoute) {
          index = await this.repairPendingReportsIndex(teamName);
          const repairedRoute = index.items[id];
          if (!repairedRoute) {
            return;
          }
          staleRoute = await updateRoute(repairedRoute);
          if (staleRoute) {
            await this.repairPendingReportsIndex(teamName);
          }
        }
      });
    });
  }

  async ensurePending(
    input: MemberWorkSyncOutboxEnsureInput
  ): Promise<MemberWorkSyncOutboxEnsureResult> {
    return this.outboxOperations.ensurePending(input);
  }

  async claimDue(input: MemberWorkSyncOutboxClaimInput): Promise<MemberWorkSyncOutboxItem[]> {
    return this.outboxOperations.claimDue(input);
  }

  async markDelivered(input: MemberWorkSyncOutboxMarkDeliveredInput): Promise<void> {
    return this.outboxOperations.markDelivered(input);
  }

  async markSuperseded(input: MemberWorkSyncOutboxMarkSupersededInput): Promise<void> {
    return this.outboxOperations.markSuperseded(input);
  }

  async markFailed(input: MemberWorkSyncOutboxMarkFailedInput): Promise<void> {
    return this.outboxOperations.markFailed(input);
  }

  async countRecentDelivered(
    input: MemberWorkSyncOutboxCountRecentDeliveredInput
  ): Promise<MemberWorkSyncOutboxRecentDeliveredSummary> {
    return this.outboxOperations.countRecentDelivered(input);
  }

  async countDeliveredForAgenda(
    input: MemberWorkSyncOutboxCountDeliveredForAgendaInput
  ): Promise<number> {
    return this.outboxOperations.countDeliveredForAgenda(input);
  }

  async findDeliveredReviewPickupRequestEventIds(input: {
    teamName: string;
    memberName: string;
    reviewRequestEventIds: string[];
  }): Promise<string[]> {
    return this.outboxOperations.findDeliveredReviewPickupRequestEventIds(input);
  }

  async findRecentRecoveryByIntent(input: {
    teamName: string;
    memberName: string;
    intentKey: string;
    sinceIso: string;
  }): Promise<{
    id: string;
    status: MemberWorkSyncOutboxItem['status'];
    deliveredMessageId?: string;
    payloadHash: string;
    updatedAt: string;
  } | null> {
    return this.outboxOperations.findRecentRecoveryByIntent(input);
  }

  async readItem(input: {
    teamName: string;
    memberName: string;
    id: string;
  }): Promise<MemberWorkSyncOutboxItem | null> {
    return this.outboxOperations.readItem(input);
  }

  async purgeActiveState(
    teamName: string,
    lifecycle: Parameters<typeof purgeJsonMemberWorkSyncActiveState>[1]
  ): Promise<void> {
    await this.enqueue(teamName, async () => {
      await purgeJsonMemberWorkSyncActiveState(
        await listJsonMemberWorkSyncActiveFilePaths(this.paths, teamName),
        lifecycle
      );
    });
  }

  /**
   * Reads everything this backend persisted for a team, for the one-time
   * import into SQLite. Returns null when no member-work-sync files exist.
   * File-format knowledge (v1 legacy, v2 per-member, indexes) stays inside
   * this module. Ownership filters match the index-repair paths, so foreign
   * or malformed entries are excluded the same way repairs exclude them.
   */
  async readSnapshotForImport(teamName: string): Promise<MemberWorkSyncStoreSnapshot | null> {
    let snapshot: MemberWorkSyncStoreSnapshot | null = null;
    // Serialized through the same per-team write queue as every mutation, so
    // the snapshot cannot race a queued JSON write whose effect would be lost
    // once the files are archived after import.
    await this.enqueue(teamName, async () => {
      snapshot = await this.readSnapshotForImportUnqueued(teamName);
    });
    return snapshot;
  }

  /**
   * Rebuilds the import snapshot from immutable pre-SQLite files. Every
   * generation of each logical JSON file is applied oldest-to-newest so a
   * smaller, partially archived generation cannot delete earlier identities.
   */
  async readArchivedSnapshotForImport(
    teamName: string
  ): Promise<MemberWorkSyncStoreSnapshot | null> {
    let snapshot: MemberWorkSyncStoreSnapshot | null = null;
    await this.enqueue(teamName, async () => {
      snapshot = await this.readArchivedSnapshotForImportUnqueued(teamName);
    });
    return snapshot;
  }

  /**
   * Hydrates the live JSON backend from the last clean SQLite compatibility
   * replica. Existing live JSON is merged semantically so a previous fallback
   * session cannot be rolled back by an older replica.
   */
  async restoreReplicaSnapshot(
    teamName: string,
    replica: MemberWorkSyncStoreSnapshot
  ): Promise<void> {
    await this.enqueue(teamName, async () => {
      validateImportSnapshot(teamName, replica);
      const active = await this.readSnapshotForImportUnqueued(teamName);
      if (active) validateImportSnapshot(teamName, active);
      const snapshot = mergeDomainSnapshots(replica, active);

      await restoreMemberWorkSyncJsonStatuses(this.paths, teamName, snapshot);

      await restoreMemberWorkSyncJsonDelivery(this.paths, teamName, snapshot, {
        reports: (memberName) => this.readMemberReportsFile(teamName, memberName),
        outbox: (memberName) => this.readMemberOutboxFile(teamName, memberName),
        reportIndex: () => this.readPendingReportsIndexFile(teamName),
        outboxIndex: () => this.readOutboxIndexFile(teamName),
      });
    });
  }

  private async readSnapshotForImportUnqueued(
    teamName: string
  ): Promise<MemberWorkSyncStoreSnapshot | null> {
    const memberNames = await this.scanMemberNamesForImport(teamName);
    const candidateFiles = [
      this.paths.getLegacyStatusPath(teamName),
      this.paths.getLegacyPendingReportsPath(teamName),
      this.paths.getLegacyOutboxPath(teamName),
      this.paths.getMetricsIndexPath(teamName),
      this.paths.getOutboxIndexPath(teamName),
      this.paths.getPendingReportsIndexPath(teamName),
    ];
    for (const memberName of memberNames) {
      candidateFiles.push(
        this.paths.getMemberStatusPath(teamName, memberName),
        this.paths.getMemberReportsPath(teamName, memberName),
        this.paths.getMemberOutboxPath(teamName, memberName)
      );
    }
    const filesToArchive: string[] = [];
    for (const filePath of candidateFiles) {
      try {
        await access(filePath);
        filesToArchive.push(filePath);
      } catch {
        // Absent files are simply not part of the snapshot.
      }
    }
    if (filesToArchive.length === 0) {
      return null;
    }

    // Ownership filters mirror the index-repair paths: entries claiming a
    // different team must not leak into another team's imported rows.
    const teamKey = normalizeTeamKey(teamName);
    const statuses = new Map<string, MemberWorkSyncStatus>();
    for (const memberName of memberNames) {
      const status = (await this.readMemberStatusFile(teamName, memberName))?.status;
      if (!status || normalizeTeamKey(status.teamName) !== teamKey) {
        continue;
      }
      mergeImportedStatus(statuses, normalizeMemberKey(status.memberName), status);
    }
    const legacyStatus = await this.readLegacyStatusFile(teamName);
    for (const [memberKey, status] of Object.entries(legacyStatus.members)) {
      if (normalizeTeamKey(status.teamName) !== teamKey) {
        continue;
      }
      const key = normalizeMemberKey(status.memberName) || normalizeMemberKey(memberKey);
      mergeImportedStatus(statuses, key, status, true);
    }

    const reportIntents = new Map<string, MemberWorkSyncReportIntent>();
    for (const memberName of memberNames) {
      const reports = await this.readMemberReportsFile(teamName, memberName);
      for (const intent of Object.values(reports.intents)) {
        if (isReportIntentOwnedBy(teamName, memberName, intent)) {
          const current = reportIntents.get(intent.id);
          reportIntents.set(intent.id, current ? pickDomainReportIntent(current, intent) : intent);
        }
      }
    }
    for (const intent of Object.values((await this.readLegacyPendingFile(teamName)).intents)) {
      if (!isReportIntentOwnedBy(teamName, intent.memberName, intent)) continue;
      const current = reportIntents.get(intent.id);
      reportIntents.set(intent.id, current ? pickDomainReportIntent(current, intent) : intent);
    }

    const outboxItems = new Map<string, MemberWorkSyncOutboxItem>();
    for (const memberName of memberNames) {
      const outbox = await this.readMemberOutboxFile(teamName, memberName);
      for (const item of Object.values(outbox.items)) {
        if (isOutboxItemOwnedBy(teamName, memberName, item)) {
          outboxItems.set(item.id, item);
        }
      }
    }
    for (const item of Object.values((await this.readLegacyOutboxFile(teamName)).items)) {
      if (!isOutboxItemOwnedBy(teamName, item.memberName, item)) continue;
      const current = outboxItems.get(item.id);
      outboxItems.set(item.id, current ? pickDomainOutboxItem(current, item) : item);
    }

    const metricEvents = new Map<string, MemberWorkSyncMetricEvent>();
    for (const event of legacyStatus.metrics?.recentEvents ?? []) {
      if (normalizeTeamKey(event.teamName) === teamKey) {
        metricEvents.set(event.id, event);
      }
    }
    for (const event of (await this.readMetricsIndexFile(teamName)).recentEvents) {
      if (normalizeTeamKey(event.teamName) === teamKey) {
        metricEvents.set(event.id, event);
      }
    }

    return {
      statuses: [...statuses.values()],
      reportIntents: [...reportIntents.values()],
      outboxItems: [...outboxItems.values()],
      metricEvents: [...metricEvents.values()],
      filesToArchive,
    };
  }

  private async readArchivedSnapshotForImportUnqueued(
    teamName: string
  ): Promise<MemberWorkSyncStoreSnapshot | null> {
    const teamKey = normalizeTeamKey(teamName);
    const memberNames = await this.scanMemberNamesForImport(teamName);
    const archivePathsByFile = new Map<string, string[]>();
    let archiveCount = 0;

    const archivePaths = async (filePath: string): Promise<string[]> => {
      const cached = archivePathsByFile.get(filePath);
      if (cached) {
        return cached;
      }
      const paths = (await listPreSqliteArchiveGenerations(filePath)).map(
        (archive) => archive.filePath
      );
      archivePathsByFile.set(filePath, paths);
      archiveCount += paths.length;
      return paths;
    };
    const readArchiveFiles = async <T>(
      filePath: string,
      guard: (value: unknown) => value is T,
      fallback: T
    ): Promise<T[]> => {
      const files: T[] = [];
      for (const archivedPath of await archivePaths(filePath)) {
        files.push(await readMemberWorkSyncSafetyJson(archivedPath, guard, fallback, false));
      }
      return files;
    };

    const statuses = new Map<string, MemberWorkSyncStatus>();
    const legacyStatusFiles = await readArchiveFiles(
      this.paths.getLegacyStatusPath(teamName),
      isLegacyStatusFile,
      { schemaVersion: 1, members: {}, metrics: { recentEvents: [] } }
    );
    for (const legacyStatus of legacyStatusFiles) {
      for (const [memberKey, status] of Object.entries(legacyStatus.members)) {
        if (normalizeTeamKey(status.teamName) !== teamKey) {
          continue;
        }
        mergeImportedStatus(
          statuses,
          normalizeMemberKey(status.memberName) || normalizeMemberKey(memberKey),
          status
        );
      }
    }
    for (const memberName of memberNames) {
      const memberStatusFiles = await readArchiveFiles<MemberStatusFile | null>(
        this.paths.getMemberStatusPath(teamName, memberName),
        (value): value is MemberStatusFile | null => isMemberStatusFile(value),
        null
      );
      for (const memberStatus of memberStatusFiles) {
        if (memberStatus && normalizeTeamKey(memberStatus.status.teamName) === teamKey) {
          mergeImportedStatus(
            statuses,
            normalizeMemberKey(memberStatus.status.memberName),
            memberStatus.status
          );
        }
      }
    }

    const reportIntents = new Map<string, MemberWorkSyncReportIntent>();
    for (const legacyReports of await readArchiveFiles(
      this.paths.getLegacyPendingReportsPath(teamName),
      isLegacyPendingReportFile,
      { schemaVersion: 1, intents: {} }
    )) {
      for (const intent of Object.values(legacyReports.intents)) {
        if (isReportIntentOwnedBy(teamName, intent.memberName, intent)) {
          const current = reportIntents.get(intent.id);
          reportIntents.set(intent.id, current ? pickDomainReportIntent(current, intent) : intent);
        }
      }
    }
    for (const memberName of memberNames) {
      for (const memberReports of await readArchiveFiles(
        this.paths.getMemberReportsPath(teamName, memberName),
        isMemberReportsFile,
        { schemaVersion: 2, intents: {} }
      )) {
        for (const intent of Object.values(memberReports.intents)) {
          if (isReportIntentOwnedBy(teamName, memberName, intent)) {
            const current = reportIntents.get(intent.id);
            reportIntents.set(
              intent.id,
              current ? pickDomainReportIntent(current, intent) : intent
            );
          }
        }
      }
    }

    const outboxItems = new Map<string, MemberWorkSyncOutboxItem>();
    for (const legacyOutbox of await readArchiveFiles(
      this.paths.getLegacyOutboxPath(teamName),
      isLegacyOutboxFile,
      { schemaVersion: 1, items: {} }
    )) {
      for (const item of Object.values(legacyOutbox.items)) {
        if (isOutboxItemOwnedBy(teamName, item.memberName, item)) {
          const current = outboxItems.get(item.id);
          outboxItems.set(item.id, current ? pickDomainOutboxItem(current, item) : item);
        }
      }
    }
    for (const memberName of memberNames) {
      for (const memberOutbox of await readArchiveFiles(
        this.paths.getMemberOutboxPath(teamName, memberName),
        isMemberOutboxFile,
        { schemaVersion: 2, items: {} }
      )) {
        for (const item of Object.values(memberOutbox.items)) {
          if (isOutboxItemOwnedBy(teamName, memberName, item)) {
            const current = outboxItems.get(item.id);
            outboxItems.set(item.id, current ? pickDomainOutboxItem(current, item) : item);
          }
        }
      }
    }

    const metricEvents = new Map<string, MemberWorkSyncMetricEvent>();
    for (const legacyStatus of legacyStatusFiles) {
      for (const event of legacyStatus.metrics?.recentEvents ?? []) {
        if (normalizeTeamKey(event.teamName) === teamKey) {
          metricEvents.set(event.id, event);
        }
      }
    }
    for (const metricsIndex of await readArchiveFiles(
      this.paths.getMetricsIndexPath(teamName),
      isMetricsIndexFile,
      emptyMetricsIndex()
    )) {
      for (const event of metricsIndex.recentEvents) {
        if (normalizeTeamKey(event.teamName) === teamKey) {
          metricEvents.set(event.id, event);
        }
      }
    }

    // The routing indexes are archived with the payload files. They do not
    // contain complete records, but their presence still constitutes an
    // archived snapshot (including a legitimately empty one).
    await archivePaths(this.paths.getOutboxIndexPath(teamName));
    await archivePaths(this.paths.getPendingReportsIndexPath(teamName));

    if (archiveCount === 0) {
      return null;
    }
    return {
      statuses: [...statuses.values()],
      reportIntents: [...reportIntents.values()],
      outboxItems: [...outboxItems.values()],
      metricEvents: [...metricEvents.values()],
      filesToArchive: [],
    };
  }

  private async readLegacyStatusFile(teamName: string): Promise<LegacyStatusFile> {
    return readMemberWorkSyncSafetyJson(
      this.paths.getLegacyStatusPath(teamName),
      isLegacyStatusFile,
      { schemaVersion: 1, members: {}, metrics: { recentEvents: [] } }
    );
  }

  private async readMemberStatusFile(
    teamName: string,
    memberName: string
  ): Promise<MemberStatusFile | null> {
    return readMemberWorkSyncSafetyJson<MemberStatusFile | null>(
      this.paths.getMemberStatusPath(teamName, memberName),
      (value): value is MemberStatusFile | null => isMemberStatusFile(value),
      null
    );
  }

  private async writeMemberStatusFile(status: MemberWorkSyncStatus): Promise<void> {
    await writeJsonFile(
      this.paths.getMemberStatusPath(status.teamName, status.memberName),
      {
        schemaVersion: 2,
        status,
      } satisfies MemberStatusFile,
      this.sourceWriteOptions(status.teamName)
    );
  }

  private async readMetricsIndexFile(teamName: string): Promise<MetricsIndexFile> {
    return readJsonFile(
      this.paths.getMetricsIndexPath(teamName),
      isMetricsIndexFile,
      emptyMetricsIndex(),
      {
        quarantineInvalid: true,
        strict: this.deps.strictIndexReads,
      }
    );
  }

  private async writeMetricsIndexFile(teamName: string, file: MetricsIndexFile): Promise<void> {
    await writeJsonFile(
      this.paths.getMetricsIndexPath(teamName),
      file,
      this.sourceWriteOptions(teamName)
    );
  }

  private async readLegacyPendingFile(teamName: string): Promise<LegacyPendingReportFile> {
    return readMemberWorkSyncSafetyJson(
      this.paths.getLegacyPendingReportsPath(teamName),
      isLegacyPendingReportFile,
      { schemaVersion: 1, intents: {} }
    );
  }

  private async readMemberReportsFile(
    teamName: string,
    memberName: string
  ): Promise<MemberReportsFile> {
    return readMemberWorkSyncSafetyJson(
      this.paths.getMemberReportsPath(teamName, memberName),
      isMemberReportsFile,
      { schemaVersion: 2, intents: {} }
    );
  }

  private async writeMemberReportsFile(
    teamName: string,
    memberName: string,
    file: MemberReportsFile
  ): Promise<void> {
    await this.paths.ensureMemberWorkSyncDir(teamName, memberName);
    await writeJsonFile(
      this.paths.getMemberReportsPath(teamName, memberName),
      file,
      this.sourceWriteOptions(teamName)
    );
  }

  private async readPendingReportsIndexFile(teamName: string): Promise<PendingReportsIndexFile> {
    return readJsonFile(
      this.paths.getPendingReportsIndexPath(teamName),
      isPendingReportsIndexFile,
      { schemaVersion: 2, items: {} },
      { quarantineInvalid: true, strict: this.deps.strictIndexReads }
    );
  }

  private async writePendingReportsIndexFile(
    teamName: string,
    file: PendingReportsIndexFile
  ): Promise<void> {
    await writeJsonFile(
      this.paths.getPendingReportsIndexPath(teamName),
      file,
      this.sourceWriteOptions(teamName)
    );
  }

  private async readLegacyOutboxFile(teamName: string): Promise<LegacyOutboxFile> {
    return readMemberWorkSyncSafetyJson(
      this.paths.getLegacyOutboxPath(teamName),
      isLegacyOutboxFile,
      { schemaVersion: 1, items: {} }
    );
  }

  private async readMemberOutboxFile(
    teamName: string,
    memberName: string
  ): Promise<MemberOutboxFile> {
    return readMemberWorkSyncSafetyJson(
      this.paths.getMemberOutboxPath(teamName, memberName),
      isMemberOutboxFile,
      { schemaVersion: 2, items: {} }
    );
  }

  private async writeMemberOutboxFile(
    teamName: string,
    memberName: string,
    file: MemberOutboxFile
  ): Promise<void> {
    await this.paths.ensureMemberWorkSyncDir(teamName, memberName);
    await writeJsonFile(
      this.paths.getMemberOutboxPath(teamName, memberName),
      file,
      this.sourceWriteOptions(teamName)
    );
  }

  private async readOutboxIndexFile(teamName: string): Promise<OutboxIndexFile> {
    return readJsonFile(
      this.paths.getOutboxIndexPath(teamName),
      isOutboxIndexFile,
      { schemaVersion: 2, items: {} },
      { quarantineInvalid: true, strict: this.deps.strictIndexReads }
    );
  }

  private async writeOutboxIndexFile(teamName: string, file: OutboxIndexFile): Promise<void> {
    await writeJsonFile(
      this.paths.getOutboxIndexPath(teamName),
      file,
      this.sourceWriteOptions(teamName)
    );
  }

  private async upsertOutboxIndexItem(
    teamName: string,
    item: MemberWorkSyncOutboxItem,
    memberKey: string
  ): Promise<void> {
    return this.outboxOperations.upsertOutboxIndexItem(teamName, item, memberKey);
  }

  private async updateOutboxItem(
    teamName: string,
    id: string,
    updater: (current: MemberWorkSyncOutboxItem | undefined) => MemberWorkSyncOutboxItem | undefined
  ): Promise<void> {
    return this.outboxOperations.updateOutboxItem(teamName, id, updater);
  }

  private async repairMetricsIndex(teamName: string): Promise<MetricsIndexFile | null> {
    let repaired: MetricsIndexFile | null = null;
    await this.enqueue(teamName, async () => {
      await withFileLock(this.paths.getMetricsIndexPath(teamName), async () => {
        const current = await this.readMetricsIndexFile(teamName);
        if (Object.keys(current.members).length > 0 || current.recentEvents.length > 0) {
          repaired = current;
          return;
        }

        const next = emptyMetricsIndex();
        const memberStatuses = await this.scanMemberStatuses(teamName);
        for (const status of memberStatuses) {
          updateMetricsMember(next, status, this.paths.getMemberKey(status.memberName));
        }
        const legacy = await this.readLegacyStatusFile(teamName);
        for (const status of Object.values(legacy.members)) {
          const memberKey = this.paths.getMemberKey(status.memberName);
          if (!next.members[memberKey]) {
            updateMetricsMember(next, status, memberKey);
          }
        }
        for (const event of legacy.metrics?.recentEvents ?? []) {
          if (!next.recentEvents.some((existing) => existing.id === event.id)) {
            next.recentEvents.push(event);
          }
        }
        next.recentEvents.sort((left, right) => left.recordedAt.localeCompare(right.recordedAt));
        next.recentEvents = next.recentEvents.slice(-200);
        if (Object.keys(next.members).length === 0 && next.recentEvents.length === 0) {
          repaired = null;
          return;
        }
        await this.writeMetricsIndexFile(teamName, next);
        repaired = next;
      });
    });

    const repairedIndex = repaired as MetricsIndexFile | null;
    if (!repairedIndex) {
      return null;
    }
    for (const member of Object.values(repairedIndex.members)) {
      await this.appendAudit({
        teamName,
        memberName: member.memberName,
        event: 'index_repaired',
        source: 'json_store',
        reason: 'metrics',
        agendaFingerprint: member.agendaFingerprint,
        state: member.state,
        actionableCount: member.actionableCount,
        ...(member.providerId ? { providerId: member.providerId } : {}),
      });
    }
    return repairedIndex;
  }

  private async repairPendingReportsIndex(teamName: string): Promise<PendingReportsIndexFile> {
    const index: PendingReportsIndexFile = { schemaVersion: 2, items: {} };
    const repairedMembers = new Set<string>();
    const legacyMembers = new Set<string>();
    for (const { memberName, reports } of await this.scanMemberReports(teamName)) {
      const memberKey = this.paths.getMemberKey(memberName);
      for (const intent of Object.values(reports.intents)) {
        if (!isReportIntentOwnedBy(teamName, memberName, intent)) {
          continue;
        }
        index.items[intent.id] = toPendingReportIndexItem(intent, memberKey);
        repairedMembers.add(intent.memberName);
      }
    }
    for (const intent of Object.values((await this.readLegacyPendingFile(teamName)).intents)) {
      if (!isReportIntentOwnedBy(teamName, intent.memberName, intent)) {
        continue;
      }
      const memberKey = this.paths.getMemberKey(intent.memberName);
      if (!index.items[intent.id]) {
        await withFileLock(
          this.paths.getMemberReportsPath(teamName, intent.memberName),
          async () => {
            const reports = await this.readMemberReportsFile(teamName, intent.memberName);
            reports.intents[intent.id] = intent;
            await this.writeMemberReportsFile(teamName, intent.memberName, reports);
          }
        );
        index.items[intent.id] = toPendingReportIndexItem(intent, memberKey);
        repairedMembers.add(intent.memberName);
        legacyMembers.add(intent.memberName);
      }
    }
    await this.writePendingReportsIndexFile(teamName, index);
    for (const memberName of repairedMembers) {
      await this.appendAudit({
        teamName,
        memberName,
        event: 'index_repaired',
        source: 'json_store',
        reason: 'pending_reports',
      });
    }
    for (const memberName of legacyMembers) {
      await this.appendAudit({
        teamName,
        memberName,
        event: 'legacy_fallback_used',
        source: 'json_store',
        reason: 'pending_reports_v1',
      });
    }
    return index;
  }

  private async repairOutboxIndex(teamName: string): Promise<OutboxIndexFile> {
    return this.outboxOperations.repairOutboxIndex(teamName);
  }

  private scanMemberNames(teamName: string): Promise<string[]> {
    return scanMemberWorkSyncNames(this.paths, teamName);
  }

  /**
   * Import recovery cannot depend on member.meta.json surviving. Discover
   * canonical member directories that contain an exact live or pre-SQLite
   * status/report/outbox generation, while keeping ordinary index repair on
   * the stricter metadata-backed scan above.
   */
  private async scanMemberNamesForImport(teamName: string): Promise<string[]> {
    const memberNamesByKey = new Map<string, string>();
    const addMemberName = (memberName: string): void => {
      const canonicalName = memberName.trim();
      if (!canonicalName) {
        return;
      }
      const memberKey = this.paths.getMemberKey(canonicalName);
      if (!memberNamesByKey.has(memberKey)) {
        memberNamesByKey.set(memberKey, canonicalName);
      }
    };

    for (const memberName of await this.scanMemberNames(teamName)) {
      addMemberName(memberName);
    }

    const membersDir = join(this.paths.getTeamRootDir(teamName), 'members');
    const entries = await readdir(membersDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || memberNamesByKey.has(entry.name)) {
        continue;
      }
      let memberName: string;
      try {
        memberName = decodeURIComponent(entry.name);
      } catch {
        continue;
      }
      if (!normalizeMemberKey(memberName) || this.paths.getMemberKey(memberName) !== entry.name) {
        continue;
      }
      if (await this.hasMemberSnapshotFileForImport(teamName, memberName)) {
        addMemberName(memberName);
      }
    }
    return [...memberNamesByKey.values()];
  }

  private async hasMemberSnapshotFileForImport(
    teamName: string,
    memberName: string
  ): Promise<boolean> {
    const filePaths = [
      this.paths.getMemberStatusPath(teamName, memberName),
      this.paths.getMemberReportsPath(teamName, memberName),
      this.paths.getMemberOutboxPath(teamName, memberName),
    ];
    for (const filePath of filePaths) {
      try {
        await access(filePath);
        return true;
      } catch {
        // An absent live file can still have immutable archive generations.
      }
      if ((await listPreSqliteArchiveGenerations(filePath)).length > 0) {
        return true;
      }
    }
    return false;
  }

  private async scanMemberStatuses(teamName: string): Promise<MemberWorkSyncStatus[]> {
    const statuses: MemberWorkSyncStatus[] = [];
    for (const memberName of await this.scanMemberNames(teamName)) {
      const file = await this.readMemberStatusFile(teamName, memberName);
      if (file) {
        statuses.push(file.status);
      }
    }
    return statuses;
  }

  private async scanMemberReports(
    teamName: string
  ): Promise<{ memberName: string; reports: MemberReportsFile }[]> {
    const reports: { memberName: string; reports: MemberReportsFile }[] = [];
    for (const memberName of await this.scanMemberNames(teamName)) {
      reports.push({ memberName, reports: await this.readMemberReportsFile(teamName, memberName) });
    }
    return reports;
  }

  private async hasUnindexedOrStaleIndexedPendingReport(
    teamName: string,
    index: PendingReportsIndexFile
  ): Promise<boolean> {
    const routes = index.items;
    for (const { memberName, reports } of await this.scanMemberReports(teamName)) {
      for (const intent of Object.values(reports.intents)) {
        if (!isReportIntentOwnedBy(teamName, memberName, intent)) {
          continue;
        }
        const route = routes[intent.id];
        if (
          intent.status === 'pending' &&
          !this.isCurrentPendingReportRoute(teamName, route, intent)
        ) {
          return true;
        }
      }
    }
    for (const intent of Object.values((await this.readLegacyPendingFile(teamName)).intents)) {
      if (!isReportIntentOwnedBy(teamName, intent.memberName, intent)) {
        continue;
      }
      const route = routes[intent.id];
      if (
        intent.status === 'pending' &&
        !this.isCurrentPendingReportRoute(teamName, route, intent)
      ) {
        return true;
      }
    }
    return false;
  }

  private isCurrentPendingReportRoute(
    teamName: string,
    route: PendingReportsIndexFile['items'][string] | undefined,
    intent: MemberWorkSyncReportIntent
  ): boolean {
    return (
      !!route &&
      normalizeTeamKey(intent.teamName) === normalizeTeamKey(teamName) &&
      route.status === 'pending' &&
      normalizeMemberKey(route.memberName) === normalizeMemberKey(intent.memberName) &&
      route.memberKey === this.paths.getMemberKey(intent.memberName)
    );
  }

  private async scanMemberOutboxes(
    teamName: string
  ): Promise<{ memberName: string; outbox: MemberOutboxFile }[]> {
    return this.outboxOperations.scanMemberOutboxes(teamName);
  }

  private async hasUnindexedOrStaleIndexedDueOutboxItem(
    teamName: string,
    index: OutboxIndexFile,
    nowIso: string
  ): Promise<boolean> {
    return this.outboxOperations.hasUnindexedOrStaleIndexedDueOutboxItem(teamName, index, nowIso);
  }

  private isCurrentDueOutboxRoute(
    teamName: string,
    route: OutboxIndexRoute | undefined,
    item: MemberWorkSyncOutboxItem,
    nowIso: string
  ): boolean {
    return this.outboxOperations.isCurrentDueOutboxRoute(teamName, route, item, nowIso);
  }

  private async appendAudit(input: {
    teamName: string;
    memberName: string;
    event: 'status_written' | 'legacy_fallback_used' | 'index_repaired';
    source: string;
    agendaFingerprint?: string;
    state?: string;
    actionableCount?: number;
    reason?: string;
    triggerReasons?: string[];
    providerId?: string;
  }): Promise<void> {
    if (!this.deps.auditJournal) {
      return;
    }
    try {
      await this.deps.auditJournal.append({
        ...input,
        timestamp: this.now().toISOString(),
      });
    } catch (error) {
      this.deps.logger?.warn('member work sync store audit append failed', {
        teamName: input.teamName,
        memberName: input.memberName,
        event: input.event,
        error: String(error),
      });
    }
  }

  private sourceWriteOptions(teamName: string) {
    const admission = this.deps.sourceWriteAdmission?.current(teamName);
    return admission ? { assertCurrent: admission.assertCurrent } : {};
  }

  private enqueue(teamName: string, operation: () => Promise<void>): Promise<void> {
    const admission = this.deps.sourceWriteAdmission?.current(teamName);
    const write = () => this.writeQueue.enqueue(teamName, operation);
    return admission ? admission.publish(write) : write();
  }
}

function toPendingReportIndexItem(
  intent: MemberWorkSyncReportIntent,
  memberKey: string
): PendingReportsIndexFile['items'][string] {
  return {
    memberKey,
    memberName: intent.memberName,
    status: intent.status,
    recordedAt: intent.recordedAt,
    ...(intent.processedAt ? { processedAt: intent.processedAt } : {}),
  };
}
