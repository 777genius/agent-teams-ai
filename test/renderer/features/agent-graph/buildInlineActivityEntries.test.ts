import { describe, expect, it } from 'vitest';

import {
  buildInlineActivityEntries,
  getGraphLeadMemberName,
} from '@renderer/features/agent-graph/utils/buildInlineActivityEntries';

import type { InboxMessage, TeamData, TeamTaskWithKanban } from '@shared/types/team';

function createBaseTeamData(
  overrides?: Partial<TeamData> & {
    tasks?: TeamTaskWithKanban[];
    messages?: InboxMessage[];
  }
): TeamData {
  return {
    teamName: 'my-team',
    config: {
      name: 'My Team',
      members: [{ name: 'team-lead' }, { name: 'alice' }, { name: 'bob' }],
      projectPath: '/repo',
    },
    members: [
      {
        name: 'team-lead',
        status: 'active',
        currentTaskId: null,
        taskCount: 0,
        lastActiveAt: null,
        messageCount: 0,
        agentType: 'team-lead',
      },
      {
        name: 'alice',
        status: 'active',
        currentTaskId: null,
        taskCount: 1,
        lastActiveAt: null,
        messageCount: 0,
      },
      {
        name: 'bob',
        status: 'active',
        currentTaskId: null,
        taskCount: 1,
        lastActiveAt: null,
        messageCount: 0,
      },
    ],
    tasks: [],
    messages: [],
    kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
    processes: [],
    isAlive: true,
    ...overrides,
  };
}

describe('buildInlineActivityEntries', () => {
  it('keeps original inbox messages for member lanes and preserves route metadata', () => {
    const data = createBaseTeamData({
      messages: [
        {
          from: 'team-lead',
          to: 'alice',
          text: 'New task assigned',
          timestamp: '2026-03-28T19:00:01.000Z',
          read: false,
          messageId: 'msg-1',
        },
      ],
    });
    const entries = buildInlineActivityEntries({
      data,
      teamName: 'my-team',
      leadId: 'lead:my-team',
      leadName: getGraphLeadMemberName(data, 'my-team'),
      ownerNodeIds: new Set(['lead:my-team', 'member:my-team:alice', 'member:my-team:bob']),
    });

    const aliceEntries = entries.get('member:my-team:alice') ?? [];
    expect(aliceEntries).toHaveLength(1);
    expect(aliceEntries[0]?.graphItem).toEqual(
      expect.objectContaining({
        id: 'activity:msg:my-team:msg-1',
        title: 'team-lead -> alice',
        preview: 'New task assigned',
      })
    );
    expect(aliceEntries[0]?.message).toMatchObject({
      from: 'team-lead',
      to: 'alice',
      messageId: 'msg-1',
    });
  });

  it('builds synthetic comment messages that open with full task context and route owner-self comments to lead', () => {
    const data = createBaseTeamData({
      tasks: [
        {
          id: 'task-1',
          displayId: '#8fdd6803',
          subject: 'Review contributor notes',
          owner: 'jack',
          status: 'in_progress',
          comments: [
            {
              id: 'comment-1',
              author: 'jack',
              text: 'Короткий отчет по contributor pass',
              createdAt: '2026-03-28T19:00:02.000Z',
              type: 'regular',
            },
          ],
          reviewState: 'none',
        } as unknown as TeamTaskWithKanban,
      ],
      members: [
        {
          name: 'team-lead',
          status: 'active',
          currentTaskId: null,
          taskCount: 0,
          lastActiveAt: null,
          messageCount: 0,
          agentType: 'team-lead',
        },
        {
          name: 'jack',
          status: 'active',
          currentTaskId: null,
          taskCount: 1,
          lastActiveAt: null,
          messageCount: 0,
        },
      ],
    });

    const entries = buildInlineActivityEntries({
      data,
      teamName: 'my-team',
      leadId: 'lead:my-team',
      leadName: getGraphLeadMemberName(data, 'my-team'),
      ownerNodeIds: new Set(['lead:my-team', 'member:my-team:jack']),
    });

    const jackEntries = entries.get('member:my-team:jack') ?? [];
    expect(jackEntries).toHaveLength(1);
    expect(jackEntries[0]?.graphItem).toEqual(
      expect.objectContaining({
        id: 'activity:comment:my-team:task-1:comment-1',
        kind: 'task_comment',
        title: '#8fdd6803 Review contributor notes',
        preview: 'Короткий отчет по contributor pass',
      })
    );
    expect(jackEntries[0]?.message).toMatchObject({
      from: 'jack',
      to: 'team-lead',
      summary: '#8fdd6803 Короткий отчет по contributor pass',
      messageKind: 'task_comment_notification',
      taskRefs: [{ taskId: 'task-1', displayId: '#8fdd6803', teamName: 'my-team' }],
    });
  });
});
