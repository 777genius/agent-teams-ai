import type {
  MemberWorkSyncMetricEventRecord,
  MemberWorkSyncReportIntentRecord,
  MemberWorkSyncStatusRecord,
  MemberWorkSyncTeamSnapshotRecords,
} from './internalStorageContracts';

type JsonObject = Record<string, unknown>;

export function normalizeMemberWorkSyncTeamKey(teamName: unknown): string {
  return typeof teamName === 'string' ? teamName.trim().toLowerCase() : '';
}

export function isSameMemberWorkSyncTeam(leftTeamName: unknown, rightTeamName: unknown): boolean {
  const leftKey = normalizeMemberWorkSyncTeamKey(leftTeamName);
  return leftKey.length > 0 && leftKey === normalizeMemberWorkSyncTeamKey(rightTeamName);
}

function parseJsonObject(json: string, recordKind: string): JsonObject {
  const value: unknown = JSON.parse(json);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid member-work-sync ${recordKind} JSON`);
  }
  return value as JsonObject;
}

function normalizeNestedTeamName(value: unknown, teamName: string): void {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    (value as JsonObject).teamName = teamName;
  }
}

function normalizeStatusRecord(
  teamName: string,
  record: MemberWorkSyncStatusRecord
): MemberWorkSyncStatusRecord {
  const status = parseJsonObject(record.statusJson, 'status');
  normalizeNestedTeamName(status, teamName);
  normalizeNestedTeamName(status.agenda, teamName);
  if (status.report != null) {
    normalizeNestedTeamName(status.report, teamName);
  }
  return {
    ...record,
    teamName,
    statusJson: JSON.stringify(status),
  };
}

function normalizeReportIntentRecord(
  teamName: string,
  record: MemberWorkSyncReportIntentRecord
): MemberWorkSyncReportIntentRecord {
  const request = parseJsonObject(record.requestJson, 'report request');
  normalizeNestedTeamName(request, teamName);
  return {
    ...record,
    teamName,
    requestJson: JSON.stringify(request),
  };
}

function normalizeMetricEventRecord(
  teamName: string,
  record: MemberWorkSyncMetricEventRecord
): MemberWorkSyncMetricEventRecord {
  const event = parseJsonObject(record.eventJson, 'metric event');
  normalizeNestedTeamName(event, teamName);
  return {
    ...record,
    teamName,
    eventJson: JSON.stringify(event),
  };
}

/**
 * Canonicalizes every same-team identity carried by a team-scoped snapshot.
 * The routing argument is authoritative: row columns and nested domain-owned
 * team fields use its exact spelling. Outbox task refs are deliberately left
 * untouched because they may identify genuine cross-team work and payloadJson
 * must continue to match its proof-bearing payloadHash.
 */
export function normalizeMemberWorkSyncSnapshotTeamIdentity(
  teamName: string,
  snapshot: MemberWorkSyncTeamSnapshotRecords
): MemberWorkSyncTeamSnapshotRecords {
  return {
    statuses: snapshot.statuses.map((record) => normalizeStatusRecord(teamName, record)),
    reportIntents: snapshot.reportIntents.map((record) =>
      normalizeReportIntentRecord(teamName, record)
    ),
    outboxItems: snapshot.outboxItems.map((record) => ({ ...record, teamName })),
    metricEvents: snapshot.metricEvents.map((record) =>
      normalizeMetricEventRecord(teamName, record)
    ),
  };
}
