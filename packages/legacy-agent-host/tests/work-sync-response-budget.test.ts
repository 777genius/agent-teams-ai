import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { assertNativeWorkSyncStatusBudget, projectNativeWorkSyncResult } from '../dist/work-sync/projectNativeWorkSyncResult.js';

import type { JsonValue } from '../dist/contracts.js';
import type { MemberWorkSyncStatus } from '../dist/work-sync/policy/contracts/index.js';

const now = '2026-11-28T10:00:00.000Z';
const commandId = 'TEST-original-work-sync-command';
const reportCommandId = 'work-sync-report:' + createHash('sha256').update(commandId).digest('hex');
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
        commandId: reportCommandId,
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
  const result = projectNativeWorkSyncResult({ commandId,
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
  const result = projectNativeWorkSyncResult({ commandId,
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
  const result = projectNativeWorkSyncResult({ commandId,
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
  const result = projectNativeWorkSyncResult({ commandId,
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

test('over 200 item prescription omits optional IDs without changing full-agenda authority', () => {
  const original = wire(prescribed(status(201)));
  const result = projectNativeWorkSyncResult({ commandId,
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
  assert.throws(() => projectNativeWorkSyncResult({ commandId,
    operation: 'status',
    value: wire({ ...valid, teamName: 'foreign-team' }),
    identity,
  }));
  assert.throws(() => projectNativeWorkSyncResult({ commandId,
    operation: 'status',
    value: wire({ ...valid, nextRequiredToolCall: {
      tool: 'member_work_sync_report',
      arguments: { commandId: reportCommandId, state: 'caught_up',
        agendaFingerprint: 'incorrect', reportToken: 'incorrect' },
    } }),
    identity,
  }));
});

test('compact acknowledgement omits huge private CAS lineage and keeps stopped recovery facts', () => {
  const original = status(3, '任'.repeat(30_000));
  original.statusRevision = { incarnation: identity.incarnation, lineageId: 'L'.repeat(250_000),
    sequence: 1, nonce: 'TEST-original-nonce' };
  original.recoveryHealth = {
    schemaVersion: 1, episodes: [], controlRevision: 7,
    autoResumeStopLatch: { stoppedAt: now, reason: '任'.repeat(100_000), controlRevision: 7 },
  };
  assert.doesNotThrow(() => assertNativeWorkSyncStatusBudget({
    operation: 'status', status: original, identity, budget: 96 * 1024,
  }));
  const source = wire(prescribed(original)), before = wire(source);
  const result = projectNativeWorkSyncResult({ commandId, operation: 'status', value: source, identity });
  const projected = object(result);
  assert.equal(Object.hasOwn(projected, 'statusRevision'), false);
  assert.equal(Object.hasOwn(projected, 'pendingReportReceipt'), false);
  assert.deepEqual(projected.recoveryHealth, { schemaVersion: 1, autoResumeStopped: true,
    controlRevision: 7, autoResumeStopLatch: { stoppedAt: now, controlRevision: 7 }, detailsOmitted: true });
  assert.deepEqual(object(projected.agenda).byKind, { work: 3, review: 0, clarification: 0, blocked_dependency: 0 });
  assert.deepEqual(projectNativeWorkSyncResult({ commandId, operation: 'status', value: result, identity }), result);
  assert.deepEqual(source, before);
});

test('pre-effect essential envelope reserves duplicated historical accepted report and token growth only once', () => {
  const original = status(1);
  original.report = {
    teamName: identity.teamName, memberName: identity.memberName, state: 'still_working',
    agendaFingerprint: 'x'.repeat(125_000), reportedAt: now, accepted: true, source: 'test',
  };
  assert.throws(() => assertNativeWorkSyncStatusBudget({
    operation: 'status', status: original, identity, budget: 240 * 1024,
  }));
  const small = structuredClone(original);
  small.report!.agendaFingerprint = 'x'.repeat(43_344);
  small.reportToken = 'x';
  const budget = 100_000;
  const check = (value: MemberWorkSyncStatus) => assertNativeWorkSyncStatusBudget({
    operation: 'status', status: value, identity, budget,
  });
  assert.doesNotThrow(() => check(small));
  const transitioned = { ...small, reportToken: 'x'.repeat(635), lastAcceptedReport: small.report };
  assert.doesNotThrow(() => check(transitioned));
  small.report!.agendaFingerprint += 'x';
  assert.throws(() => check(small));
});

test('new compact replay rejects malformed counts, changed token and unknown marker without altering originals', () => {
  const result = object(projectNativeWorkSyncResult({ commandId,
    operation: 'status', value: wire(prescribed(status(3, '任'.repeat(30_000)))), identity,
  }));
  for (const patch of [
    { agenda: { ...object(result.agenda), totalItems: 0 } },
    { workSyncProjection: { version: 2, kind: 'compact' } },
    { reportToken: 'TEST-other-token' },
    { statusRevision: { lineageId: 'TEST-private' } },
  ]) {
    assert.throws(() => projectNativeWorkSyncResult({ commandId,
      operation: 'status', value: wire({ ...result, ...patch }), identity,
    }));
  }
  assert.deepEqual(projectNativeWorkSyncResult({ commandId, operation: 'status', value: wire(result), identity }), result);
});


test('versioned compact status with a report token cannot lose its required follow-up', () => {
  const original = object(wire(prescribed(status(3, '任'.repeat(30_000)))));
  const result = object(projectNativeWorkSyncResult({ commandId, operation: 'status', value: wire(original), identity }));
  const removeCall = (value: Record<string, unknown>) => {
    const copy = { ...value };
    for (const key of ['statusOnlyIncomplete', 'nextRequiredAction', 'nextRequiredToolCall', 'reportScope']) delete copy[key];
    return wire(copy);
  };
  assert.throws(() => projectNativeWorkSyncResult({ commandId, operation: 'status', value: removeCall(result), identity }), /hold/);
  assert.throws(() => projectNativeWorkSyncResult({ commandId, operation: 'status', value: removeCall(original), identity }), /hold/);
  assert.deepEqual(projectNativeWorkSyncResult({ commandId, operation: 'status', value: wire(result), identity }), result);
});

test('tokenless compact status and compact report with a token need no prescribed follow-up', () => {
  const original = status(3, '任'.repeat(30_000));
  const tokenless = { ...original, reportToken: undefined, reportTokenExpiresAt: undefined };
  const reply = projectNativeWorkSyncResult({ commandId, operation: 'status', value: wire(tokenless), identity });
  assert.equal(Object.hasOwn(object(reply), 'nextRequiredToolCall'), false);
  assert.deepEqual(projectNativeWorkSyncResult({ commandId, operation: 'status', value: reply, identity }), reply);
  const report = projectNativeWorkSyncResult({ commandId, operation: 'report', identity, value: wire({
    accepted: true, code: 'accepted', message: 'Member work sync report accepted.', status: original,
  }) });
  assert.equal(object(object(report).status).reportToken, original.reportToken);
  assert.deepEqual(projectNativeWorkSyncResult({ commandId, operation: 'report', value: report, identity }), report);
});

test('compact replay refuses a report command derived from another original status command', () => {
  const value = projectNativeWorkSyncResult({ commandId, operation: 'status',
    value: wire(prescribed(status(3, '任'.repeat(30_000)))), identity });
  assert.equal(object(value).detailsOmitted, true);
  const changed = object(wire(value));
  const args = object(object(changed.nextRequiredToolCall).arguments);
  assert.equal(args.commandId, reportCommandId);
  args.commandId = 'work-sync-report:' + createHash('sha256')
    .update('TEST-another-original-command').digest('hex');
  const attempted = wire(changed);
  const before = JSON.stringify(attempted);
  assert.throws(() => projectNativeWorkSyncResult({
    commandId, operation: 'status', value: attempted, identity,
  }), /hold/);
  assert.equal(JSON.stringify(attempted), before);
  assert.deepEqual(projectNativeWorkSyncResult({ commandId, operation: 'status', value, identity }), value);
});

for (const representation of ['full', 'compact'] as const) {
  for (const field of ['reportToken', 'agendaFingerprint'] as const) {
    test(representation + ' status enforces the prescribed ' + field + ' input limit', () => {
      const canonical = status(representation === 'compact' ? 3 : 1,
        representation === 'compact' ? '任'.repeat(30_000) : 'TEST small work');
      const value = projectNativeWorkSyncResult({
        commandId, operation: 'status', value: wire(prescribed(canonical)), identity,
      });
      assert.equal(object(value).detailsOmitted === true, representation === 'compact');
      const setField = (target: Record<string, unknown>, text: string) => {
        object(object(target.nextRequiredToolCall).arguments)[field] = text;
        if (field === 'reportToken') target.reportToken = text;
        else object(target.agenda).fingerprint = text;
      };
      // Projector-contract vectors: synthetic tokens are not presented as valid HMAC proofs.
      const limit = field === 'reportToken' ? 4096 : 256;
      const maximum = object(wire(value));
      setField(maximum, 'x'.repeat(limit));
      assert.ok(Buffer.byteLength(JSON.stringify(maximum)) <= 240 * 1024);
      assert.deepEqual(projectNativeWorkSyncResult({
        commandId, operation: 'status', value: wire(maximum), identity,
      }), maximum);
      const excessive = object(wire(maximum));
      setField(excessive, 'x'.repeat(limit + 1));
      const attempted = wire(excessive);
      const before = JSON.stringify(attempted);
      assert.throws(() => projectNativeWorkSyncResult({
        commandId, operation: 'status', value: attempted, identity,
      }), /hold/);
      assert.equal(JSON.stringify(attempted), before);
      if (representation === 'compact' && field === 'reportToken') {
        // A retained REPORT token is a scalar; no follow-up tool call is prescribed.
        const report = object(projectNativeWorkSyncResult({ commandId, operation: 'report',
          value: wire({ accepted: true, code: 'accepted', message: 'TEST retained report',
            status: { ...canonical, reportToken: 'x'.repeat(limit + 1) } }), identity }));
        assert.equal(report.accepted, true);
        assert.equal(object(report.status).reportToken, 'x'.repeat(limit + 1));
        assert.equal(Object.hasOwn(object(report.status), 'nextRequiredToolCall'), false);
      }
    });
  }
}
