import { listPreSqliteArchiveGenerations } from '@features/internal-storage/main';
import { withFileLock } from '@main/services/team/fileLock';
import { atomicWriteAsync, renamePathWithRetry } from '@main/utils/atomicWrite';
import { createHash } from 'crypto';
import { access, mkdir, readdir, readFile } from 'fs/promises';
import { dirname, join } from 'path';

import { assessMemberWorkSyncPhase2Readiness } from '../../core/domain';

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
  MemberWorkSyncReportIntent,
  MemberWorkSyncReportRequest,
  MemberWorkSyncStatus,
  MemberWorkSyncStatusState,
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
 * and metric events. Later duplicate identities win; missing identities are not
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

interface MemberStatusFile {
  schemaVersion: 2;
  status: MemberWorkSyncStatus;
}

export interface MetricsIndexMember {
  memberName: string;
  state: MemberWorkSyncStatusState;
  agendaFingerprint: string;
  actionableCount: number;
  evaluatedAt: string;
  providerId?: string;
}

export interface MetricsIndexFile {
  schemaVersion: 2;
  members: Record<string, MetricsIndexMember>;
  recentEvents: MemberWorkSyncMetricEvent[];
}

interface LegacyPendingReportFile {
  schemaVersion: 1;
  intents: Record<string, MemberWorkSyncReportIntent>;
}

interface MemberReportsFile {
  schemaVersion: 2;
  intents: Record<string, MemberWorkSyncReportIntent>;
}

interface PendingReportsIndexFile {
  schemaVersion: 2;
  items: Record<
    string,
    {
      memberKey: string;
      memberName: string;
      status: MemberWorkSyncReportIntent['status'];
      recordedAt: string;
      processedAt?: string;
    }
  >;
}

interface LegacyOutboxFile {
  schemaVersion: 1;
  items: Record<string, MemberWorkSyncOutboxItem>;
}

interface MemberOutboxFile {
  schemaVersion: 2;
  items: Record<string, MemberWorkSyncOutboxItem>;
}

interface OutboxIndexFile {
  schemaVersion: 2;
  items: Record<
    string,
    {
      memberKey: string;
      memberName: string;
      status: MemberWorkSyncOutboxItem['status'];
      nextAttemptAt?: string;
      updatedAt: string;
      createdAt: string;
    }
  >;
}

type OutboxIndexRoute = OutboxIndexFile['items'][string];
type OutboxDueRoute = [string, OutboxIndexRoute];
const MEMBER_WORK_SYNC_OUTBOX_CLAIM_STALE_MS = 5 * 60 * 1000;

export interface JsonMemberWorkSyncStoreDeps {
  auditJournal?: MemberWorkSyncAuditJournalPort;
  logger?: MemberWorkSyncLoggerPort;
  now?: () => Date;
}

export function normalizeMemberKey(memberName: unknown): string {
  return typeof memberName === 'string' ? memberName.trim().toLowerCase() : '';
}

export function normalizeTeamKey(teamName: unknown): string {
  return typeof teamName === 'string' ? teamName.trim().toLowerCase() : '';
}

function emptyMetricsIndex(): MetricsIndexFile {
  return { schemaVersion: 2, members: {}, recentEvents: [] };
}

function emptyStateCounts(): Record<MemberWorkSyncStatusState, number> {
  return {
    caught_up: 0,
    needs_sync: 0,
    still_working: 0,
    blocked: 0,
    inactive: 0,
    unknown: 0,
  };
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

function isMemberStatusFile(value: unknown): value is MemberStatusFile {
  return (
    value != null &&
    typeof value === 'object' &&
    (value as MemberStatusFile).schemaVersion === 2 &&
    (value as MemberStatusFile).status != null &&
    typeof (value as MemberStatusFile).status === 'object'
  );
}

function isMetricsIndexFile(value: unknown): value is MetricsIndexFile {
  return (
    value != null &&
    typeof value === 'object' &&
    (value as MetricsIndexFile).schemaVersion === 2 &&
    (value as MetricsIndexFile).members != null &&
    typeof (value as MetricsIndexFile).members === 'object' &&
    Array.isArray((value as MetricsIndexFile).recentEvents)
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

function isPendingReportsIndexFile(value: unknown): value is PendingReportsIndexFile {
  return (
    value != null &&
    typeof value === 'object' &&
    (value as PendingReportsIndexFile).schemaVersion === 2 &&
    (value as PendingReportsIndexFile).items != null &&
    typeof (value as PendingReportsIndexFile).items === 'object' &&
    !Array.isArray((value as PendingReportsIndexFile).items)
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

function isMemberOutboxFile(value: unknown): value is MemberOutboxFile {
  return (
    value != null &&
    typeof value === 'object' &&
    (value as MemberOutboxFile).schemaVersion === 2 &&
    (value as MemberOutboxFile).items != null &&
    typeof (value as MemberOutboxFile).items === 'object' &&
    !Array.isArray((value as MemberOutboxFile).items)
  );
}

function isOutboxIndexFile(value: unknown): value is OutboxIndexFile {
  return (
    value != null &&
    typeof value === 'object' &&
    (value as OutboxIndexFile).schemaVersion === 2 &&
    (value as OutboxIndexFile).items != null &&
    typeof (value as OutboxIndexFile).items === 'object' &&
    !Array.isArray((value as OutboxIndexFile).items)
  );
}

function isOutboxTerminal(status: MemberWorkSyncOutboxItem['status']): boolean {
  return status === 'delivered' || status === 'superseded' || status === 'failed_terminal';
}

function canReviveOutboxItem(status: MemberWorkSyncOutboxItem['status']): boolean {
  return status === 'superseded' || (!isOutboxTerminal(status) && status !== 'pending');
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

function isOutboxItemOwnedBy(
  teamName: string,
  memberName: string,
  item: MemberWorkSyncOutboxItem
): boolean {
  return (
    normalizeTeamKey(item.teamName) === normalizeTeamKey(teamName) &&
    normalizeMemberKey(item.memberName) === normalizeMemberKey(memberName)
  );
}

function parseIsoMs(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function isStaleClaim(claimedAt: string | undefined, nowIso: string): boolean {
  const claimedAtMs = parseIsoMs(claimedAt);
  const nowMs = parseIsoMs(nowIso);
  return (
    claimedAtMs != null &&
    nowMs != null &&
    (claimedAtMs > nowMs || nowMs - claimedAtMs >= MEMBER_WORK_SYNC_OUTBOX_CLAIM_STALE_MS)
  );
}

function applyOptionalNextAttemptAt(
  item: MemberWorkSyncOutboxItem,
  nextAttemptAt: string | undefined
): void {
  if (nextAttemptAt) {
    item.nextAttemptAt = nextAttemptAt;
    return;
  }
  delete item.nextAttemptAt;
}

function isNextAttemptDue(nextAttemptAt: string | undefined, nowIso: string): boolean {
  if (!nextAttemptAt) {
    return true;
  }
  const nextAttemptAtMs = parseIsoMs(nextAttemptAt);
  if (nextAttemptAtMs == null) {
    return true;
  }
  const nowMs = parseIsoMs(nowIso);
  return nowMs != null && nextAttemptAtMs <= nowMs;
}

function canClaimOutboxItem(item: MemberWorkSyncOutboxItem, nowIso: string): boolean {
  if (item.status === 'claimed') {
    return isStaleClaim(item.claimedAt ?? item.updatedAt, nowIso);
  }
  if (item.status !== 'pending' && item.status !== 'failed_retryable') {
    return false;
  }
  return isNextAttemptDue(item.nextAttemptAt, nowIso);
}

function canClaimOutboxRoute(route: OutboxIndexRoute, nowIso: string): boolean {
  if (route.status === 'claimed') {
    return isStaleClaim(route.updatedAt, nowIso);
  }
  return (
    (route.status === 'pending' || route.status === 'failed_retryable') &&
    isNextAttemptDue(route.nextAttemptAt, nowIso)
  );
}

function getDueOutboxRoutes(
  index: OutboxIndexFile,
  nowIso: string,
  limit: number
): OutboxDueRoute[] {
  return Object.entries(index.items)
    .filter(([, route]) => canClaimOutboxRoute(route, nowIso))
    .sort((left, right) => {
      const leftTime = left[1].nextAttemptAt ?? left[1].updatedAt;
      const rightTime = right[1].nextAttemptAt ?? right[1].updatedAt;
      return leftTime.localeCompare(rightTime);
    })
    .slice(0, Math.max(0, limit));
}

function stableStringify(value: unknown): string {
  if (value == null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}

export function buildPendingReportIntentId(request: MemberWorkSyncReportRequest): string {
  const taskIds = [...new Set(request.taskIds ?? [])].sort();
  const payload = {
    teamName: request.teamName,
    memberName: normalizeMemberKey(request.memberName),
    state: request.state,
    agendaFingerprint: request.agendaFingerprint,
    reportToken: request.reportToken ?? '',
    ...(taskIds.length > 0 ? { taskIds } : {}),
    ...(request.note ? { note: request.note } : {}),
    ...(request.leaseTtlMs ? { leaseTtlMs: request.leaseTtlMs } : {}),
    ...(request.source ? { source: request.source } : {}),
  };
  return `member-work-sync-intent:${createHash('sha256')
    .update(stableStringify(payload))
    .digest('hex')}`;
}

function buildMetricEventId(status: MemberWorkSyncStatus, kind: MemberWorkSyncMetricEvent['kind']) {
  return `member-work-sync-metric:${createHash('sha256')
    .update(
      stableStringify({
        teamName: status.teamName,
        memberName: normalizeMemberKey(status.memberName),
        kind,
        state: status.state,
        agendaFingerprint: status.agenda.fingerprint,
        evaluatedAt: status.evaluatedAt,
        reportState: status.report?.state ?? '',
        rejectionCode: status.report?.rejectionCode ?? '',
      })
    )
    .digest('hex')}`;
}

export function buildMetricEvents(status: MemberWorkSyncStatus): MemberWorkSyncMetricEvent[] {
  const base = {
    teamName: status.teamName,
    memberName: status.memberName,
    state: status.state,
    agendaFingerprint: status.agenda.fingerprint,
    recordedAt: status.evaluatedAt,
    actionableCount: status.agenda.items.length,
    ...(status.providerId ? { providerId: status.providerId } : {}),
    ...(status.shadow?.previousFingerprint
      ? { previousFingerprint: status.shadow.previousFingerprint }
      : {}),
    ...(status.shadow?.triggerReasons?.length
      ? { triggerReasons: [...status.shadow.triggerReasons] }
      : {}),
    ...(status.report?.state ? { reportState: status.report.state } : {}),
    ...(status.report?.rejectionCode ? { rejectionCode: status.report.rejectionCode } : {}),
  };
  const events: MemberWorkSyncMetricEvent[] = [
    {
      ...base,
      id: buildMetricEventId(status, 'status_evaluated'),
      kind: 'status_evaluated',
    },
  ];
  if (status.shadow?.wouldNudge) {
    events.push({
      ...base,
      id: buildMetricEventId(status, 'would_nudge'),
      kind: 'would_nudge',
    });
  }
  if (status.shadow?.fingerprintChanged) {
    events.push({
      ...base,
      id: buildMetricEventId(status, 'fingerprint_changed'),
      kind: 'fingerprint_changed',
    });
  }
  if (status.report?.accepted) {
    events.push({
      ...base,
      id: buildMetricEventId(status, 'report_accepted'),
      kind: 'report_accepted',
    });
  } else if (status.report?.rejectionCode) {
    events.push({
      ...base,
      id: buildMetricEventId(status, 'report_rejected'),
      kind: 'report_rejected',
    });
  }
  return events;
}

function appendMetricEvents(file: MetricsIndexFile, status: MemberWorkSyncStatus): void {
  const byId = new Map(file.recentEvents.map((event) => [event.id, event]));
  for (const event of buildMetricEvents(status)) {
    byId.set(event.id, event);
  }
  file.recentEvents = [...byId.values()]
    .sort((left, right) => left.recordedAt.localeCompare(right.recordedAt))
    .slice(-200);
}

function updateMetricsMember(
  file: MetricsIndexFile,
  status: MemberWorkSyncStatus,
  memberKey: string
): void {
  file.members[memberKey] = {
    memberName: status.memberName,
    state: status.state,
    agendaFingerprint: status.agenda.fingerprint,
    actionableCount: status.agenda.items.length,
    evaluatedAt: status.evaluatedAt,
    ...(status.providerId ? { providerId: status.providerId } : {}),
  };
  appendMetricEvents(file, status);
}

export function toMetrics(teamName: string, file: MetricsIndexFile): MemberWorkSyncTeamMetrics {
  const stateCounts = emptyStateCounts();
  const members = Object.values(file.members);
  let actionableItemCount = 0;
  for (const member of members) {
    stateCounts[member.state] += 1;
    actionableItemCount += member.actionableCount;
  }
  const recentEvents = [...file.recentEvents].sort((left, right) =>
    left.recordedAt.localeCompare(right.recordedAt)
  );
  const metrics = {
    teamName,
    generatedAt: new Date().toISOString(),
    memberCount: members.length,
    stateCounts,
    actionableItemCount,
    wouldNudgeCount: recentEvents.filter((event) => event.kind === 'would_nudge').length,
    fingerprintChangeCount: recentEvents.filter((event) => event.kind === 'fingerprint_changed')
      .length,
    reportAcceptedCount: recentEvents.filter((event) => event.kind === 'report_accepted').length,
    reportRejectedCount: recentEvents.filter((event) => event.kind === 'report_rejected').length,
    recentEvents,
  };
  return {
    ...metrics,
    phase2Readiness: assessMemberWorkSyncPhase2Readiness({
      memberCount: metrics.memberCount,
      recentEvents: metrics.recentEvents,
    }),
  };
}

async function quarantineFile(filePath: string): Promise<void> {
  try {
    await renamePathWithRetry(filePath, `${filePath}.invalid.${Date.now()}`);
  } catch {
    // If quarantine fails, keep the feature degraded but do not block team operation.
  }
}

async function readJsonFile<T>(
  filePath: string,
  guard: (value: unknown) => value is T,
  fallback: T,
  options: { quarantineInvalid?: boolean } = {}
): Promise<T> {
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (guard(parsed)) {
      return parsed;
    }
    if (options.quarantineInvalid) {
      await quarantineFile(filePath);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && options.quarantineInvalid) {
      await quarantineFile(filePath);
    }
  }
  return fallback;
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await atomicWriteAsync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export class JsonMemberWorkSyncStore
  implements
    MemberWorkSyncStatusStorePort,
    MemberWorkSyncReportStorePort,
    MemberWorkSyncOutboxStorePort
{
  private readonly writeQueues = new Map<string, Promise<void>>();
  private readonly now: () => Date;

  constructor(
    private readonly paths: MemberWorkSyncStorePaths,
    private readonly deps: JsonMemberWorkSyncStoreDeps = {}
  ) {
    this.now = deps.now ?? (() => new Date());
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

  async write(status: MemberWorkSyncStatus): Promise<void> {
    const memberKey = this.paths.getMemberKey(status.memberName);
    await this.paths.ensureMemberWorkSyncDir(status.teamName, status.memberName);
    await this.enqueue(status.teamName, async () => {
      await withFileLock(this.paths.getMetricsIndexPath(status.teamName), async () => {
        await withFileLock(
          this.paths.getMemberStatusPath(status.teamName, status.memberName),
          async () => {
            const metrics = await this.readMetricsIndexFile(status.teamName);
            updateMetricsMember(metrics, status, memberKey);
            await this.writeMemberStatusFile(status);
            await this.writeMetricsIndexFile(status.teamName, metrics);
          }
        );
      });
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
            const reports = await this.readMemberReportsFile(request.teamName, request.memberName);
            const current = reports.intents[id];
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
    let result: MemberWorkSyncOutboxEnsureResult | null = null;
    const memberKey = this.paths.getMemberKey(input.memberName);
    await this.paths.ensureMemberWorkSyncDir(input.teamName, input.memberName);
    await this.enqueue(input.teamName, async () => {
      await withFileLock(this.paths.getOutboxIndexPath(input.teamName), async () => {
        await withFileLock(
          this.paths.getMemberOutboxPath(input.teamName, input.memberName),
          async () => {
            const outbox = await this.readMemberOutboxFile(input.teamName, input.memberName);
            const current = outbox.items[input.id];
            if (current) {
              if (current.payloadHash !== input.payloadHash) {
                if (current.status !== 'delivered' && current.status !== 'failed_terminal') {
                  const next: MemberWorkSyncOutboxItem = {
                    ...current,
                    agendaFingerprint: input.agendaFingerprint,
                    payloadHash: input.payloadHash,
                    payload: input.payload,
                    status: 'pending',
                    attemptGeneration:
                      current.status === 'claimed'
                        ? current.attemptGeneration + 1
                        : current.attemptGeneration,
                    updatedAt: input.nowIso,
                  };
                  applyOptionalNextAttemptAt(next, input.nextAttemptAt);
                  delete next.claimedBy;
                  delete next.claimedAt;
                  delete next.lastError;
                  outbox.items[input.id] = next;
                  await this.writeMemberOutboxFile(input.teamName, input.memberName, outbox);
                  await this.upsertOutboxIndexItem(input.teamName, next, memberKey);
                  result = { ok: true, outcome: 'existing', item: next };
                  return;
                }
                result = {
                  ok: false,
                  outcome: 'payload_conflict',
                  item: current,
                  existingPayloadHash: current.payloadHash,
                  requestedPayloadHash: input.payloadHash,
                };
                return;
              }

              if (canReviveOutboxItem(current.status)) {
                const next: MemberWorkSyncOutboxItem = {
                  ...current,
                  status: 'pending',
                  updatedAt: input.nowIso,
                };
                applyOptionalNextAttemptAt(next, input.nextAttemptAt);
                delete next.claimedBy;
                delete next.claimedAt;
                delete next.lastError;
                outbox.items[input.id] = next;
                await this.writeMemberOutboxFile(input.teamName, input.memberName, outbox);
                await this.upsertOutboxIndexItem(input.teamName, next, memberKey);
                result = { ok: true, outcome: 'existing', item: next };
                return;
              }

              await this.upsertOutboxIndexItem(input.teamName, current, memberKey);
              result = { ok: true, outcome: 'existing', item: current };
              return;
            }

            const item: MemberWorkSyncOutboxItem = {
              id: input.id,
              teamName: input.teamName,
              memberName: input.memberName,
              agendaFingerprint: input.agendaFingerprint,
              payloadHash: input.payloadHash,
              payload: input.payload,
              status: 'pending',
              attemptGeneration: 0,
              ...(input.nextAttemptAt ? { nextAttemptAt: input.nextAttemptAt } : {}),
              createdAt: input.nowIso,
              updatedAt: input.nowIso,
            };
            outbox.items[input.id] = item;
            await this.writeMemberOutboxFile(input.teamName, input.memberName, outbox);
            await this.upsertOutboxIndexItem(input.teamName, item, memberKey);
            result = { ok: true, outcome: 'created', item };
          }
        );
      });
    });

    if (!result) {
      throw new Error('Member work sync outbox write did not produce a result');
    }
    return result;
  }

  async claimDue(input: MemberWorkSyncOutboxClaimInput): Promise<MemberWorkSyncOutboxItem[]> {
    const claimed: MemberWorkSyncOutboxItem[] = [];
    await this.enqueue(input.teamName, async () => {
      await withFileLock(this.paths.getOutboxIndexPath(input.teamName), async () => {
        let index = await this.readOutboxIndexFile(input.teamName);
        if (Object.keys(index.items).length === 0) {
          index = await this.repairOutboxIndex(input.teamName);
        }
        let dueRoutes = getDueOutboxRoutes(index, input.nowIso, input.limit);
        if (
          dueRoutes.length < Math.max(0, input.limit) &&
          (await this.hasUnindexedOrStaleIndexedDueOutboxItem(input.teamName, index, input.nowIso))
        ) {
          index = await this.repairOutboxIndex(input.teamName);
          dueRoutes = getDueOutboxRoutes(index, input.nowIso, input.limit);
        }

        const claimRoutes = async (routes: OutboxDueRoute[]): Promise<boolean> => {
          let staleIndex = false;
          for (const [id, route] of routes) {
            if (claimed.length >= Math.max(0, input.limit)) {
              break;
            }
            await withFileLock(
              this.paths.getMemberOutboxPath(input.teamName, route.memberName),
              async () => {
                const outbox = await this.readMemberOutboxFile(input.teamName, route.memberName);
                const item = outbox.items[id];
                if (!item || !canClaimOutboxItem(item, input.nowIso)) {
                  delete index.items[id];
                  staleIndex = true;
                  return;
                }
                const memberKey = this.paths.getMemberKey(item.memberName);
                if (!isOutboxItemOwnedBy(input.teamName, route.memberName, item)) {
                  delete index.items[id];
                  staleIndex = true;
                  return;
                }
                const next: MemberWorkSyncOutboxItem = {
                  ...item,
                  status: 'claimed',
                  attemptGeneration: item.attemptGeneration + 1,
                  claimedBy: input.claimedBy,
                  claimedAt: input.nowIso,
                  updatedAt: input.nowIso,
                };
                delete next.nextAttemptAt;
                delete next.lastError;
                outbox.items[id] = next;
                await this.writeMemberOutboxFile(input.teamName, route.memberName, outbox);
                index.items[id] = toOutboxIndexItem(next, memberKey);
                claimed.push(next);
              }
            );
          }
          return staleIndex;
        };

        let staleIndex = await claimRoutes(dueRoutes);
        if (staleIndex) {
          index = await this.repairOutboxIndex(input.teamName);
          const remainingLimit = Math.max(0, input.limit) - claimed.length;
          dueRoutes =
            remainingLimit > 0 ? getDueOutboxRoutes(index, input.nowIso, remainingLimit) : [];
          staleIndex = dueRoutes.length > 0 ? await claimRoutes(dueRoutes) : false;
          if (staleIndex) {
            await this.repairOutboxIndex(input.teamName);
          } else if (dueRoutes.length > 0) {
            await this.writeOutboxIndexFile(input.teamName, index);
          }
        } else if (dueRoutes.length > 0) {
          await this.writeOutboxIndexFile(input.teamName, index);
        }
      });
    });
    return claimed;
  }

  async markDelivered(input: MemberWorkSyncOutboxMarkDeliveredInput): Promise<void> {
    await this.updateOutboxItem(input.teamName, input.id, (current) => {
      if (current?.attemptGeneration !== input.attemptGeneration || current.status !== 'claimed') {
        return current;
      }
      const next: MemberWorkSyncOutboxItem = {
        ...current,
        status: 'delivered',
        deliveredMessageId: input.deliveredMessageId,
        ...(input.deliveryState ? { deliveryState: input.deliveryState } : {}),
        ...(input.deliveryDiagnostics?.length
          ? { deliveryDiagnostics: input.deliveryDiagnostics }
          : {}),
        updatedAt: input.nowIso,
      };
      delete next.lastError;
      delete next.nextAttemptAt;
      return next;
    });
  }

  async markSuperseded(input: MemberWorkSyncOutboxMarkSupersededInput): Promise<void> {
    await this.updateOutboxItem(input.teamName, input.id, (current) => {
      if (!current || isOutboxTerminal(current.status)) {
        return current;
      }
      return {
        ...current,
        status: 'superseded',
        lastError: input.reason,
        updatedAt: input.nowIso,
      };
    });
  }

  async markFailed(input: MemberWorkSyncOutboxMarkFailedInput): Promise<void> {
    await this.updateOutboxItem(input.teamName, input.id, (current) => {
      // Only the in-flight claim may record a failure. If the item was revived to
      // 'pending' (same attemptGeneration) while delivery was in flight, a late
      // failure must NOT clobber the revived work. Mirrors markDelivered and the
      // SQLite worker guard (memberWorkSyncWorkerOps.markFailed).
      if (current?.attemptGeneration !== input.attemptGeneration || current.status !== 'claimed') {
        return current;
      }
      const next: MemberWorkSyncOutboxItem = {
        ...current,
        status: input.retryable ? 'failed_retryable' : 'failed_terminal',
        lastError: input.error,
        ...(input.retryable && input.nextAttemptAt ? { nextAttemptAt: input.nextAttemptAt } : {}),
        updatedAt: input.nowIso,
      };
      if (!input.retryable) {
        delete next.nextAttemptAt;
      }
      return next;
    });
  }

  async countRecentDelivered(
    input: MemberWorkSyncOutboxCountRecentDeliveredInput
  ): Promise<number> {
    const workSyncIntentKeyPrefix = input.workSyncIntentKeyPrefix?.trim();
    if (workSyncIntentKeyPrefix) {
      const memberOutbox = await this.readMemberOutboxFile(input.teamName, input.memberName);
      return Object.values(memberOutbox.items).filter(
        (item) =>
          item.status === 'delivered' &&
          item.updatedAt >= input.sinceIso &&
          item.payload.workSyncIntentKey?.startsWith(workSyncIntentKeyPrefix) === true
      ).length;
    }

    let index = await this.readOutboxIndexFile(input.teamName);
    if (Object.keys(index.items).length === 0) {
      await this.enqueue(input.teamName, async () => {
        await withFileLock(this.paths.getOutboxIndexPath(input.teamName), async () => {
          index = await this.readOutboxIndexFile(input.teamName);
          if (Object.keys(index.items).length === 0) {
            index = await this.repairOutboxIndex(input.teamName);
          }
        });
      });
    }
    const indexedCount = Object.values(index.items).filter(
      (item) =>
        normalizeMemberKey(item.memberName) === normalizeMemberKey(input.memberName) &&
        item.status === 'delivered' &&
        item.updatedAt >= input.sinceIso
    ).length;
    const memberOutbox = await this.readMemberOutboxFile(input.teamName, input.memberName);
    const memberFileCount = Object.values(memberOutbox.items).filter(
      (item) => item.status === 'delivered' && item.updatedAt >= input.sinceIso
    ).length;
    if (memberFileCount > indexedCount) {
      await this.enqueue(input.teamName, async () => {
        await withFileLock(this.paths.getOutboxIndexPath(input.teamName), async () => {
          await this.repairOutboxIndex(input.teamName);
        });
      });
    }
    return Math.max(indexedCount, memberFileCount);
  }

  async countDeliveredForAgenda(
    input: MemberWorkSyncOutboxCountDeliveredForAgendaInput
  ): Promise<number> {
    const agendaFingerprint = input.agendaFingerprint.trim();
    if (!agendaFingerprint) {
      return 0;
    }

    const sinceIso = input.sinceIso?.trim();
    const memberKey = normalizeMemberKey(input.memberName);
    const memberOutbox = await this.readMemberOutboxFile(input.teamName, input.memberName);
    return Object.values(memberOutbox.items).filter(
      (item) =>
        normalizeMemberKey(item.memberName) === memberKey &&
        item.status === 'delivered' &&
        item.agendaFingerprint === agendaFingerprint &&
        (!sinceIso || item.updatedAt > sinceIso)
    ).length;
  }

  async findDeliveredReviewPickupRequestEventIds(input: {
    teamName: string;
    memberName: string;
    reviewRequestEventIds: string[];
  }): Promise<string[]> {
    const requested = new Set(input.reviewRequestEventIds.map((id) => id.trim()).filter(Boolean));
    if (requested.size === 0) {
      return [];
    }

    const memberOutbox = await this.readMemberOutboxFile(input.teamName, input.memberName);
    const delivered = new Set<string>();
    for (const item of Object.values(memberOutbox.items)) {
      if (item.status !== 'delivered' || item.payload.workSyncIntent !== 'review_pickup') {
        continue;
      }
      for (const eventId of item.payload.workSyncReviewRequestEventIds ?? []) {
        const normalized = eventId.trim();
        if (requested.has(normalized)) {
          delivered.add(normalized);
        }
      }
    }
    return [...delivered].sort();
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
    const intentKey = input.intentKey.trim();
    if (!intentKey) {
      return null;
    }

    const memberOutbox = await this.readMemberOutboxFile(input.teamName, input.memberName);
    const matches = Object.values(memberOutbox.items)
      .filter(
        (item) =>
          item.payload.workSyncIntentKey === intentKey &&
          item.updatedAt >= input.sinceIso &&
          item.status !== 'failed_terminal' &&
          item.status !== 'superseded'
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const latest = matches[0];
    if (!latest) {
      return null;
    }

    return {
      id: latest.id,
      status: latest.status,
      ...(latest.deliveredMessageId ? { deliveredMessageId: latest.deliveredMessageId } : {}),
      payloadHash: latest.payloadHash,
      updatedAt: latest.updatedAt,
    };
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
      const active = await this.readSnapshotForImportUnqueued(teamName);
      const snapshot = mergeDomainSnapshots(replica, active);

      const metrics: MetricsIndexFile = emptyMetricsIndex();
      for (const status of snapshot.statuses) {
        await this.paths.ensureMemberWorkSyncDir(teamName, status.memberName);
        await this.writeMemberStatusFile(status);
        metrics.members[normalizeMemberKey(status.memberName)] = {
          memberName: status.memberName,
          state: status.state,
          agendaFingerprint: status.agenda.fingerprint,
          actionableCount: status.agenda.items.length,
          evaluatedAt: status.evaluatedAt,
          ...(status.providerId ? { providerId: status.providerId } : {}),
        };
      }
      metrics.recentEvents = [...snapshot.metricEvents]
        .sort((left, right) =>
          left.recordedAt === right.recordedAt
            ? left.id.localeCompare(right.id)
            : left.recordedAt.localeCompare(right.recordedAt)
        )
        .slice(-200);
      await this.writeMetricsIndexFile(teamName, metrics);

      const reportsByMember = groupByMember(snapshot.reportIntents);
      const reportIndex: PendingReportsIndexFile = { schemaVersion: 2, items: {} };
      for (const intents of reportsByMember.values()) {
        const memberName = intents[0]?.memberName;
        if (!memberName) continue;
        const file: MemberReportsFile = { schemaVersion: 2, intents: {} };
        for (const intent of intents) {
          file.intents[intent.id] = intent;
          reportIndex.items[intent.id] = toPendingReportIndexItem(
            intent,
            normalizeMemberKey(memberName)
          );
        }
        await this.writeMemberReportsFile(teamName, memberName, file);
      }
      await this.writePendingReportsIndexFile(teamName, reportIndex);

      const outboxByMember = groupByMember(snapshot.outboxItems);
      const outboxIndex: OutboxIndexFile = { schemaVersion: 2, items: {} };
      for (const items of outboxByMember.values()) {
        const memberName = items[0]?.memberName;
        if (!memberName) continue;
        const file: MemberOutboxFile = { schemaVersion: 2, items: {} };
        for (const item of items) {
          file.items[item.id] = item;
          outboxIndex.items[item.id] = toOutboxIndexItem(item, normalizeMemberKey(memberName));
        }
        await this.writeMemberOutboxFile(teamName, memberName, file);
      }
      await this.writeOutboxIndexFile(teamName, outboxIndex);
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
      statuses.set(normalizeMemberKey(status.memberName), status);
    }
    const legacyStatus = await this.readLegacyStatusFile(teamName);
    for (const [memberKey, status] of Object.entries(legacyStatus.members)) {
      if (normalizeTeamKey(status.teamName) !== teamKey) {
        continue;
      }
      const key = normalizeMemberKey(status.memberName) || normalizeMemberKey(memberKey);
      if (!statuses.has(key)) {
        statuses.set(key, status);
      }
    }

    const reportIntents = new Map<string, MemberWorkSyncReportIntent>();
    for (const memberName of memberNames) {
      const reports = await this.readMemberReportsFile(teamName, memberName);
      for (const intent of Object.values(reports.intents)) {
        if (isReportIntentOwnedBy(teamName, memberName, intent)) {
          reportIntents.set(intent.id, intent);
        }
      }
    }
    for (const intent of Object.values((await this.readLegacyPendingFile(teamName)).intents)) {
      if (
        !reportIntents.has(intent.id) &&
        isReportIntentOwnedBy(teamName, intent.memberName, intent)
      ) {
        reportIntents.set(intent.id, intent);
      }
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
      if (!outboxItems.has(item.id) && isOutboxItemOwnedBy(teamName, item.memberName, item)) {
        outboxItems.set(item.id, item);
      }
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
        files.push(await readJsonFile(archivedPath, guard, fallback));
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
        statuses.set(
          normalizeMemberKey(status.memberName) || normalizeMemberKey(memberKey),
          status
        );
      }
    }
    for (const memberName of memberNames) {
      const memberStatusFiles = await readArchiveFiles<MemberStatusFile | null>(
        this.paths.getMemberStatusPath(teamName, memberName),
        (value): value is MemberStatusFile | null => value === null || isMemberStatusFile(value),
        null
      );
      for (const memberStatus of memberStatusFiles) {
        if (memberStatus && normalizeTeamKey(memberStatus.status.teamName) === teamKey) {
          statuses.set(normalizeMemberKey(memberStatus.status.memberName), memberStatus.status);
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
          reportIntents.set(intent.id, intent);
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
            reportIntents.set(intent.id, intent);
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
          outboxItems.set(item.id, item);
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
            outboxItems.set(item.id, item);
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
    return readJsonFile(
      this.paths.getLegacyStatusPath(teamName),
      isLegacyStatusFile,
      { schemaVersion: 1, members: {}, metrics: { recentEvents: [] } },
      { quarantineInvalid: true }
    );
  }

  private async readMemberStatusFile(
    teamName: string,
    memberName: string
  ): Promise<MemberStatusFile | null> {
    const file = await readJsonFile<MemberStatusFile | null>(
      this.paths.getMemberStatusPath(teamName, memberName),
      (value): value is MemberStatusFile | null => value === null || isMemberStatusFile(value),
      null,
      { quarantineInvalid: true }
    );
    return file;
  }

  private async writeMemberStatusFile(status: MemberWorkSyncStatus): Promise<void> {
    await writeJsonFile(this.paths.getMemberStatusPath(status.teamName, status.memberName), {
      schemaVersion: 2,
      status,
    } satisfies MemberStatusFile);
  }

  private async readMetricsIndexFile(teamName: string): Promise<MetricsIndexFile> {
    return readJsonFile(
      this.paths.getMetricsIndexPath(teamName),
      isMetricsIndexFile,
      emptyMetricsIndex(),
      {
        quarantineInvalid: true,
      }
    );
  }

  private async writeMetricsIndexFile(teamName: string, file: MetricsIndexFile): Promise<void> {
    await writeJsonFile(this.paths.getMetricsIndexPath(teamName), file);
  }

  private async readLegacyPendingFile(teamName: string): Promise<LegacyPendingReportFile> {
    return readJsonFile(
      this.paths.getLegacyPendingReportsPath(teamName),
      isLegacyPendingReportFile,
      { schemaVersion: 1, intents: {} },
      { quarantineInvalid: true }
    );
  }

  private async readMemberReportsFile(
    teamName: string,
    memberName: string
  ): Promise<MemberReportsFile> {
    return readJsonFile(
      this.paths.getMemberReportsPath(teamName, memberName),
      isMemberReportsFile,
      { schemaVersion: 2, intents: {} },
      { quarantineInvalid: true }
    );
  }

  private async writeMemberReportsFile(
    teamName: string,
    memberName: string,
    file: MemberReportsFile
  ): Promise<void> {
    await this.paths.ensureMemberWorkSyncDir(teamName, memberName);
    await writeJsonFile(this.paths.getMemberReportsPath(teamName, memberName), file);
  }

  private async readPendingReportsIndexFile(teamName: string): Promise<PendingReportsIndexFile> {
    return readJsonFile(
      this.paths.getPendingReportsIndexPath(teamName),
      isPendingReportsIndexFile,
      { schemaVersion: 2, items: {} },
      { quarantineInvalid: true }
    );
  }

  private async writePendingReportsIndexFile(
    teamName: string,
    file: PendingReportsIndexFile
  ): Promise<void> {
    await writeJsonFile(this.paths.getPendingReportsIndexPath(teamName), file);
  }

  private async readLegacyOutboxFile(teamName: string): Promise<LegacyOutboxFile> {
    return readJsonFile(
      this.paths.getLegacyOutboxPath(teamName),
      isLegacyOutboxFile,
      { schemaVersion: 1, items: {} },
      { quarantineInvalid: true }
    );
  }

  private async readMemberOutboxFile(
    teamName: string,
    memberName: string
  ): Promise<MemberOutboxFile> {
    return readJsonFile(
      this.paths.getMemberOutboxPath(teamName, memberName),
      isMemberOutboxFile,
      { schemaVersion: 2, items: {} },
      { quarantineInvalid: true }
    );
  }

  private async writeMemberOutboxFile(
    teamName: string,
    memberName: string,
    file: MemberOutboxFile
  ): Promise<void> {
    await this.paths.ensureMemberWorkSyncDir(teamName, memberName);
    await writeJsonFile(this.paths.getMemberOutboxPath(teamName, memberName), file);
  }

  private async readOutboxIndexFile(teamName: string): Promise<OutboxIndexFile> {
    return readJsonFile(
      this.paths.getOutboxIndexPath(teamName),
      isOutboxIndexFile,
      { schemaVersion: 2, items: {} },
      { quarantineInvalid: true }
    );
  }

  private async writeOutboxIndexFile(teamName: string, file: OutboxIndexFile): Promise<void> {
    await writeJsonFile(this.paths.getOutboxIndexPath(teamName), file);
  }

  private async upsertOutboxIndexItem(
    teamName: string,
    item: MemberWorkSyncOutboxItem,
    memberKey: string
  ): Promise<void> {
    const index = await this.readOutboxIndexFile(teamName);
    index.items[item.id] = toOutboxIndexItem(item, memberKey);
    await this.writeOutboxIndexFile(teamName, index);
  }

  private async updateOutboxItem(
    teamName: string,
    id: string,
    updater: (current: MemberWorkSyncOutboxItem | undefined) => MemberWorkSyncOutboxItem | undefined
  ): Promise<void> {
    await this.enqueue(teamName, async () => {
      await withFileLock(this.paths.getOutboxIndexPath(teamName), async () => {
        let index = await this.readOutboxIndexFile(teamName);
        if (!index.items[id]) {
          index = await this.repairOutboxIndex(teamName);
        }
        const route = index.items[id];
        if (!route) {
          return;
        }
        const updateRoute = async (targetRoute: OutboxIndexRoute): Promise<boolean> => {
          let staleRoute = false;
          await withFileLock(
            this.paths.getMemberOutboxPath(teamName, targetRoute.memberName),
            async () => {
              const outbox = await this.readMemberOutboxFile(teamName, targetRoute.memberName);
              const current = outbox.items[id];
              if (!current) {
                delete index.items[id];
                staleRoute = true;
                return;
              }
              if (!isOutboxItemOwnedBy(teamName, targetRoute.memberName, current)) {
                delete index.items[id];
                staleRoute = true;
                return;
              }
              const next = updater(current);
              if (!next) {
                return;
              }
              outbox.items[id] = next;
              await this.writeMemberOutboxFile(teamName, targetRoute.memberName, outbox);
              index.items[id] = toOutboxIndexItem(next, this.paths.getMemberKey(next.memberName));
              await this.writeOutboxIndexFile(teamName, index);
            }
          );
          return staleRoute;
        };

        let staleRoute = await updateRoute(route);
        if (staleRoute) {
          index = await this.repairOutboxIndex(teamName);
          const repairedRoute = index.items[id];
          if (!repairedRoute) {
            return;
          }
          staleRoute = await updateRoute(repairedRoute);
          if (staleRoute) {
            await this.repairOutboxIndex(teamName);
          }
        }
      });
    });
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
    const index: OutboxIndexFile = { schemaVersion: 2, items: {} };
    const repairedMembers = new Set<string>();
    const legacyMembers = new Set<string>();
    for (const { memberName, outbox } of await this.scanMemberOutboxes(teamName)) {
      const memberKey = this.paths.getMemberKey(memberName);
      for (const item of Object.values(outbox.items)) {
        if (!isOutboxItemOwnedBy(teamName, memberName, item)) {
          continue;
        }
        index.items[item.id] = toOutboxIndexItem(item, memberKey);
        repairedMembers.add(item.memberName);
      }
    }
    for (const item of Object.values((await this.readLegacyOutboxFile(teamName)).items)) {
      if (!isOutboxItemOwnedBy(teamName, item.memberName, item)) {
        continue;
      }
      const memberKey = this.paths.getMemberKey(item.memberName);
      if (!index.items[item.id]) {
        await withFileLock(this.paths.getMemberOutboxPath(teamName, item.memberName), async () => {
          const outbox = await this.readMemberOutboxFile(teamName, item.memberName);
          outbox.items[item.id] = item;
          await this.writeMemberOutboxFile(teamName, item.memberName, outbox);
        });
        index.items[item.id] = toOutboxIndexItem(item, memberKey);
        repairedMembers.add(item.memberName);
        legacyMembers.add(item.memberName);
      }
    }
    await this.writeOutboxIndexFile(teamName, index);
    for (const memberName of repairedMembers) {
      await this.appendAudit({
        teamName,
        memberName,
        event: 'index_repaired',
        source: 'json_store',
        reason: 'outbox',
      });
    }
    for (const memberName of legacyMembers) {
      await this.appendAudit({
        teamName,
        memberName,
        event: 'legacy_fallback_used',
        source: 'json_store',
        reason: 'outbox_v1',
      });
    }
    return index;
  }

  private async scanMemberNames(teamName: string): Promise<string[]> {
    const membersDir = join(this.paths.getTeamRootDir(teamName), 'members');
    const entries = await readdir(membersDir, { withFileTypes: true }).catch(() => []);
    const names: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const metaPath = join(membersDir, entry.name, 'member.meta.json');
      try {
        const raw = await readFile(metaPath, 'utf8');
        const parsed = JSON.parse(raw) as { memberName?: unknown };
        if (typeof parsed.memberName === 'string' && parsed.memberName.trim()) {
          names.push(parsed.memberName.trim());
        }
      } catch {
        // Ignore malformed member storage dirs during repair.
      }
    }
    return names;
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
    const outboxes: { memberName: string; outbox: MemberOutboxFile }[] = [];
    for (const memberName of await this.scanMemberNames(teamName)) {
      outboxes.push({ memberName, outbox: await this.readMemberOutboxFile(teamName, memberName) });
    }
    return outboxes;
  }

  private async hasUnindexedOrStaleIndexedDueOutboxItem(
    teamName: string,
    index: OutboxIndexFile,
    nowIso: string
  ): Promise<boolean> {
    const routes = index.items;
    for (const { memberName, outbox } of await this.scanMemberOutboxes(teamName)) {
      for (const item of Object.values(outbox.items)) {
        if (!isOutboxItemOwnedBy(teamName, memberName, item)) {
          continue;
        }
        const route = routes[item.id];
        if (
          canClaimOutboxItem(item, nowIso) &&
          !this.isCurrentDueOutboxRoute(teamName, route, item, nowIso)
        ) {
          return true;
        }
      }
    }
    for (const item of Object.values((await this.readLegacyOutboxFile(teamName)).items)) {
      if (!isOutboxItemOwnedBy(teamName, item.memberName, item)) {
        continue;
      }
      const route = routes[item.id];
      if (
        canClaimOutboxItem(item, nowIso) &&
        !this.isCurrentDueOutboxRoute(teamName, route, item, nowIso)
      ) {
        return true;
      }
    }
    return false;
  }

  private isCurrentDueOutboxRoute(
    teamName: string,
    route: OutboxIndexRoute | undefined,
    item: MemberWorkSyncOutboxItem,
    nowIso: string
  ): boolean {
    return (
      !!route &&
      normalizeTeamKey(item.teamName) === normalizeTeamKey(teamName) &&
      normalizeMemberKey(route.memberName) === normalizeMemberKey(item.memberName) &&
      route.memberKey === this.paths.getMemberKey(item.memberName) &&
      canClaimOutboxRoute(route, nowIso)
    );
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

  private async enqueue(teamName: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.writeQueues.get(teamName) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    this.writeQueues.set(
      teamName,
      next.finally(() => {
        if (this.writeQueues.get(teamName) === next) {
          this.writeQueues.delete(teamName);
        }
      })
    );
    await next;
  }
}

function toOutboxIndexItem(
  item: MemberWorkSyncOutboxItem,
  memberKey: string
): OutboxIndexFile['items'][string] {
  return {
    memberKey,
    memberName: item.memberName,
    status: item.status,
    ...(item.nextAttemptAt ? { nextAttemptAt: item.nextAttemptAt } : {}),
    updatedAt: item.updatedAt,
    createdAt: item.createdAt,
  };
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

function groupByMember<T extends { memberName: string }>(records: readonly T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const record of records) {
    const key = normalizeMemberKey(record.memberName);
    const rows = grouped.get(key) ?? [];
    rows.push(record);
    grouped.set(key, rows);
  }
  return grouped;
}

function mergeDomainSnapshots(
  canonical: MemberWorkSyncStoreSnapshot,
  incoming: MemberWorkSyncStoreSnapshot | null
): MemberWorkSyncStoreSnapshot {
  if (!incoming) return { ...canonical, filesToArchive: [] };
  return {
    statuses: mergeDomainRows(
      canonical.statuses,
      incoming.statuses,
      (row) => normalizeMemberKey(row.memberName),
      (left, right) => (compareReplicaIso(right.evaluatedAt, left.evaluatedAt) >= 0 ? right : left)
    ),
    reportIntents: mergeDomainRows(
      canonical.reportIntents,
      incoming.reportIntents,
      (row) => row.id,
      pickDomainReportIntent
    ),
    outboxItems: mergeDomainRows(
      canonical.outboxItems,
      incoming.outboxItems,
      (row) => row.id,
      pickDomainOutboxItem
    ),
    metricEvents: mergeDomainRows(
      canonical.metricEvents,
      incoming.metricEvents,
      (row) => row.id,
      (_left, right) => right
    ),
    filesToArchive: [],
  };
}

function mergeDomainRows<T>(
  canonical: readonly T[],
  incoming: readonly T[],
  identity: (record: T) => string,
  pick: (canonical: T, incoming: T) => T
): T[] {
  const merged = new Map<string, T>();
  for (const record of canonical) merged.set(identity(record), record);
  for (const record of incoming) {
    const key = identity(record);
    const current = merged.get(key);
    merged.set(key, current ? pick(current, record) : record);
  }
  return [...merged.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, record]) => record);
}

function pickDomainReportIntent(
  canonical: MemberWorkSyncReportIntent,
  incoming: MemberWorkSyncReportIntent
): MemberWorkSyncReportIntent {
  const isProcessed = (status: MemberWorkSyncReportIntent['status']): boolean =>
    status !== 'pending';
  const canonicalProcessed = isProcessed(canonical.status);
  const incomingProcessed = isProcessed(incoming.status);
  if (canonicalProcessed !== incomingProcessed) return incomingProcessed ? incoming : canonical;
  const leftTime = canonicalProcessed ? canonical.processedAt : canonical.recordedAt;
  const rightTime = incomingProcessed ? incoming.processedAt : incoming.recordedAt;
  return compareReplicaIso(rightTime, leftTime) >= 0 ? incoming : canonical;
}

function pickDomainOutboxItem(
  canonical: MemberWorkSyncOutboxItem,
  incoming: MemberWorkSyncOutboxItem
): MemberWorkSyncOutboxItem {
  const proofRank = (status: MemberWorkSyncOutboxItem['status']): number =>
    status === 'delivered' ? 2 : status === 'failed_terminal' ? 1 : 0;
  const canonicalProof = proofRank(canonical.status);
  const incomingProof = proofRank(incoming.status);
  if (canonicalProof !== incomingProof && (canonicalProof > 0 || incomingProof > 0)) {
    return incomingProof > canonicalProof ? incoming : canonical;
  }
  if (canonical.attemptGeneration !== incoming.attemptGeneration) {
    return incoming.attemptGeneration > canonical.attemptGeneration ? incoming : canonical;
  }
  return compareReplicaIso(incoming.updatedAt, canonical.updatedAt) >= 0 ? incoming : canonical;
}

function compareReplicaIso(left: string | undefined, right: string | undefined): number {
  const leftMs = left ? Date.parse(left) : Number.NaN;
  const rightMs = right ? Date.parse(right) : Number.NaN;
  const leftValid = Number.isFinite(leftMs);
  const rightValid = Number.isFinite(rightMs);
  if (leftValid !== rightValid) return leftValid ? 1 : -1;
  if (!leftValid || leftMs === rightMs) return 0;
  return leftMs < rightMs ? -1 : 1;
}
