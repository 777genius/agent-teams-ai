import assert from 'node:assert/strict';
import { test } from 'node:test';

import { projectNativeWorkSyncResult } from '../dist/work-sync/projectNativeWorkSyncResult.js';

import type { JsonValue } from '../dist/contracts.js';
import type { MemberWorkSyncStatus } from '../dist/work-sync/policy/contracts/index.js';

const now = '2026-11-28T10:00:00.000Z';
const identity = { teamName: 'TEST-team', memberName: 'alice', incarnation: 'TEST-team-id' };

function status(count: number, subject = 'TEST work'): MemberWorkSyncStatus {
  return {
    teamName: identity.teamName,
    memberName: identity.memberName,
    state: 'needs_sync',
    evaluatedAt: now,
    diagnostics: [],
    providerId: 'opencode',
    reportToken: 'TEST-original-report-token',
    reportTokenExpiresAt: now,
    agenda: {
      teamName: identity.teamName,
      memberName: identity.memberName,
      fingerprint: 'TEST-original-fingerprint',
      generatedAt: now,
      sourceRevision: 'TEST-original-revision',
      diagnostics: [],
      items: Array.from({ length: count }, (_, index) => ({
        taskId: 'TEST-task-' + index,
        subject,
        kind: 'work' as const,
        assignee: identity.memberName,
        priority: 'normal' as const,
        reason: 'TEST current work',
        evidence: { status: 'pending' },
      })),
    },
  };
}

function prescribed(value: MemberWorkSyncStatus) {
  return {
    ...value,
    statusOnlyIncomplete: true,
    nextRequiredAction: 'Call member_work_sync_report before going idle.',
    nextRequiredToolCall: {
      tool: 'member_work_sync_report',
      arguments: {
        commandId: 'TEST-report-command',
        state: 'still_working',
        agendaFingerprint: value.agenda.fingerprint,
        reportToken: value.reportToken,
        taskIds: value.agenda.items.map((item) => item.taskId),
      },
    },
  };
}

function wire(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function object(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

test('small work-sync status preserves the full existing result and exact report arguments', () => {
  const original = wire(prescribed(status(2)));
  const result = projectNativeWorkSyncResult({
    operation: 'status',
    value: original,
    identity,
  });
  assert.deepEqual(result, original);
  assert.deepEqual(
    object(object(result).nextRequiredToolCall).arguments,
    object(object(original).nextRequiredToolCall).arguments
  );
});

test('three accepted CJK task subjects stay in canonical input but yield bounded status and report token', () => {
  const original = wire(prescribed(status(3, '任'.repeat(30_000))));
  assert.ok(Buffer.byteLength(JSON.stringify(original)) > 256 * 1024);
  const before = wire(original);
  const result = projectNativeWorkSyncResult({
    operation: 'status',
    value: original,
    identity,
  });
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 240 * 1024);
  const projected = object(result), agenda = object(projected.agenda);
  assert.equal(projected.detailsOmitted, true);
  assert.equal(projected.reportToken, 'TEST-original-report-token');
  assert.equal(agenda.fingerprint, 'TEST-original-fingerprint');
  assert.equal(agenda.totalItems, 3);
  assert.equal(agenda.itemsOmitted, true);
  assert.equal(Object.hasOwn(agenda, 'items'), false);
  const call = object(projected.nextRequiredToolCall);
  assert.equal(call.tool, 'member_work_sync_report');
  const args = object(call.arguments);
  assert.equal(args.agendaFingerprint, 'TEST-original-fingerprint');
  assert.equal(args.reportToken, 'TEST-original-report-token');
  assert.equal(args.state, 'still_working');
  assert.equal(Object.hasOwn(args, 'taskIds'), false);
  assert.match(String(projected.detailsNotice), /task_briefing/);
  assert.deepEqual(original, before, 'canonical source and original arguments are not mutated');
});

test('six CJK subjects no longer force a too-large completed command result', () => {
  const original = wire(prescribed(status(6, '任'.repeat(30_000))));
  assert.ok(Buffer.byteLength(JSON.stringify(original)) > 512 * 1024);
  const result = projectNativeWorkSyncResult({
    operation: 'status',
    value: original,
    identity,
  });
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 240 * 1024);
  assert.equal(object(object(result).agenda).totalItems, 6);
  assert.equal(object(result).statusOnlyIncomplete, true);
});

test('report preserves its accepted outcome while omitting oversized nested status', () => {
  const value = status(6, '任'.repeat(30_000));
  const original = wire({
    accepted: true,
    code: 'accepted',
    message: 'Member work sync report accepted.',
    status: value,
  });
  const result = projectNativeWorkSyncResult({
    operation: 'report',
    value: original,
    identity,
  });
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 240 * 1024);
  const projected = object(result), nested = object(projected.status);
  assert.equal(projected.accepted, true);
  assert.equal(projected.code, 'accepted');
  assert.equal(projected.message, 'Member work sync report accepted.');
  assert.equal(nested.detailsOmitted, true);
  assert.equal(object(nested.agenda).fingerprint, value.agenda.fingerprint);
});

test('bounded status and report retain distinct current and accepted CI wait facts', () => {
  const value = status(6, '任'.repeat(30_000));
  const report: NonNullable<MemberWorkSyncStatus['report']> = {
    teamName: identity.teamName, memberName: identity.memberName, state: 'blocked',
    agendaFingerprint: value.agenda.fingerprint, reportedAt: now, accepted: true, source: 'mcp',
    wait: { kind: 'ci', repository: 'TEST/project', runId: '2', expectedCommit: 'b'.repeat(40),
      taskId: 'TEST-task-0', horizonAt: now, status: 'pending',
      supersedes: { runId: '1', expectedCommit: 'a'.repeat(40) } },
  };
  value.report = { ...report, accepted: false, rejectionCode: 'stale_token',
    wait: { ...report.wait!, runId: '3', expectedCommit: 'c'.repeat(40) } };
  value.lastAcceptedReport = structuredClone(report);
  for (const operation of ['status', 'report'] as const) {
    const original = wire(operation === 'status' ? prescribed(value) : {
      accepted: false, code: 'stale_token', message: 'The original report token is stale.', status: value,
    });
    const before = wire(original);
    assert.ok(Buffer.byteLength(JSON.stringify(original)) > 512 * 1024);
    const result = projectNativeWorkSyncResult({ operation, value: original, identity });
    const projected = operation === 'status' ? object(result) : object(object(result).status);
    assert.deepEqual(object(projected.report).wait, value.report.wait);
    assert.deepEqual(object(projected.lastAcceptedReport).wait, report.wait);
    assert.equal(object(projected.report).accepted, false);
    assert.equal(object(projected.lastAcceptedReport).accepted, true);
    assert.equal(projected.reportToken, value.reportToken);
    assert.equal(object(projected.agenda).fingerprint, value.agenda.fingerprint);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 240 * 1024);
    assert.deepEqual(projectNativeWorkSyncResult({ operation, value: result, identity }), result,
      'completed compact readback preserves the exact bounded result');
    assert.deepEqual(original, before, 'projection never rewrites the original facts');
  }
});

test('over 200 item prescription omits optional IDs without changing full-agenda authority', () => {
  const original = wire(prescribed(status(201)));
  const result = projectNativeWorkSyncResult({
    operation: 'status',
    value: original,
    identity,
  });
  const projected = object(result), args = object(object(projected.nextRequiredToolCall).arguments);
  assert.equal(projected.reportScope, 'The report covers the entire original agenda; taskIds is omitted.');
  assert.equal(args.agendaFingerprint, 'TEST-original-fingerprint');
  assert.equal(args.reportToken, 'TEST-original-report-token');
  assert.equal(Object.hasOwn(args, 'taskIds'), false);
  assert.equal(Array.isArray(object(projected.agenda).items), true);
  assert.equal(object(original).statusOnlyIncomplete, true);
});

test('oversized malformed identity or required report call holds rather than inventing success', () => {
  const valid = object(wire(prescribed(status(3, '任'.repeat(30_000)))));
  assert.throws(() => projectNativeWorkSyncResult({
    operation: 'status',
    value: wire({ ...valid, teamName: 'foreign-team' }),
    identity,
  }));
  assert.throws(() => projectNativeWorkSyncResult({
    operation: 'status',
    value: wire({ ...valid, nextRequiredToolCall: {
      tool: 'member_work_sync_report',
      arguments: { commandId: 'TEST-report-command', state: 'caught_up',
        agendaFingerprint: 'incorrect', reportToken: 'incorrect' },
    } }),
    identity,
  }));
});
