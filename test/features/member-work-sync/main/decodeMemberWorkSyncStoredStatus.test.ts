import { decodeMemberWorkSyncStoredStatus } from '@features/member-work-sync/main/infrastructure/decodeMemberWorkSyncStoredStatus';
import { describe, expect, it } from 'vitest';

import type { MemberWorkSyncStatus } from '@features/member-work-sync/contracts';

const identity = { teamName: 'sandbox', memberName: 'alice', incarnation: 'incarnation-1' };
const time = '2026-09-10T00:00:00.000Z';

function makeStatus(): MemberWorkSyncStatus {
  return {
    teamName: ' Sandbox ',
    memberName: ' Alice ',
    state: 'needs_sync',
    evaluatedAt: time,
    diagnostics: [],
    agenda: {
      teamName: 'SANDBOX',
      memberName: 'ALICE',
      generatedAt: time,
      fingerprint: 'agenda',
      diagnostics: [],
      items: [
        {
          taskId: 'task-1',
          subject: 'Test',
          kind: 'work',
          assignee: 'alice',
          priority: 'normal',
          reason: 'owned_pending_task',
          evidence: { status: 'pending', owner: 'alice' },
        },
      ],
    },
    shadow: { reconciledBy: 'queue', wouldNudge: true, fingerprintChanged: false },
    statusRevision: {
      incarnation: identity.incarnation,
      lineageId: 'lineage-1',
      sequence: 1,
      nonce: 'nonce-1',
    },
  };
}

describe('stored status authority decoder', () => {
  it('validates without changing bytes or dropping independent fields', () => {
    const status = makeStatus();
    Object.assign(status, { futureDiagnostic: { detail: 'preserved' } });
    const raw = JSON.stringify(status);
    const decoded = decodeMemberWorkSyncStoredStatus(status, identity);
    expect(decoded).toBe(status);
    expect(JSON.stringify(decoded)).toBe(raw);
  });

  it('allows genuine legacy payload but does not synthesize a revision', () => {
    const status = makeStatus();
    delete status.statusRevision;
    expect(decodeMemberWorkSyncStoredStatus(status, identity).statusRevision).toBeUndefined();
  });

  const invalid: [string, (status: MemberWorkSyncStatus) => void][] = [
    [
      'unknown state',
      (s) => {
        Object.assign(s, { state: 'sleeping' });
      },
    ],
    [
      'invalid date',
      (s) => {
        s.evaluatedAt = 'yesterday';
      },
    ],
    [
      'missing agenda',
      (s) => {
        Object.assign(s, { agenda: null });
      },
    ],
    [
      'invalid task',
      (s) => {
        Object.assign(s.agenda, { items: [{ taskId: 'task-1' }] });
      },
    ],
    [
      'invalid evidence flag',
      (s) => {
        Object.assign(s.agenda.items[0].evidence, { canBypassPhase2: 'yes' });
      },
    ],
    [
      'wrong status owner',
      (s) => {
        s.memberName = 'bob';
      },
    ],
    [
      'wrong agenda team',
      (s) => {
        s.agenda.teamName = 'other';
      },
    ],
    [
      'wrong incarnation',
      (s) => {
        s.statusRevision!.incarnation = 'incarnation-2';
      },
    ],
    [
      'invalid sequence',
      (s) => {
        s.statusRevision!.sequence = 1.5;
      },
    ],
    [
      'null revision',
      (s) => {
        Object.assign(s, { statusRevision: null });
      },
    ],
    [
      'invalid report',
      (s) => {
        Object.assign(s, { report: { accepted: true } });
      },
    ],
    [
      'invalid shadow',
      (s) => {
        Object.assign(s, { shadow: { wouldNudge: true } });
      },
    ],
    [
      'invalid suppression counter',
      (s) => {
        Object.assign(s.shadow!, {
          nudgeSuppression: {
            reason: 'no_accepted_report',
            agendaFingerprint: 'agenda',
            deliveredCount: -1,
            suppressedAt: time,
          },
        });
      },
    ],
    [
      'invalid recovery identity',
      (s) => {
        Object.assign(s.shadow!, {
          recovery: {
            kind: 'proof_missing',
            intentKey: '',
            originalMessageId: 'm1',
            taskIds: ['task-1'],
          },
        });
      },
    ],
  ];
  it.each(invalid)('fails closed for %s', (_name, mutate) => {
    const status = makeStatus();
    mutate(status);
    expect(() => decodeMemberWorkSyncStoredStatus(status, identity)).toThrow();
  });

  it('retains rejected-report diagnostics with an empty invalid input fingerprint', () => {
    const status = makeStatus();
    status.report = {
      teamName: 'sandbox',
      memberName: 'alice',
      state: 'still_working',
      agendaFingerprint: '',
      reportedAt: time,
      accepted: false,
      rejectionCode: 'invalid_report',
    };
    expect(decodeMemberWorkSyncStoredStatus(status, identity).report).toEqual(status.report);
  });

  it.each(['', '  '])(
    'preserves rejected diagnostic task ID %j but rejects accepted use',
    (taskId) => {
      const status = makeStatus();
      status.report = {
        teamName: 'sandbox',
        memberName: 'alice',
        state: 'still_working',
        agendaFingerprint: '',
        reportedAt: time,
        accepted: false,
        taskIds: [taskId],
        rejectionCode: 'invalid_report',
      };
      const raw = JSON.stringify(status);
      expect(JSON.stringify(decodeMemberWorkSyncStoredStatus(status, identity))).toBe(raw);
      status.report.accepted = true;
      expect(() => decodeMemberWorkSyncStoredStatus(status, identity)).toThrow('invalid_status');
    }
  );

  it('rejects a report belonging to another member even when the status matches', () => {
    const status = makeStatus();
    status.report = {
      teamName: 'sandbox',
      memberName: 'bob',
      state: 'still_working',
      agendaFingerprint: 'agenda',
      reportedAt: time,
      expiresAt: time,
      accepted: true,
    };
    expect(() => decodeMemberWorkSyncStoredStatus(status, identity)).toThrow('identity_mismatch');
  });
});

describe('independent accepted report persistence', () => {
  const report = () => ({
    teamName: 'Sandbox',
    memberName: 'Alice',
    state: 'still_working' as const,
    agendaFingerprint: 'agenda',
    reportedAt: time,
    expiresAt: '2026-09-10T00:15:00.000Z',
    taskIds: ['task-1'],
    source: 'app' as const,
    accepted: true,
  });
  it('retains accepted history beside rejected diagnostics without mutation', () => {
    const status = makeStatus();
    status.lastAcceptedReport = report();
    status.report = {
      ...report(),
      accepted: false,
      rejectionCode: 'foreign_task_id',
      taskIds: [''],
    };
    const raw = JSON.stringify(status);
    expect(decodeMemberWorkSyncStoredStatus(status, identity)).toBe(status);
    expect(JSON.stringify(status)).toBe(raw);
  });
  it.each(['member', 'team', 'rejected', 'timestamp'])(
    'rejects invalid last accepted %s evidence',
    (flaw) => {
      const status = makeStatus();
      status.report = report();
      status.lastAcceptedReport = report();
      if (flaw === 'member') status.lastAcceptedReport.memberName = 'bob';
      if (flaw === 'team') status.lastAcceptedReport.teamName = 'other';
      if (flaw === 'rejected') status.lastAcceptedReport.accepted = false;
      if (flaw === 'timestamp') status.lastAcceptedReport.expiresAt = 'bad';
      expect(() => decodeMemberWorkSyncStoredStatus(status, identity)).toThrow();
    }
  );
});
