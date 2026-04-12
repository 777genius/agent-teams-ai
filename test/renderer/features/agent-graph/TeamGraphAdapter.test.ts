import { describe, expect, it } from 'vitest';

import { TeamGraphAdapter } from '@renderer/features/agent-graph/adapters/TeamGraphAdapter';

import type { InboxMessage, TeamData, TeamTaskWithKanban } from '@shared/types/team';
import type { GraphDataPort } from '@claude-teams/agent-graph';

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

function findNode(graph: GraphDataPort, nodeId: string) {
  return graph.nodes.find((node) => node.id === nodeId);
}

describe('TeamGraphAdapter particles', () => {
  it('creates a message particle for a new incoming message from the newest message set', () => {
    const adapter = TeamGraphAdapter.create();
    const baseline = createBaseTeamData();
    adapter.adapt(baseline, 'my-team');

    const next = createBaseTeamData({
      messages: [
        {
          from: 'alice',
          to: 'team-lead',
          text: 'Please check the latest build output now',
          timestamp: '2026-03-28T19:00:01.000Z',
          read: false,
          messageId: 'msg-new',
        },
      ],
    });

    const graph = adapter.adapt(next, 'my-team');

    expect(graph.particles).toHaveLength(1);
    expect(graph.particles[0]).toMatchObject({
      kind: 'inbox_message',
      progress: 0,
      label: '✉ Please check the latest build output now',
    });
  });

  it('creates a comment particle for the first new task comment with preview text', () => {
    const adapter = TeamGraphAdapter.create();
    const baseline = createBaseTeamData({
      tasks: [
        {
          id: 'task-1',
          displayId: '#1',
          subject: 'Investigate',
          owner: 'alice',
          status: 'in_progress',
          comments: [],
          reviewState: 'none',
        } as TeamTaskWithKanban,
      ],
    });
    adapter.adapt(baseline, 'my-team');

    const next = createBaseTeamData({
      tasks: [
        {
          id: 'task-1',
          displayId: '#1',
          subject: 'Investigate',
          owner: 'alice',
          status: 'in_progress',
          comments: [
            {
              id: 'comment-1',
              author: 'alice',
              text: 'Need clarification on the acceptance criteria before I continue',
              createdAt: '2026-03-28T19:00:02.000Z',
              type: 'regular',
            },
          ],
          reviewState: 'none',
        } as TeamTaskWithKanban,
      ],
    });

    const graph = adapter.adapt(next, 'my-team');

    expect(graph.particles).toHaveLength(1);
    expect(graph.particles[0]).toMatchObject({
      kind: 'task_comment',
      label: '💬 Need clarification on the acceptance criteria befor…',
    });
  });

  it('creates a synthetic message edge for comments from non-owner participants', () => {
    const adapter = TeamGraphAdapter.create();
    const baseline = createBaseTeamData({
      tasks: [
        {
          id: 'task-2',
          displayId: '#2',
          subject: 'Fix regression',
          owner: 'bob',
          status: 'in_progress',
          comments: [],
          reviewState: 'none',
        } as TeamTaskWithKanban,
      ],
    });
    adapter.adapt(baseline, 'my-team');

    const next = createBaseTeamData({
      tasks: [
        {
          id: 'task-2',
          displayId: '#2',
          subject: 'Fix regression',
          owner: 'bob',
          status: 'in_progress',
          comments: [
            {
              id: 'comment-2',
              author: 'alice',
              text: 'I found the root cause, handing notes over now',
              createdAt: '2026-03-28T19:00:03.000Z',
              type: 'regular',
            },
          ],
          reviewState: 'none',
        } as TeamTaskWithKanban,
      ],
    });

    const graph = adapter.adapt(next, 'my-team');

    expect(graph.particles).toHaveLength(1);
    expect(graph.particles[0]).toMatchObject({
      kind: 'task_comment',
      label: '💬 I found the root cause, handing notes over now',
    });
    expect(
      graph.edges.some((edge) => edge.id === 'edge:msg:member:my-team:alice:task:my-team:task-2')
    ).toBe(true);
  });

  it('does not collapse two new inbox particles that share a timestamp but differ in content', () => {
    const adapter = TeamGraphAdapter.create();
    adapter.adapt(createBaseTeamData(), 'my-team');

    const next = createBaseTeamData({
      messages: [
        {
          from: 'alice',
          to: 'team-lead',
          text: 'First payload',
          timestamp: '2026-03-28T19:00:01.000Z',
          read: false,
        },
        {
          from: 'bob',
          to: 'team-lead',
          text: 'Second payload',
          timestamp: '2026-03-28T19:00:01.000Z',
          read: false,
        },
      ],
    });

    const graph = adapter.adapt(next, 'my-team');

    expect(graph.particles).toHaveLength(2);
    expect(graph.particles.every((particle) => particle.kind === 'inbox_message')).toBe(true);
  });

  it('uses peer-summary text for idle particles instead of generic idle', () => {
    const adapter = TeamGraphAdapter.create();
    adapter.adapt(createBaseTeamData(), 'my-team');

    const next = createBaseTeamData({
      messages: [
        {
          from: 'alice',
          to: 'team-lead',
          text: JSON.stringify({
            type: 'idle_notification',
            idleReason: 'available',
            summary: '[to bob] aligned on rollout order',
          }),
          timestamp: '2026-04-08T19:00:01.000Z',
          read: true,
          messageId: 'idle-summary-1',
        },
      ],
    });

    const graph = adapter.adapt(next, 'my-team');

    expect(graph.particles).toHaveLength(1);
    expect(graph.particles[0]).toMatchObject({
      kind: 'inbox_message',
      label: '[to bob] aligned on rollout order',
    });
  });

  it('creates particles for each newly appended task comment, not only the latest one', () => {
    const adapter = TeamGraphAdapter.create();
    const baseline = createBaseTeamData({
      tasks: [
        {
          id: 'task-4',
          displayId: '#4',
          subject: 'Burst comments',
          owner: 'alice',
          status: 'in_progress',
          comments: [],
          reviewState: 'none',
        } as TeamTaskWithKanban,
      ],
    });
    adapter.adapt(baseline, 'my-team');

    const next = createBaseTeamData({
      tasks: [
        {
          id: 'task-4',
          displayId: '#4',
          subject: 'Burst comments',
          owner: 'alice',
          status: 'in_progress',
          comments: [
            {
              id: 'comment-4a',
              author: 'alice',
              text: 'First burst comment',
              createdAt: '2026-03-28T19:00:06.000Z',
              type: 'regular',
            },
            {
              id: 'comment-4b',
              author: 'bob',
              text: 'Second burst comment',
              createdAt: '2026-03-28T19:00:07.000Z',
              type: 'regular',
            },
          ],
          reviewState: 'none',
        } as TeamTaskWithKanban,
      ],
    });

    const graph = adapter.adapt(next, 'my-team');

    expect(graph.particles).toHaveLength(2);
    expect(graph.particles.every((particle) => particle.kind === 'task_comment')).toBe(true);
  });

  it('maps the real lead name to the lead node for inbox messages and task comments', () => {
    const adapter = TeamGraphAdapter.create();
    const baseline = createBaseTeamData({
      config: {
        name: 'My Team',
        members: [{ name: 'olivia', agentType: 'lead' }, { name: 'alice' }],
        projectPath: '/repo',
      },
      members: [
        {
          name: 'olivia',
          status: 'active',
          currentTaskId: null,
          taskCount: 0,
          lastActiveAt: null,
          messageCount: 0,
          agentType: 'lead',
        },
        {
          name: 'alice',
          status: 'active',
          currentTaskId: null,
          taskCount: 1,
          lastActiveAt: null,
          messageCount: 0,
        },
      ],
      tasks: [
        {
          id: 'task-3',
          displayId: '#3',
          subject: 'Review notes',
          owner: 'alice',
          status: 'in_progress',
          comments: [],
          reviewState: 'none',
        } as TeamTaskWithKanban,
      ],
      messages: [],
    });
    adapter.adapt(baseline, 'my-team');

    const next = createBaseTeamData({
      config: baseline.config,
      members: baseline.members,
      tasks: [
        {
          id: 'task-3',
          displayId: '#3',
          subject: 'Review notes',
          owner: 'alice',
          status: 'in_progress',
          comments: [
            {
              id: 'comment-3',
              author: 'olivia',
              text: 'Please tighten the acceptance criteria before merge',
              createdAt: '2026-03-28T19:00:04.000Z',
              type: 'regular',
            },
          ],
          reviewState: 'none',
        } as TeamTaskWithKanban,
      ],
      messages: [
        {
          from: 'olivia',
          to: 'alice',
          text: 'Please pick this up next',
          timestamp: '2026-03-28T19:00:05.000Z',
          read: false,
          messageId: 'lead-msg-1',
        },
      ],
    });

    const graph = adapter.adapt(next, 'my-team');

    expect(graph.particles).toHaveLength(2);
    expect(graph.particles.map((particle) => particle.kind).sort()).toEqual([
      'inbox_message',
      'task_comment',
    ]);
  });

  it('creates inbox particles for all unseen messages, not only the newest 20', () => {
    const adapter = TeamGraphAdapter.create();
    adapter.adapt(createBaseTeamData(), 'my-team');

    const messages: InboxMessage[] = Array.from({ length: 25 }, (_, index) => ({
      from: index % 2 === 0 ? 'alice' : 'bob',
      to: 'team-lead',
      text: `Payload ${index + 1}`,
      timestamp: `2026-03-28T19:00:${String(index).padStart(2, '0')}.000Z`,
      read: false,
      messageId: `msg-${index + 1}`,
    }));

    const graph = adapter.adapt(createBaseTeamData({ messages }), 'my-team');

    expect(graph.particles).toHaveLength(25);
    expect(graph.particles.every((particle) => particle.kind === 'inbox_message')).toBe(true);
  });

  it('scopes inbox particle ids by team name to avoid cross-team collisions', () => {
    const adapter = TeamGraphAdapter.create();
    adapter.adapt(createBaseTeamData({ teamName: 'team-a' }), 'team-a');

    const graph = adapter.adapt(
      createBaseTeamData({
        teamName: 'team-a',
        messages: [
          {
            from: 'alice',
            to: 'team-lead',
            text: 'Same payload',
            timestamp: '2026-03-28T19:10:00.000Z',
            read: false,
            messageId: 'shared-msg',
          },
        ],
      }),
      'team-a'
    );

    expect(graph.particles[0]?.id).toBe('particle:msg:team-a:shared-msg');
  });

  it('does not return a cached snapshot when message content changes at the same list length', () => {
    const adapter = TeamGraphAdapter.create();
    adapter.adapt(
      createBaseTeamData({
        messages: [
          {
            from: 'alice',
            to: 'team-lead',
            text: 'Old payload',
            timestamp: '2026-03-28T19:20:00.000Z',
            read: false,
            messageId: 'msg-old',
          },
        ],
      }),
      'my-team'
    );

    const graph = adapter.adapt(
      createBaseTeamData({
        messages: [
          {
            from: 'bob',
            to: 'team-lead',
            text: 'New payload',
            timestamp: '2026-03-28T19:20:01.000Z',
            read: false,
            messageId: 'msg-new',
          },
        ],
      }),
      'my-team'
    );

    expect(graph.particles).toHaveLength(1);
    expect(graph.particles[0]).toMatchObject({
      id: 'particle:msg:my-team:msg-new',
      kind: 'inbox_message',
    });
  });

  it('does not return a cached snapshot when a member status changes at the same list size', () => {
    const adapter = TeamGraphAdapter.create();
    adapter.adapt(createBaseTeamData(), 'my-team');

    const graph = adapter.adapt(
      createBaseTeamData({
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
            status: 'idle',
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
      }),
      'my-team'
    );

    const alice = graph.nodes.find((node) => node.id === 'member:my-team:alice');
    expect(alice?.state).toBe('idle');
  });

  it('refreshes lead state and exception metadata when lead activity changes without team-data changes', () => {
    const adapter = TeamGraphAdapter.create();
    const teamData = createBaseTeamData();

    adapter.adapt(teamData, 'my-team', undefined, 'active');

    const graph = adapter.adapt(
      teamData,
      'my-team',
      undefined,
      'offline',
      undefined,
      new Set(['team-lead'])
    );

    expect(findNode(graph, 'lead:my-team')).toMatchObject({
      state: 'terminated',
      pendingApproval: true,
      exceptionTone: 'error',
      exceptionLabel: 'offline',
    });
  });

  it('treats literal lead approval sources as lead-node pending approvals', () => {
    const adapter = TeamGraphAdapter.create();
    const graph = adapter.adapt(
      createBaseTeamData(),
      'my-team',
      undefined,
      'active',
      undefined,
      new Set(['lead'])
    );

    expect(findNode(graph, 'lead:my-team')).toMatchObject({
      pendingApproval: true,
      exceptionTone: 'warning',
      exceptionLabel: 'awaiting approval',
    });
  });

  it('refreshes member exception state when spawn status changes without team-data changes', () => {
    const adapter = TeamGraphAdapter.create();
    const teamData = createBaseTeamData();

    adapter.adapt(teamData, 'my-team');

    const graph = adapter.adapt(teamData, 'my-team', {
      alice: {
        status: 'waiting',
        launchState: 'starting',
        updatedAt: '2026-04-08T20:00:00.000Z',
      },
    });

    expect(findNode(graph, 'member:my-team:alice')).toMatchObject({
      state: 'waiting',
      spawnStatus: 'waiting',
      exceptionTone: 'warning',
      exceptionLabel: 'starting',
    });
  });

  it('refreshes unread comment badges when comment read state changes without task changes', () => {
    const adapter = TeamGraphAdapter.create();
    const teamData = createBaseTeamData({
      tasks: [
        {
          id: 'task-comments',
          displayId: '#8',
          subject: 'Review unread badge',
          owner: 'alice',
          status: 'in_progress',
          comments: [
            {
              id: 'comment-1',
              author: 'alice',
              text: 'Need a quick read receipt here',
              createdAt: '2026-03-28T19:00:02.000Z',
              type: 'regular',
            },
          ],
          reviewState: 'none',
        } as TeamTaskWithKanban,
      ],
    });

    const unreadGraph = adapter.adapt(
      teamData,
      'my-team',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {}
    );
    const readGraph = adapter.adapt(
      teamData,
      'my-team',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        'my-team/task-comments': {
          readIds: ['comment-1'],
          lastUpdated: Date.now(),
        },
      }
    );

    expect(findNode(unreadGraph, 'task:my-team:task-comments')?.unreadCommentCount).toBe(1);
    expect(findNode(readGraph, 'task:my-team:task-comments')?.unreadCommentCount).toBeUndefined();
  });

  it('dedupes symmetric blocking links and ignores completed blockers for blocked state', () => {
    const adapter = TeamGraphAdapter.create();
    const inProgressGraph = adapter.adapt(
      createBaseTeamData({
        tasks: [
          {
            id: 'task-a',
            displayId: '#1',
            subject: 'Blocker',
            owner: 'alice',
            status: 'in_progress',
            blocks: ['task-b'],
            reviewState: 'none',
          } as TeamTaskWithKanban,
          {
            id: 'task-b',
            displayId: '#2',
            subject: 'Blocked task',
            owner: 'bob',
            status: 'pending',
            blockedBy: ['task-a'],
            reviewState: 'none',
          } as TeamTaskWithKanban,
        ],
      }),
      'my-team'
    );

    const completedGraph = adapter.adapt(
      createBaseTeamData({
        tasks: [
          {
            id: 'task-a',
            displayId: '#1',
            subject: 'Blocker',
            owner: 'alice',
            status: 'completed',
            blocks: ['task-b'],
            reviewState: 'none',
          } as TeamTaskWithKanban,
          {
            id: 'task-b',
            displayId: '#2',
            subject: 'Blocked task',
            owner: 'bob',
            status: 'pending',
            blockedBy: ['task-a'],
            reviewState: 'none',
          } as TeamTaskWithKanban,
        ],
      }),
      'my-team'
    );

    expect(inProgressGraph.edges.filter((edge) => edge.type === 'blocking')).toHaveLength(1);
    expect(findNode(inProgressGraph, 'task:my-team:task-b')?.isBlocked).toBe(true);
    expect(findNode(completedGraph, 'task:my-team:task-b')?.isBlocked).toBe(false);
  });

  it('adds compact review handoff metadata for active review tasks', () => {
    const adapter = TeamGraphAdapter.create();
    const graph = adapter.adapt(
      createBaseTeamData({
        tasks: [
          {
            id: 'task-review',
            displayId: '#5',
            subject: 'Review this change',
            owner: 'alice',
            reviewer: 'bob',
            status: 'in_progress',
            reviewState: 'review',
            changePresence: 'has_changes',
            kanbanColumn: 'review',
          } as TeamTaskWithKanban,
        ],
      }),
      'my-team'
    );

    expect(findNode(graph, 'task:my-team:task-review')).toMatchObject({
      reviewerName: 'bob',
      reviewMode: 'assigned',
      changePresence: 'has_changes',
      reviewState: 'review',
    });
  });

  it('adds compact runtime labels for lead and members and refreshes when runtime changes', () => {
    const adapter = TeamGraphAdapter.create();
    adapter.adapt(createBaseTeamData(), 'my-team');

    const graph = adapter.adapt(
      createBaseTeamData({
        members: [
          {
            name: 'team-lead',
            status: 'active',
            currentTaskId: null,
            taskCount: 0,
            lastActiveAt: null,
            messageCount: 0,
            agentType: 'team-lead',
            providerId: 'codex',
            model: 'gpt-5.4-mini',
            effort: 'medium',
          },
          {
            name: 'alice',
            status: 'active',
            currentTaskId: null,
            taskCount: 1,
            lastActiveAt: null,
            messageCount: 0,
            providerId: 'anthropic',
            model: 'sonnet',
            effort: 'high',
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
      }),
      'my-team'
    );

    expect(graph.nodes.find((node) => node.id === 'lead:my-team')?.runtimeLabel).toBe(
      'GPT-5.4 Mini · Medium'
    );
    expect(graph.nodes.find((node) => node.id === 'member:my-team:alice')?.runtimeLabel).toBe(
      'Anthropic · Sonnet 4.6 · High'
    );
  });
});
