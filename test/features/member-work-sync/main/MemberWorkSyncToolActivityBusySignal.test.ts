import { MemberWorkSyncToolActivityBusySignal } from '@features/member-work-sync/main/infrastructure/MemberWorkSyncToolActivityBusySignal';
import { describe, expect, it } from 'vitest';

import type { TeamChangeEvent, ToolActivityEventPayload } from '@shared/types';

function toolEvent(teamName: string, payload: ToolActivityEventPayload): TeamChangeEvent {
  return {
    type: 'tool-activity',
    teamName,
    detail: JSON.stringify(payload),
  };
}

describe('MemberWorkSyncToolActivityBusySignal', () => {
  it('treats active tools as busy and recent finishes as a bounded quiet window', async () => {
    const signal = new MemberWorkSyncToolActivityBusySignal({ busyGraceMs: 90_000 });

    signal.noteTeamChange(
      toolEvent('team-a', {
        action: 'start',
        activity: {
          memberName: 'bob',
          toolUseId: 'tool-1',
          toolName: 'bash',
          startedAt: '2026-04-29T00:00:00.000Z',
          source: 'runtime',
        },
      })
    );

    await expect(
      signal.isBusy({
        teamName: 'team-a',
        memberName: 'bob',
        nowIso: '2026-04-29T00:00:15.000Z',
      })
    ).resolves.toMatchObject({
      busy: true,
      reason: 'active_tool_activity',
      retryAfterIso: '2026-04-29T00:01:45.000Z',
    });

    signal.noteTeamChange(
      toolEvent('team-a', {
        action: 'finish',
        memberName: 'bob',
        toolUseId: 'tool-1',
        finishedAt: '2026-04-29T00:01:00.000Z',
      })
    );

    await expect(
      signal.isBusy({
        teamName: 'team-a',
        memberName: 'bob',
        nowIso: '2026-04-29T00:01:30.000Z',
      })
    ).resolves.toMatchObject({
      busy: true,
      reason: 'recent_tool_activity',
      retryAfterIso: '2026-04-29T00:02:30.000Z',
    });

    await expect(
      signal.isBusy({
        teamName: 'team-a',
        memberName: 'bob',
        nowIso: '2026-04-29T00:02:31.000Z',
      })
    ).resolves.toEqual({ busy: false });
  });

  it('does not leak activity across members and clears targeted reset events', async () => {
    const signal = new MemberWorkSyncToolActivityBusySignal({ busyGraceMs: 90_000 });

    signal.noteTeamChange(
      toolEvent('team-a', {
        action: 'start',
        activity: {
          memberName: 'bob',
          toolUseId: 'tool-1',
          toolName: 'read',
          startedAt: '2026-04-29T00:00:00.000Z',
          source: 'member_log',
        },
      })
    );

    await expect(
      signal.isBusy({
        teamName: 'team-a',
        memberName: 'alice',
        nowIso: '2026-04-29T00:00:15.000Z',
      })
    ).resolves.toEqual({ busy: false });

    signal.noteTeamChange(
      toolEvent('team-a', {
        action: 'reset',
        memberName: 'bob',
        toolUseIds: ['tool-1'],
      })
    );

    await expect(
      signal.isBusy({
        teamName: 'team-a',
        memberName: 'bob',
        nowIso: '2026-04-29T00:00:15.000Z',
      })
    ).resolves.toEqual({ busy: false });
  });

  it('drops all tracked activity for a team when it goes offline', async () => {
    const signal = new MemberWorkSyncToolActivityBusySignal({ busyGraceMs: 90_000 });

    signal.noteTeamChange(
      toolEvent('team-a', {
        action: 'start',
        activity: {
          memberName: 'bob',
          toolUseId: 'tool-1',
          toolName: 'write',
          startedAt: '2026-04-29T00:00:00.000Z',
          source: 'runtime',
        },
      })
    );

    signal.noteTeamChange({
      type: 'lead-activity',
      teamName: 'team-a',
      detail: 'offline',
    });

    await expect(
      signal.isBusy({
        teamName: 'team-a',
        memberName: 'bob',
        nowIso: '2026-04-29T00:00:15.000Z',
      })
    ).resolves.toEqual({ busy: false });
  });

  it('expires stale active tools when the finish event is missing', async () => {
    const signal = new MemberWorkSyncToolActivityBusySignal({
      busyGraceMs: 90_000,
      activeToolStaleMs: 10 * 60_000,
    });

    signal.noteTeamChange(
      toolEvent('team-a', {
        action: 'start',
        activity: {
          memberName: 'bob',
          toolUseId: 'tool-1',
          toolName: 'bash',
          startedAt: '2026-04-29T00:00:00.000Z',
          source: 'runtime',
        },
      })
    );

    await expect(
      signal.isBusy({
        teamName: 'team-a',
        memberName: 'bob',
        nowIso: '2026-04-29T00:09:59.000Z',
      })
    ).resolves.toMatchObject({
      busy: true,
      reason: 'active_tool_activity',
    });

    await expect(
      signal.isBusy({
        teamName: 'team-a',
        memberName: 'bob',
        nowIso: '2026-04-29T00:10:00.000Z',
      })
    ).resolves.toEqual({ busy: false });
  });
});
