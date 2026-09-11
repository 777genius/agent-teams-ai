import { createHash } from 'node:crypto';

import { buildMemberWorkSyncNudgePayloadHash } from '../../core/domain/MemberWorkSyncNudge';
import { validateMemberWorkSyncReportJournalRow } from '../../core/domain/MemberWorkSyncReportJournalRow';

import { decodeMemberWorkSyncStoredStatus } from './decodeMemberWorkSyncStoredStatus';
import { isMemberWorkSyncStoreSnapshot, normalizeMemberKey } from './JsonMemberWorkSyncStore';
import { mergeDomainSnapshots } from './memberWorkSyncDomainSnapshotMerge';
import { MemberWorkSyncSafetyJsonReadError } from './memberWorkSyncSafetyJson';

import type { MemberWorkSyncOutboxItem } from '../../contracts';
import type { MemberWorkSyncStoreSnapshot } from './JsonMemberWorkSyncStore';
import type { MemberWorkSyncTeamSnapshotRecords } from '@features/internal-storage/contracts/internalStorageContracts';

export interface MemberWorkSyncPreparationIdentity {
  teamName: string;
  incarnation: string;
}

/** Validate persisted ownership before a mapper can normalize it into the requested scope. */
export function validateMemberWorkSyncAuthoritySnapshot(
  identity: MemberWorkSyncPreparationIdentity,
  snapshot: MemberWorkSyncStoreSnapshot
): void {
  if (!isMemberWorkSyncStoreSnapshot({ ...snapshot, filesToArchive: [] }, identity.teamName))
    throw new MemberWorkSyncSafetyJsonReadError('corrupt');
  for (const status of snapshot.statuses)
    decodeMemberWorkSyncStoredStatus(status, { ...identity, memberName: status.memberName });
  for (const intent of snapshot.reportIntents) {
    if (intent.journal !== undefined) validateJournal(intent, identity);
    if (
      !intent.id.trim() ||
      !normalizeMemberKey(intent.memberName) ||
      normalizeMemberKey(intent.memberName) !== normalizeMemberKey(intent.request.memberName)
    )
      throw new MemberWorkSyncSafetyJsonReadError('corrupt');
  }
  for (const item of snapshot.outboxItems) validateOutbox(item);
  for (const event of snapshot.metricEvents)
    if (!event.id.trim() || !normalizeMemberKey(event.memberName))
      throw new MemberWorkSyncSafetyJsonReadError('corrupt');
  // Fold duplicates now, before any import/dirty publication, to expose revision conflicts.
  mergeDomainSnapshots(snapshot, null);
}

export function validateMemberWorkSyncPrimaryRecords(
  identity: MemberWorkSyncPreparationIdentity,
  records: MemberWorkSyncTeamSnapshotRecords
): void {
  const teamKey = identity.teamName.trim().toLowerCase();
  for (const rows of [
    records.statuses,
    records.reportIntents,
    records.outboxItems,
    records.metricEvents,
  ]) {
    for (const row of rows) {
      if (
        row.teamName.trim().toLowerCase() !== teamKey ||
        !normalizeMemberKey(row.memberName) ||
        row.memberKey !== normalizeMemberKey(row.memberName)
      )
        throw new MemberWorkSyncSafetyJsonReadError('corrupt');
    }
  }
  for (const row of records.statuses)
    decodeMemberWorkSyncStoredStatus(parse(row.statusJson), {
      ...identity,
      memberName: row.memberName,
    });
  for (const row of records.outboxItems) {
    const payload = parse(row.payloadJson) as MemberWorkSyncOutboxItem['payload'];
    validateOutbox({ ...row, payload } as unknown as MemberWorkSyncOutboxItem);
    if (
      row.workSyncIntent !== payload.workSyncIntent ||
      row.workSyncIntentKey !== (payload.workSyncIntentKey ?? null)
    )
      throw new MemberWorkSyncSafetyJsonReadError('corrupt');
  }
  for (const row of records.reportIntents) {
    if (row.journalJson != null)
      validateJournal(
        { ...row, journal: parse(row.journalJson), request: parse(row.requestJson) },
        identity
      );
    const request = parse(row.requestJson);
    if (!request || typeof request !== 'object' || Array.isArray(request))
      throw new MemberWorkSyncSafetyJsonReadError('corrupt');
    const value = request as Record<string, unknown>;
    if (
      typeof value.teamName !== 'string' ||
      value.teamName.trim().toLowerCase() !== teamKey ||
      typeof value.memberName !== 'string' ||
      normalizeMemberKey(value.memberName) !== row.memberKey
    )
      throw new MemberWorkSyncSafetyJsonReadError('corrupt');
  }
}

function validateOutbox(item: MemberWorkSyncOutboxItem): void {
  const payload = item.payload;
  if (
    !item.id.trim() ||
    !normalizeMemberKey(item.memberName) ||
    payload?.from !== 'system' ||
    payload.messageKind !== 'member_work_sync_nudge' ||
    payload.source !== 'member-work-sync' ||
    payload.actionMode !== 'do' ||
    normalizeMemberKey(payload.to) !== normalizeMemberKey(item.memberName) ||
    !['agenda_sync', 'review_pickup'].includes(payload.workSyncIntent) ||
    typeof payload.text !== 'string' ||
    !payload.text.trim() ||
    !Array.isArray(payload.taskRefs) ||
    payload.taskRefs.some(
      (ref) =>
        !ref ||
        typeof ref.taskId !== 'string' ||
        !ref.taskId.trim() ||
        typeof ref.displayId !== 'string' ||
        typeof ref.teamName !== 'string' ||
        !ref.teamName.trim()
    ) ||
    (payload.workSyncIntentKey !== undefined && typeof payload.workSyncIntentKey !== 'string') ||
    (payload.workSyncReviewRequestEventIds !== undefined &&
      (!Array.isArray(payload.workSyncReviewRequestEventIds) ||
        payload.workSyncReviewRequestEventIds.some((id) => typeof id !== 'string' || !id.trim())))
  )
    throw new MemberWorkSyncSafetyJsonReadError('corrupt');
  const digest = buildMemberWorkSyncNudgePayloadHash(
    { sha256Hex: (value) => createHash('sha256').update(value).digest('hex') },
    payload
  );
  if (digest !== item.payloadHash) throw new MemberWorkSyncSafetyJsonReadError('corrupt');
}

function parse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new MemberWorkSyncSafetyJsonReadError('corrupt');
  }
}

/** Dirty evidence can validate an existing authority, never create a missing member baseline. */
export function assertMemberWorkSyncDirtyContinuity(
  identity: MemberWorkSyncPreparationIdentity,
  canonical: MemberWorkSyncStoreSnapshot,
  candidate: MemberWorkSyncStoreSnapshot | null
): void {
  if (!candidate || candidate.statuses.length === 0)
    throw new MemberWorkSyncSafetyJsonReadError('unavailable');
  const current = new Map(
    canonical.statuses.map((status) => [normalizeMemberKey(status.memberName), status])
  );
  for (const status of candidate.statuses) {
    const primary = current.get(normalizeMemberKey(status.memberName));
    if (
      primary?.statusRevision?.incarnation !== identity.incarnation ||
      primary.statusRevision.lineageId !== status.statusRevision?.lineageId ||
      primary.statusRevision.sequence < status.statusRevision.sequence
    )
      throw new MemberWorkSyncSafetyJsonReadError('unavailable');
  }
  // Equal sequence divergence is corruption, not proof of continuity.
  mergeDomainSnapshots(canonical, candidate);
}

function validateJournal(value: unknown, identity: MemberWorkSyncPreparationIdentity): void {
  try {
    validateMemberWorkSyncReportJournalRow(value, identity);
    return;
  } catch {
    throw new MemberWorkSyncSafetyJsonReadError('corrupt');
  }
}
