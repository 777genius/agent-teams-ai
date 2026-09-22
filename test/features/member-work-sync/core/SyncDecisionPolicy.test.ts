import { decideMemberWorkSyncStatus } from '@features/member-work-sync/core/domain';
import { describe, expect, it } from 'vitest';

import type { MemberWorkSyncAgenda, MemberWorkSyncReport } from '@features/member-work-sync/contracts';

describe('decideMemberWorkSyncStatus', () => {
  it('returns caught_up when canonical filtering leaves no actionable work', () => {
    const agenda: MemberWorkSyncAgenda = {
      teamName: 'forge-labs',
      memberName: 'jack',
      generatedAt: '2026-05-06T19:06:07.257Z',
      fingerprint: 'agenda-empty',
      items: [],
      diagnostics: [],
    };
    const staleReport: MemberWorkSyncReport = {
      teamName: 'forge-labs',
      memberName: 'jack',
      state: 'still_working',
      agendaFingerprint: 'stale-owned-in-progress-task',
      reportedAt: '2026-05-06T19:00:26.089Z',
      accepted: true,
    };

    const decision = decideMemberWorkSyncStatus({
      agenda,
      latestAcceptedReport: staleReport,
      nowIso: '2026-05-06T19:06:07.257Z',
    });

    expect(decision.state).toBe('caught_up');
    expect(decision.acceptedReport).toBeUndefined();
    expect(decision.diagnostics).toContain('agenda_empty');
  });

  it('does not carry stale work reports into an empty caught_up agenda', () => {
    const agenda: MemberWorkSyncAgenda = {
      teamName: 'forge-labs',
      memberName: 'jack',
      generatedAt: '2026-05-06T19:06:07.257Z',
      fingerprint: 'agenda-empty',
      items: [],
      diagnostics: [],
    };
    const legacyReport: MemberWorkSyncReport = {
      teamName: 'forge-labs',
      memberName: 'jack',
      state: 'still_working',
      agendaFingerprint: agenda.fingerprint,
      reportedAt: '2026-05-06T19:00:26.089Z',
      expiresAt: '2026-05-06T19:15:26.089Z',
      accepted: true,
    };

    const decision = decideMemberWorkSyncStatus({
      agenda,
      latestAcceptedReport: legacyReport,
      nowIso: '2026-05-06T19:06:07.257Z',
    });

    expect(decision).toEqual({
      state: 'caught_up',
      diagnostics: ['agenda_empty'],
    });
  });

  it('treats accepted work reports without a lease as needs_sync', () => {
    const agenda: MemberWorkSyncAgenda = {
      teamName: 'forge-labs',
      memberName: 'jack',
      generatedAt: '2026-05-06T19:06:07.257Z',
      fingerprint: 'agenda-active',
      items: [
        {
          taskId: 'task-1',
          displayId: '11111111',
          subject: 'Ship it',
          kind: 'work',
          assignee: 'jack',
          priority: 'normal',
          reason: 'owned_in_progress_task',
          evidence: {
            status: 'in_progress',
            owner: 'jack',
          },
        },
      ],
      diagnostics: [],
    };
    const unboundedReport: MemberWorkSyncReport = {
      teamName: 'forge-labs',
      memberName: 'jack',
      state: 'still_working',
      agendaFingerprint: agenda.fingerprint,
      reportedAt: '2026-05-06T19:00:26.089Z',
      accepted: true,
    };

    const decision = decideMemberWorkSyncStatus({
      agenda,
      latestAcceptedReport: unboundedReport,
      nowIso: '2026-05-06T19:06:07.257Z',
    });

    expect(decision).toEqual({
      state: 'needs_sync',
      diagnostics: ['report_lease_missing'],
    });
  });

  it('treats work reports as needs_sync when the current time is invalid', () => {
    const agenda: MemberWorkSyncAgenda = {
      teamName: 'forge-labs',
      memberName: 'jack',
      generatedAt: '2026-05-06T19:06:07.257Z',
      fingerprint: 'agenda-active',
      items: [
        {
          taskId: 'task-1',
          subject: 'Ship it',
          kind: 'work',
          assignee: 'jack',
          priority: 'normal',
          reason: 'owned_in_progress_task',
          evidence: {
            status: 'in_progress',
            owner: 'jack',
          },
        },
      ],
      diagnostics: [],
    };
    const report: MemberWorkSyncReport = {
      teamName: 'forge-labs',
      memberName: 'jack',
      state: 'blocked',
      agendaFingerprint: agenda.fingerprint,
      reportedAt: '2026-05-06T19:00:26.089Z',
      expiresAt: '2026-05-06T20:00:26.089Z',
      accepted: true,
    };

    const decision = decideMemberWorkSyncStatus({
      agenda,
      latestAcceptedReport: report,
      nowIso: 'not-a-date',
    });

    expect(decision).toEqual({
      state: 'needs_sync',
      diagnostics: ['report_lease_missing'],
    });
  });
});
