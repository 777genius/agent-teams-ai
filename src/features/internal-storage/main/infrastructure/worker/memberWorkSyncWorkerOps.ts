import { and, asc, desc, eq, gt, gte, inArray } from 'drizzle-orm';

import {
  memberWorkSyncMetricEvents,
  memberWorkSyncOutbox,
  memberWorkSyncReportIntents,
  memberWorkSyncStatus,
} from './internalStorageSchema';

import type {
  MemberWorkSyncMetricEventRecord,
  MemberWorkSyncOutboxEnsureRecordInput,
  MemberWorkSyncOutboxEnsureRecordResult,
  MemberWorkSyncOutboxItemRecord,
  MemberWorkSyncReportIntentRecord,
  MemberWorkSyncStatusRecord,
  MemberWorkSyncTeamSnapshotRecords,
} from '../../../contracts/internalStorageContracts';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

// Mirrors MEMBER_WORK_SYNC_OUTBOX_CLAIM_STALE_MS in JsonMemberWorkSyncStore.
const CLAIM_STALE_MS = 5 * 60 * 1000;
// Mirrors the recentEvents cap in the JSON metrics index.
const METRIC_EVENTS_CAP = 200;
const INSERT_CHUNK_SIZE = 200;

const OUTBOX_TERMINAL_STATUSES = ['delivered', 'superseded', 'failed_terminal'];

function isOutboxTerminal(status: string): boolean {
  return OUTBOX_TERMINAL_STATUSES.includes(status);
}

// Mirrors canReviveOutboxItem: superseded | claimed | failed_retryable.
function canRevive(status: string): boolean {
  return status === 'superseded' || (!isOutboxTerminal(status) && status !== 'pending');
}

function parseIsoMs(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function isStaleClaim(claimedAt: string | null, updatedAt: string, nowIso: string): boolean {
  const claimedAtMs = parseIsoMs(claimedAt ?? updatedAt);
  const nowMs = parseIsoMs(nowIso);
  return (
    claimedAtMs != null &&
    nowMs != null &&
    (claimedAtMs > nowMs || nowMs - claimedAtMs >= CLAIM_STALE_MS)
  );
}

function isNextAttemptDue(nextAttemptAt: string | null, nowIso: string): boolean {
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

function canClaim(item: MemberWorkSyncOutboxItemRecord, nowIso: string): boolean {
  if (item.status === 'claimed') {
    return isStaleClaim(item.claimedAt, item.updatedAt, nowIso);
  }
  if (item.status !== 'pending' && item.status !== 'failed_retryable') {
    return false;
  }
  return isNextAttemptDue(item.nextAttemptAt, nowIso);
}

// Load-bearing guard, not just batching: drizzle's .values([]) throws, and an
// empty set is a legitimate state (fresh team import). Iterating chunks means
// zero .values() calls for empty input — do not inline bulk inserts without it.
function chunked<T>(values: T[]): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < values.length; start += INSERT_CHUNK_SIZE) {
    chunks.push(values.slice(start, start + INSERT_CHUNK_SIZE));
  }
  return chunks;
}

/** Routes 'mws.*' worker requests to the ops instance. */
export function handleMemberWorkSyncOp(
  ops: MemberWorkSyncWorkerOps,
  op: string,
  payload: unknown
): unknown {
  const p = payload as never;
  switch (op) {
    case 'mws.status.read': {
      const typed = p as { teamName: string; memberKey: string };
      return ops.statusRead(typed.teamName, typed.memberKey);
    }
    case 'mws.status.write': {
      const typed = p as {
        record: MemberWorkSyncStatusRecord;
        events: MemberWorkSyncMetricEventRecord[];
      };
      ops.statusWrite(typed.record, typed.events);
      return null;
    }
    case 'mws.status.list':
      return ops.statusList((p as { teamName: string }).teamName);
    case 'mws.metricEvents.list':
      return ops.metricEventsList((p as { teamName: string }).teamName);
    case 'mws.reports.append':
      ops.reportsAppend((p as { record: MemberWorkSyncReportIntentRecord }).record);
      return null;
    case 'mws.reports.listPending':
      return ops.reportsListPending((p as { teamName: string }).teamName);
    case 'mws.reports.markProcessed': {
      const typed = p as {
        teamName: string;
        id: string;
        status: string;
        resultCode: string;
        processedAt: string;
      };
      ops.reportsMarkProcessed(typed.teamName, typed.id, typed);
      return null;
    }
    case 'mws.outbox.ensurePending':
      return ops.outboxEnsurePending(p as MemberWorkSyncOutboxEnsureRecordInput);
    case 'mws.outbox.claimDue':
      return ops.outboxClaimDue(
        p as { teamName: string; claimedBy: string; nowIso: string; limit: number }
      );
    case 'mws.outbox.markDelivered':
      ops.outboxMarkDelivered(p as Parameters<MemberWorkSyncWorkerOps['outboxMarkDelivered']>[0]);
      return null;
    case 'mws.outbox.markSuperseded':
      ops.outboxMarkSuperseded(p as Parameters<MemberWorkSyncWorkerOps['outboxMarkSuperseded']>[0]);
      return null;
    case 'mws.outbox.markFailed':
      ops.outboxMarkFailed(p as Parameters<MemberWorkSyncWorkerOps['outboxMarkFailed']>[0]);
      return null;
    case 'mws.outbox.countRecentDelivered':
      return ops.outboxCountRecentDelivered(
        p as Parameters<MemberWorkSyncWorkerOps['outboxCountRecentDelivered']>[0]
      );
    case 'mws.outbox.countDeliveredForAgenda':
      return ops.outboxCountDeliveredForAgenda(
        p as Parameters<MemberWorkSyncWorkerOps['outboxCountDeliveredForAgenda']>[0]
      );
    case 'mws.outbox.findDeliveredReviewPickupEventIds':
      return ops.outboxFindDeliveredReviewPickupEventIds(
        p as Parameters<MemberWorkSyncWorkerOps['outboxFindDeliveredReviewPickupEventIds']>[0]
      );
    case 'mws.outbox.findRecentRecoveryByIntent':
      return ops.outboxFindRecentRecoveryByIntent(
        p as Parameters<MemberWorkSyncWorkerOps['outboxFindRecentRecoveryByIntent']>[0]
      );
    case 'mws.snapshot.list':
      return ops.listTeamSnapshot((p as { teamName: string }).teamName);
    case 'mws.importTeam': {
      const typed = p as { teamName: string; snapshot: MemberWorkSyncTeamSnapshotRecords };
      ops.importTeam(typed.teamName, typed.snapshot);
      return null;
    }
    default:
      throw new Error(`Unknown internal-storage op: ${op}`);
  }
}

/**
 * Member-work-sync op handlers. Every mutating op is a single transaction —
 * this store holds message-delivery state, so claim/mark transitions must be
 * atomic and preserve the JSON store's semantics exactly (terminal statuses
 * are immutable, attemptGeneration acts as an optimistic lock, stale claims
 * become claimable after 5 minutes).
 *
 * better-sqlite3 uses one synchronous connection, so statements issued via
 * the root orm inside a transaction callback run within that transaction.
 */
export class MemberWorkSyncWorkerOps {
  constructor(private readonly getOrm: () => BetterSQLite3Database) {}

  statusRead(teamName: string, memberKey: string): MemberWorkSyncStatusRecord | null {
    const rows = this.getOrm()
      .select()
      .from(memberWorkSyncStatus)
      .where(
        and(
          eq(memberWorkSyncStatus.teamName, teamName),
          eq(memberWorkSyncStatus.memberKey, memberKey)
        )
      )
      .all();
    return rows[0] ?? null;
  }

  statusList(teamName: string): MemberWorkSyncStatusRecord[] {
    return this.getOrm()
      .select()
      .from(memberWorkSyncStatus)
      .where(eq(memberWorkSyncStatus.teamName, teamName))
      .orderBy(asc(memberWorkSyncStatus.memberKey))
      .all();
  }

  /**
   * Status upsert plus metric-event append in one transaction (the JSON store
   * updates the metrics index under the same lock). Events are deduped by
   * their deterministic id and the newest METRIC_EVENTS_CAP per team survive.
   */
  statusWrite(record: MemberWorkSyncStatusRecord, events: MemberWorkSyncMetricEventRecord[]): void {
    const orm = this.getOrm();
    orm.transaction(() => {
      orm
        .insert(memberWorkSyncStatus)
        .values(record)
        .onConflictDoUpdate({
          target: [memberWorkSyncStatus.teamName, memberWorkSyncStatus.memberKey],
          set: {
            memberName: record.memberName,
            state: record.state,
            evaluatedAt: record.evaluatedAt,
            providerId: record.providerId,
            statusJson: record.statusJson,
          },
        })
        .run();
      for (const event of events) {
        orm
          .insert(memberWorkSyncMetricEvents)
          .values(event)
          .onConflictDoUpdate({
            target: [memberWorkSyncMetricEvents.teamName, memberWorkSyncMetricEvents.id],
            set: {
              memberKey: event.memberKey,
              memberName: event.memberName,
              kind: event.kind,
              recordedAt: event.recordedAt,
              eventJson: event.eventJson,
            },
          })
          .run();
      }
      this.pruneMetricEvents(record.teamName);
    });
  }

  metricEventsList(teamName: string): MemberWorkSyncMetricEventRecord[] {
    return this.getOrm()
      .select()
      .from(memberWorkSyncMetricEvents)
      .where(eq(memberWorkSyncMetricEvents.teamName, teamName))
      .orderBy(asc(memberWorkSyncMetricEvents.recordedAt))
      .all();
  }

  /** No-op when the intent exists in a processed state (matches JSON store). */
  reportsAppend(record: MemberWorkSyncReportIntentRecord): void {
    const orm = this.getOrm();
    orm.transaction(() => {
      const current = this.readReportRow(record.teamName, record.id);
      if (current && current.status !== 'pending') {
        return;
      }
      const next: MemberWorkSyncReportIntentRecord = {
        ...record,
        reason: current?.reason ?? record.reason,
        recordedAt: current?.recordedAt ?? record.recordedAt,
        status: 'pending',
        processedAt: null,
        resultCode: null,
      };
      orm
        .insert(memberWorkSyncReportIntents)
        .values(next)
        .onConflictDoUpdate({
          target: [memberWorkSyncReportIntents.teamName, memberWorkSyncReportIntents.id],
          set: {
            memberKey: next.memberKey,
            memberName: next.memberName,
            status: next.status,
            reason: next.reason,
            recordedAt: next.recordedAt,
            processedAt: next.processedAt,
            resultCode: next.resultCode,
            requestJson: next.requestJson,
          },
        })
        .run();
    });
  }

  reportsListPending(teamName: string): MemberWorkSyncReportIntentRecord[] {
    return this.getOrm()
      .select()
      .from(memberWorkSyncReportIntents)
      .where(
        and(
          eq(memberWorkSyncReportIntents.teamName, teamName),
          eq(memberWorkSyncReportIntents.status, 'pending')
        )
      )
      .orderBy(asc(memberWorkSyncReportIntents.recordedAt))
      .all();
  }

  /** Only a pending intent transitions; anything else is a silent no-op. */
  reportsMarkProcessed(
    teamName: string,
    id: string,
    result: { status: string; resultCode: string; processedAt: string }
  ): void {
    this.getOrm()
      .update(memberWorkSyncReportIntents)
      .set({
        status: result.status,
        resultCode: result.resultCode,
        processedAt: result.processedAt,
      })
      .where(
        and(
          eq(memberWorkSyncReportIntents.teamName, teamName),
          eq(memberWorkSyncReportIntents.id, id),
          eq(memberWorkSyncReportIntents.status, 'pending')
        )
      )
      .run();
  }

  outboxEnsurePending(
    input: MemberWorkSyncOutboxEnsureRecordInput
  ): MemberWorkSyncOutboxEnsureRecordResult {
    const orm = this.getOrm();
    const { record, nowIso, nextAttemptAt } = input;
    return orm.transaction((): MemberWorkSyncOutboxEnsureRecordResult => {
      const current = this.readOutboxRow(record.teamName, record.id);

      if (current) {
        if (current.payloadHash !== record.payloadHash) {
          if (current.status !== 'delivered' && current.status !== 'failed_terminal') {
            const next: MemberWorkSyncOutboxItemRecord = {
              ...current,
              agendaFingerprint: record.agendaFingerprint,
              payloadHash: record.payloadHash,
              payloadJson: record.payloadJson,
              workSyncIntent: record.workSyncIntent,
              workSyncIntentKey: record.workSyncIntentKey,
              reviewRequestEventIdsJson: record.reviewRequestEventIdsJson,
              status: 'pending',
              attemptGeneration:
                current.status === 'claimed'
                  ? current.attemptGeneration + 1
                  : current.attemptGeneration,
              claimedBy: null,
              claimedAt: null,
              lastError: null,
              nextAttemptAt,
              updatedAt: nowIso,
            };
            this.replaceOutboxRow(next);
            return { ok: true, outcome: 'existing', item: next };
          }
          return {
            ok: false,
            outcome: 'payload_conflict',
            item: current,
            existingPayloadHash: current.payloadHash,
            requestedPayloadHash: record.payloadHash,
          };
        }

        if (canRevive(current.status)) {
          const next: MemberWorkSyncOutboxItemRecord = {
            ...current,
            status: 'pending',
            claimedBy: null,
            claimedAt: null,
            lastError: null,
            nextAttemptAt,
            updatedAt: nowIso,
          };
          this.replaceOutboxRow(next);
          return { ok: true, outcome: 'existing', item: next };
        }

        return { ok: true, outcome: 'existing', item: current };
      }

      const created: MemberWorkSyncOutboxItemRecord = {
        ...record,
        status: 'pending',
        attemptGeneration: 0,
        claimedBy: null,
        claimedAt: null,
        deliveredMessageId: null,
        deliveryState: null,
        lastError: null,
        deliveryDiagnosticsJson: null,
        nextAttemptAt,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      orm.insert(memberWorkSyncOutbox).values(created).run();
      return { ok: true, outcome: 'created', item: created };
    });
  }

  /**
   * Claims due items in one transaction: pending / retryable items whose
   * nextAttemptAt is due, plus stale claims (older than 5 minutes). Ordering
   * matches the JSON index: by (nextAttemptAt ?? updatedAt) ascending.
   */
  outboxClaimDue(input: {
    teamName: string;
    claimedBy: string;
    nowIso: string;
    limit: number;
  }): MemberWorkSyncOutboxItemRecord[] {
    const orm = this.getOrm();
    return orm.transaction(() => {
      const candidates = orm
        .select()
        .from(memberWorkSyncOutbox)
        .where(
          and(
            eq(memberWorkSyncOutbox.teamName, input.teamName),
            inArray(memberWorkSyncOutbox.status, ['pending', 'failed_retryable', 'claimed'])
          )
        )
        .all();
      const due = candidates
        .filter((item) => canClaim(item, input.nowIso))
        .sort((left, right) => {
          const leftTime = left.nextAttemptAt ?? left.updatedAt;
          const rightTime = right.nextAttemptAt ?? right.updatedAt;
          return leftTime.localeCompare(rightTime);
        })
        .slice(0, Math.max(0, input.limit));

      const claimed: MemberWorkSyncOutboxItemRecord[] = [];
      for (const item of due) {
        const next: MemberWorkSyncOutboxItemRecord = {
          ...item,
          status: 'claimed',
          attemptGeneration: item.attemptGeneration + 1,
          claimedBy: input.claimedBy,
          claimedAt: input.nowIso,
          updatedAt: input.nowIso,
          nextAttemptAt: null,
          lastError: null,
        };
        this.replaceOutboxRow(next);
        claimed.push(next);
      }
      return claimed;
    });
  }

  /** Delivery proof: only the claim generation that is still current wins. */
  outboxMarkDelivered(input: {
    teamName: string;
    id: string;
    attemptGeneration: number;
    deliveredMessageId: string;
    deliveryState: string | null;
    deliveryDiagnosticsJson: string | null;
    nowIso: string;
  }): void {
    const orm = this.getOrm();
    orm.transaction(() => {
      const current = this.readOutboxRow(input.teamName, input.id);
      if (current?.attemptGeneration !== input.attemptGeneration || current.status !== 'claimed') {
        return;
      }
      this.replaceOutboxRow({
        ...current,
        status: 'delivered',
        deliveredMessageId: input.deliveredMessageId,
        deliveryState: input.deliveryState ?? current.deliveryState,
        deliveryDiagnosticsJson: input.deliveryDiagnosticsJson ?? current.deliveryDiagnosticsJson,
        lastError: null,
        nextAttemptAt: null,
        updatedAt: input.nowIso,
      });
    });
  }

  outboxMarkSuperseded(input: {
    teamName: string;
    id: string;
    reason: string;
    nowIso: string;
  }): void {
    const orm = this.getOrm();
    orm.transaction(() => {
      const current = this.readOutboxRow(input.teamName, input.id);
      if (!current || isOutboxTerminal(current.status)) {
        return;
      }
      this.replaceOutboxRow({
        ...current,
        status: 'superseded',
        lastError: input.reason,
        updatedAt: input.nowIso,
      });
    });
  }

  outboxMarkFailed(input: {
    teamName: string;
    id: string;
    attemptGeneration: number;
    error: string;
    retryable: boolean;
    nextAttemptAt: string | null;
    nowIso: string;
  }): void {
    const orm = this.getOrm();
    orm.transaction(() => {
      const current = this.readOutboxRow(input.teamName, input.id);
      if (current?.attemptGeneration !== input.attemptGeneration || current.status !== 'claimed') {
        return;
      }
      this.replaceOutboxRow({
        ...current,
        status: input.retryable ? 'failed_retryable' : 'failed_terminal',
        lastError: input.error,
        nextAttemptAt: input.retryable ? input.nextAttemptAt : null,
        updatedAt: input.nowIso,
      });
    });
  }

  /** Inclusive since (updatedAt >= sinceIso), matching the JSON store. */
  outboxCountRecentDelivered(input: {
    teamName: string;
    memberKey: string;
    sinceIso: string;
    workSyncIntentKeyPrefix: string | null;
  }): number {
    const rows = this.getOrm()
      .select({ workSyncIntentKey: memberWorkSyncOutbox.workSyncIntentKey })
      .from(memberWorkSyncOutbox)
      .where(
        and(
          eq(memberWorkSyncOutbox.teamName, input.teamName),
          eq(memberWorkSyncOutbox.memberKey, input.memberKey),
          eq(memberWorkSyncOutbox.status, 'delivered'),
          gte(memberWorkSyncOutbox.updatedAt, input.sinceIso)
        )
      )
      .all();
    if (!input.workSyncIntentKeyPrefix) {
      return rows.length;
    }
    const prefix = input.workSyncIntentKeyPrefix;
    return rows.filter((row) => row.workSyncIntentKey?.startsWith(prefix) === true).length;
  }

  /** Exclusive since (updatedAt > sinceIso), matching the JSON store. */
  outboxCountDeliveredForAgenda(input: {
    teamName: string;
    memberKey: string;
    agendaFingerprint: string;
    sinceIso: string | null;
  }): number {
    const conditions = [
      eq(memberWorkSyncOutbox.teamName, input.teamName),
      eq(memberWorkSyncOutbox.memberKey, input.memberKey),
      eq(memberWorkSyncOutbox.status, 'delivered'),
      eq(memberWorkSyncOutbox.agendaFingerprint, input.agendaFingerprint),
    ];
    if (input.sinceIso) {
      conditions.push(gt(memberWorkSyncOutbox.updatedAt, input.sinceIso));
    }
    return this.getOrm()
      .select({ id: memberWorkSyncOutbox.id })
      .from(memberWorkSyncOutbox)
      .where(and(...conditions))
      .all().length;
  }

  outboxFindDeliveredReviewPickupEventIds(input: {
    teamName: string;
    memberKey: string;
    reviewRequestEventIds: string[];
  }): string[] {
    const requested = new Set(input.reviewRequestEventIds.map((id) => id.trim()).filter(Boolean));
    if (requested.size === 0) {
      return [];
    }
    const rows = this.getOrm()
      .select({ reviewRequestEventIdsJson: memberWorkSyncOutbox.reviewRequestEventIdsJson })
      .from(memberWorkSyncOutbox)
      .where(
        and(
          eq(memberWorkSyncOutbox.teamName, input.teamName),
          eq(memberWorkSyncOutbox.memberKey, input.memberKey),
          eq(memberWorkSyncOutbox.status, 'delivered'),
          eq(memberWorkSyncOutbox.workSyncIntent, 'review_pickup')
        )
      )
      .all();
    const delivered = new Set<string>();
    for (const row of rows) {
      if (!row.reviewRequestEventIdsJson) {
        continue;
      }
      let eventIds: unknown;
      try {
        eventIds = JSON.parse(row.reviewRequestEventIdsJson);
      } catch {
        continue;
      }
      if (!Array.isArray(eventIds)) {
        continue;
      }
      for (const eventId of eventIds) {
        if (typeof eventId !== 'string') {
          continue;
        }
        const normalized = eventId.trim();
        if (requested.has(normalized)) {
          delivered.add(normalized);
        }
      }
    }
    return [...delivered].sort((a, b) => a.localeCompare(b));
  }

  outboxFindRecentRecoveryByIntent(input: {
    teamName: string;
    memberKey: string;
    intentKey: string;
    sinceIso: string;
  }): MemberWorkSyncOutboxItemRecord | null {
    const rows = this.getOrm()
      .select()
      .from(memberWorkSyncOutbox)
      .where(
        and(
          eq(memberWorkSyncOutbox.teamName, input.teamName),
          eq(memberWorkSyncOutbox.memberKey, input.memberKey),
          eq(memberWorkSyncOutbox.workSyncIntentKey, input.intentKey),
          gte(memberWorkSyncOutbox.updatedAt, input.sinceIso)
        )
      )
      .all()
      .filter((item) => item.status !== 'failed_terminal' && item.status !== 'superseded')
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return rows[0] ?? null;
  }

  listTeamSnapshot(teamName: string): MemberWorkSyncTeamSnapshotRecords {
    const orm = this.getOrm();
    return {
      statuses: this.statusList(teamName),
      reportIntents: orm
        .select()
        .from(memberWorkSyncReportIntents)
        .where(eq(memberWorkSyncReportIntents.teamName, teamName))
        .all(),
      outboxItems: orm
        .select()
        .from(memberWorkSyncOutbox)
        .where(eq(memberWorkSyncOutbox.teamName, teamName))
        .all(),
      metricEvents: this.metricEventsList(teamName),
    };
  }

  /** One-transaction legacy import: replaces every team row in all tables. */
  importTeam(teamName: string, snapshot: MemberWorkSyncTeamSnapshotRecords): void {
    const orm = this.getOrm();
    orm.transaction(() => {
      orm.delete(memberWorkSyncStatus).where(eq(memberWorkSyncStatus.teamName, teamName)).run();
      orm
        .delete(memberWorkSyncReportIntents)
        .where(eq(memberWorkSyncReportIntents.teamName, teamName))
        .run();
      orm.delete(memberWorkSyncOutbox).where(eq(memberWorkSyncOutbox.teamName, teamName)).run();
      orm
        .delete(memberWorkSyncMetricEvents)
        .where(eq(memberWorkSyncMetricEvents.teamName, teamName))
        .run();
      for (const rows of chunked(snapshot.statuses)) {
        orm.insert(memberWorkSyncStatus).values(rows).run();
      }
      for (const rows of chunked(snapshot.reportIntents)) {
        orm.insert(memberWorkSyncReportIntents).values(rows).run();
      }
      for (const rows of chunked(snapshot.outboxItems)) {
        orm.insert(memberWorkSyncOutbox).values(rows).run();
      }
      for (const rows of chunked(snapshot.metricEvents)) {
        orm.insert(memberWorkSyncMetricEvents).values(rows).run();
      }
    });
  }

  private pruneMetricEvents(teamName: string): void {
    const orm = this.getOrm();
    const survivors = orm
      .select({ id: memberWorkSyncMetricEvents.id })
      .from(memberWorkSyncMetricEvents)
      .where(eq(memberWorkSyncMetricEvents.teamName, teamName))
      .orderBy(desc(memberWorkSyncMetricEvents.recordedAt), desc(memberWorkSyncMetricEvents.id))
      .limit(METRIC_EVENTS_CAP)
      .all();
    const keep = new Set(survivors.map((row) => row.id));
    const all = orm
      .select({ id: memberWorkSyncMetricEvents.id })
      .from(memberWorkSyncMetricEvents)
      .where(eq(memberWorkSyncMetricEvents.teamName, teamName))
      .all();
    const doomed = all.map((row) => row.id).filter((id) => !keep.has(id));
    for (const ids of chunked(doomed)) {
      orm
        .delete(memberWorkSyncMetricEvents)
        .where(
          and(
            eq(memberWorkSyncMetricEvents.teamName, teamName),
            inArray(memberWorkSyncMetricEvents.id, ids)
          )
        )
        .run();
    }
  }

  private readReportRow(teamName: string, id: string): MemberWorkSyncReportIntentRecord | null {
    const rows = this.getOrm()
      .select()
      .from(memberWorkSyncReportIntents)
      .where(
        and(
          eq(memberWorkSyncReportIntents.teamName, teamName),
          eq(memberWorkSyncReportIntents.id, id)
        )
      )
      .all();
    return rows[0] ?? null;
  }

  private readOutboxRow(teamName: string, id: string): MemberWorkSyncOutboxItemRecord | null {
    const rows = this.getOrm()
      .select()
      .from(memberWorkSyncOutbox)
      .where(and(eq(memberWorkSyncOutbox.teamName, teamName), eq(memberWorkSyncOutbox.id, id)))
      .all();
    return rows[0] ?? null;
  }

  private replaceOutboxRow(row: MemberWorkSyncOutboxItemRecord): void {
    this.getOrm()
      .update(memberWorkSyncOutbox)
      .set({
        memberKey: row.memberKey,
        memberName: row.memberName,
        agendaFingerprint: row.agendaFingerprint,
        payloadHash: row.payloadHash,
        status: row.status,
        attemptGeneration: row.attemptGeneration,
        claimedBy: row.claimedBy,
        claimedAt: row.claimedAt,
        deliveredMessageId: row.deliveredMessageId,
        deliveryState: row.deliveryState,
        lastError: row.lastError,
        nextAttemptAt: row.nextAttemptAt,
        updatedAt: row.updatedAt,
        workSyncIntent: row.workSyncIntent,
        workSyncIntentKey: row.workSyncIntentKey,
        reviewRequestEventIdsJson: row.reviewRequestEventIdsJson,
        deliveryDiagnosticsJson: row.deliveryDiagnosticsJson,
        payloadJson: row.payloadJson,
      })
      .where(
        and(eq(memberWorkSyncOutbox.teamName, row.teamName), eq(memberWorkSyncOutbox.id, row.id))
      )
      .run();
  }
}
