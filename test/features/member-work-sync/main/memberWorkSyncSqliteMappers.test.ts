import {
  recordsToSnapshot,
  snapshotToRecords,
} from '@features/member-work-sync/main/infrastructure/memberWorkSyncSqliteMappers';
import { describe, expect, it } from 'vitest';

import type {
  MemberWorkSyncMetricEvent,
  MemberWorkSyncOutboxItem,
  MemberWorkSyncReportIntent,
  MemberWorkSyncStatus,
} from '@features/member-work-sync/contracts';
import type { MemberWorkSyncStoreSnapshot } from '@features/member-work-sync/main/infrastructure/JsonMemberWorkSyncStore';

const ROUTING_TEAM = 'Team-A';
const LEGACY_ALIAS = 'team-a';
const T0 = '2026-07-22T00:00:00.000Z';

function legacyAliasSnapshot(): MemberWorkSyncStoreSnapshot {
  const status: MemberWorkSyncStatus = {
    teamName: LEGACY_ALIAS,
    memberName: 'bob',
    state: 'still_working',
    agenda: {
      teamName: LEGACY_ALIAS,
      memberName: 'bob',
      generatedAt: T0,
      fingerprint: 'agenda:v1:legacy',
      items: [],
      diagnostics: [],
    },
    report: {
      teamName: LEGACY_ALIAS,
      memberName: 'bob',
      state: 'still_working',
      agendaFingerprint: 'agenda:v1:legacy',
      reportedAt: T0,
      accepted: true,
    },
    evaluatedAt: T0,
    diagnostics: [],
  };
  const reportIntent: MemberWorkSyncReportIntent = {
    id: 'intent-1',
    teamName: LEGACY_ALIAS,
    memberName: 'bob',
    request: {
      teamName: LEGACY_ALIAS,
      memberName: 'bob',
      state: 'caught_up',
      agendaFingerprint: 'agenda:v1:legacy',
    },
    reason: 'control_api_unavailable',
    status: 'pending',
    recordedAt: T0,
  };
  const outboxItem: MemberWorkSyncOutboxItem = {
    id: 'outbox-1',
    teamName: LEGACY_ALIAS,
    memberName: 'bob',
    agendaFingerprint: 'agenda:v1:legacy',
    payloadHash: 'proof-bearing-payload-hash',
    payload: {
      from: 'system',
      to: 'bob',
      messageKind: 'member_work_sync_nudge',
      source: 'member-work-sync',
      actionMode: 'do',
      workSyncIntent: 'agenda_sync',
      text: 'continue',
      taskRefs: [
        { teamName: LEGACY_ALIAS, taskId: 'same-team-task', displayId: '1' },
        { teamName: 'other-team', taskId: 'cross-team-task', displayId: '2' },
      ],
    },
    status: 'delivered',
    attemptGeneration: 1,
    deliveredMessageId: 'message-1',
    createdAt: T0,
    updatedAt: T0,
  };
  const metricEvent: MemberWorkSyncMetricEvent = {
    id: 'metric-1',
    teamName: LEGACY_ALIAS,
    memberName: 'bob',
    kind: 'report_accepted',
    state: 'still_working',
    agendaFingerprint: 'agenda:v1:legacy',
    recordedAt: T0,
    actionableCount: 0,
  };
  return {
    statuses: [status],
    reportIntents: [reportIntent],
    outboxItems: [outboxItem],
    metricEvents: [metricEvent],
    filesToArchive: [],
  };
}

describe('member-work-sync SQLite team identity mappers', () => {
  it('uses the routing team for rows and nested owned identities without rewriting task refs', () => {
    const records = snapshotToRecords(ROUTING_TEAM, legacyAliasSnapshot());

    expect(
      [
        ...records.statuses,
        ...records.reportIntents,
        ...records.outboxItems,
        ...records.metricEvents,
      ].map((record) => record.teamName)
    ).toEqual([ROUTING_TEAM, ROUTING_TEAM, ROUTING_TEAM, ROUTING_TEAM]);
    expect(JSON.parse(records.statuses[0].statusJson)).toMatchObject({
      teamName: ROUTING_TEAM,
      agenda: { teamName: ROUTING_TEAM },
      report: { teamName: ROUTING_TEAM },
    });
    expect(JSON.parse(records.reportIntents[0].requestJson)).toMatchObject({
      teamName: ROUTING_TEAM,
    });
    expect(JSON.parse(records.metricEvents[0].eventJson)).toMatchObject({
      teamName: ROUTING_TEAM,
    });
    expect(JSON.parse(records.outboxItems[0].payloadJson)).toMatchObject({
      taskRefs: [
        { teamName: LEGACY_ALIAS, taskId: 'same-team-task' },
        { teamName: 'other-team', taskId: 'cross-team-task' },
      ],
    });
    expect(records.outboxItems[0].payloadHash).toBe('proof-bearing-payload-hash');

    const roundTrip = recordsToSnapshot(ROUTING_TEAM, records);
    expect(roundTrip.statuses[0]).toMatchObject({
      teamName: ROUTING_TEAM,
      agenda: { teamName: ROUTING_TEAM },
      report: { teamName: ROUTING_TEAM },
    });
    expect(roundTrip.reportIntents[0]).toMatchObject({
      teamName: ROUTING_TEAM,
      request: { teamName: ROUTING_TEAM },
    });
    expect(roundTrip.metricEvents[0]?.teamName).toBe(ROUTING_TEAM);
    expect(roundTrip.outboxItems[0]).toMatchObject({
      teamName: ROUTING_TEAM,
      payloadHash: 'proof-bearing-payload-hash',
      payload: {
        taskRefs: [
          { teamName: LEGACY_ALIAS, taskId: 'same-team-task' },
          { teamName: 'other-team', taskId: 'cross-team-task' },
        ],
      },
    });
  });
});
