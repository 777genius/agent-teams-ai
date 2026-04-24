import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  TeamGraphAdapter,
  type TeamGraphData,
} from '@features/agent-graph/renderer/adapters/TeamGraphAdapter';

import type { InboxMessage, TeamTaskWithKanban } from '@shared/types/team';
import type { GraphDataPort } from '@claude-teams/agent-graph';

function createBaseTeamData(
  overrides?: Partial<TeamGraphData> & {
    tasks?: TeamTaskWithKanban[];
    messages?: InboxMessage[];
  }
): TeamGraphData {
  const { messages, ...restOverrides } = overrides ?? {};
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
    messageFeed: messages ?? [],
    kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
    processes: [],
    isAlive: true,
    ...restOverrides,
  };
}

function findNode(graph: GraphDataPort, nodeId: string) {
  return graph.nodes.find((node) => node.id === nodeId);
}

describe('TeamGraphAdapter particles', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-28T19:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('builds ownerOrder from config member order instead of transient member array order', () => {
    const adapter = TeamGraphAdapter.create();
    const graph = adapter.adapt(
      createBaseTeamData({
        config: {
          name: 'My Team',
          members: [{ name: 'team-lead' }, { name: 'alice' }, { name: 'bob' }, { name: 'tom' }],
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
            name: 'tom',
            status: 'active',
            currentTaskId: null,
            taskCount: 0,
            lastActiveAt: null,
            messageCount: 0,
          },
          {
            name: 'bob',
            status: 'active',
            currentTaskId: null,
            taskCount: 0,
            lastActiveAt: null,
            messageCount: 0,
          },
          {
            name: 'alice',
            status: 'active',
            currentTaskId: null,
            taskCount: 0,
            lastActiveAt: null,
            messageCount: 0,
          },
        ],
      }),
      'my-team',
      undefined,
      undefined,
      undefined,
      new Set()
    );

    expect(graph.layout?.ownerOrder).toEqual([
      'member:my-team:alice',
      'member:my-team:bob',
      'member:my-team:tom',
    ]);
  });

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

  it('does not replay old inbox messages that arrive after the graph already opened', () => {
    vi.setSystemTime(new Date('2026-03-28T19:00:10.000Z'));

    const adapter = TeamGraphAdapter.create();
    adapter.adapt(createBaseTeamData(), 'my-team');

    const graph = adapter.adapt(
      createBaseTeamData({
        messages: [
          {
            from: 'alice',
            to: 'team-lead',
            text: 'Old backlog message',
            timestamp: '2026-03-28T19:00:01.000Z',
            read: false,
            messageId: 'msg-old',
          },
        ],
      }),
      'my-team'
    );

    expect(graph.particles).toHaveLength(0);
  });

  it('fails closed when visible members would silently merge on duplicate stable owner ids', () => {
    const adapter = TeamGraphAdapter.create();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const graph = adapter.adapt(
      createBaseTeamData({
        config: {
          name: 'My Team',
          members: [
            { name: 'team-lead' },
            { name: 'alice', agentId: 'shared-agent' },
            { name: 'bob', agentId: 'shared-agent' },
          ],
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
            agentId: 'lead-agent',
          },
          {
            name: 'alice',
            status: 'active',
            currentTaskId: null,
            taskCount: 1,
            lastActiveAt: null,
            messageCount: 0,
            agentId: 'shared-agent',
          },
          {
            name: 'bob',
            status: 'active',
            currentTaskId: null,
            taskCount: 1,
            lastActiveAt: null,
            messageCount: 0,
            agentId: 'shared-agent',
          },
        ],
      }),
      'my-team'
    );

    expect(graph.nodes).toEqual([]);
    expect(graph.edges).toEqual([]);
    expect(errorSpy).toHaveBeenCalledWith(
      '[agent-graph] duplicate stable owner ids in team=my-team: shared-agent'
    );

    errorSpy.mockRestore();
  });

  it('prioritizes owners with saved slot assignments before config-only members in layout order', () => {
    const adapter = TeamGraphAdapter.create();
    const graph = adapter.adapt(
      createBaseTeamData({
        config: {
          name: 'My Team',
          members: [
            { name: 'team-lead', agentId: 'lead-agent' },
            { name: 'bob', agentId: 'agent-bob' },
            { name: 'alice', agentId: 'agent-alice' },
          ],
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
            agentId: 'lead-agent',
          },
          {
            name: 'alice',
            status: 'active',
            currentTaskId: null,
            taskCount: 1,
            lastActiveAt: null,
            messageCount: 0,
            agentId: 'agent-alice',
          },
          {
            name: 'bob',
            status: 'active',
            currentTaskId: null,
            taskCount: 1,
            lastActiveAt: null,
            messageCount: 0,
            agentId: 'agent-bob',
          },
        ],
      }),
      'my-team',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        'agent-alice': { ringIndex: 0, sectorIndex: 2 },
      }
    );

    expect(graph.layout?.ownerOrder).toEqual([
      'member:my-team:agent-alice',
      'member:my-team:agent-bob',
    ]);
  });

  it('keeps assigned owners ahead of config-only members even when the assigned owner is absent from config order', () => {
    const adapter = TeamGraphAdapter.create();
    const graph = adapter.adapt(
      createBaseTeamData({
        config: {
          name: 'My Team',
          members: [
            { name: 'team-lead', agentId: 'lead-agent' },
            { name: 'bob', agentId: 'agent-bob' },
          ],
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
            agentId: 'lead-agent',
          },
          {
            name: 'alice',
            status: 'active',
            currentTaskId: null,
            taskCount: 1,
            lastActiveAt: null,
            messageCount: 0,
            agentId: 'agent-alice',
          },
          {
            name: 'bob',
            status: 'active',
            currentTaskId: null,
            taskCount: 1,
            lastActiveAt: null,
            messageCount: 0,
            agentId: 'agent-bob',
          },
        ],
      }),
      'my-team',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        'agent-alice': { ringIndex: 1, sectorIndex: 4 },
      }
    );

    expect(graph.layout?.ownerOrder).toEqual([
      'member:my-team:agent-alice',
      'member:my-team:agent-bob',
    ]);
  });

  it('does not replay old task comments that appear after the graph already opened', () => {
    vi.setSystemTime(new Date('2026-03-28T19:00:10.000Z'));

    const adapter = TeamGraphAdapter.create();
    adapter.adapt(
      createBaseTeamData({
        tasks: [
          {
            id: 'task-old-comment',
            displayId: '#9',
            subject: 'Review backlog',
            owner: 'alice',
            status: 'in_progress',
            comments: [],
            reviewState: 'none',
          } as TeamTaskWithKanban,
        ],
      }),
      'my-team'
    );

    const graph = adapter.adapt(
      createBaseTeamData({
        tasks: [
          {
            id: 'task-old-comment',
            displayId: '#9',
            subject: 'Review backlog',
            owner: 'alice',
            status: 'in_progress',
            comments: [
              {
                id: 'comment-old',
                author: 'alice',
                text: 'Old backlog comment',
                createdAt: '2026-03-28T19:00:01.000Z',
                type: 'regular',
              },
            ],
            reviewState: 'none',
          } as TeamTaskWithKanban,
        ],
      }),
      'my-team'
    );

    expect(graph.particles).toHaveLength(0);
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
    expect(graph.particles.map((particle) => particle.kind).toSorted((a, b) => a.localeCompare(b))).toEqual([
      'inbox_message',
      'task_comment',
    ]);
  });

  it('maps lead-owned tasks onto the lead board without routing unknown owners to lead', () => {
    const adapter = TeamGraphAdapter.create();

    const graph = adapter.adapt(
      createBaseTeamData({
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
            taskCount: 1,
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
            id: 'lead-task',
            displayId: '#11',
            subject: 'Lead summary',
            owner: 'olivia',
            status: 'in_progress',
            comments: [],
            reviewState: 'none',
          } as TeamTaskWithKanban,
          {
            id: 'unknown-task',
            displayId: '#12',
            subject: 'Unknown owner',
            owner: 'ghost',
            status: 'in_progress',
            comments: [],
            reviewState: 'none',
          } as TeamTaskWithKanban,
        ],
      }),
      'my-team'
    );

    expect(findNode(graph, 'task:my-team:lead-task')?.ownerId).toBe('lead:my-team');
    expect(findNode(graph, 'task:my-team:unknown-task')?.ownerId).toBeNull();
  });

  it('builds member activity feeds from inbox messages in newest-first order', () => {
    const adapter = TeamGraphAdapter.create();

    const graph = adapter.adapt(
      createBaseTeamData({
        messages: [
          {
            from: 'alice',
            to: 'team-lead',
            text: 'First update',
            timestamp: '2026-03-28T19:00:01.000Z',
            read: false,
            messageId: 'msg-1',
          },
          {
            from: 'team-lead',
            to: 'alice',
            text: 'Second update',
            timestamp: '2026-03-28T19:00:02.000Z',
            read: false,
            messageId: 'msg-2',
          },
        ],
      }),
      'my-team'
    );

    expect(findNode(graph, 'member:my-team:alice')?.activityItems).toEqual([
      expect.objectContaining({
        id: 'activity:msg:my-team:msg-2',
        title: 'team-lead -> alice',
        preview: 'Second update',
      }),
      expect.objectContaining({
        id: 'activity:msg:my-team:msg-1',
        title: 'alice -> team-lead',
        preview: 'First update',
      }),
    ]);
  });

  it('routes task comment activity to the task owner and keeps task detail metadata', () => {
    const adapter = TeamGraphAdapter.create();

    const graph = adapter.adapt(
      createBaseTeamData({
        tasks: [
          {
            id: 'task-comments',
            displayId: '#8',
            subject: 'Review API notes',
            owner: 'bob',
            status: 'in_progress',
            comments: [
              {
                id: 'comment-1',
                author: 'alice',
                text: 'Please check the final API notes before merge',
                createdAt: '2026-03-28T19:00:02.000Z',
                type: 'regular',
              },
            ],
            reviewState: 'none',
          } as TeamTaskWithKanban,
        ],
      }),
      'my-team'
    );

    expect(findNode(graph, 'member:my-team:bob')?.activityItems).toEqual([
      expect.objectContaining({
        id: 'activity:comment:my-team:task-comments:comment-1',
        kind: 'task_comment',
        title: '#8 Review API notes',
        preview: 'Please check the final API notes before merge',
        taskId: 'task-comments',
        taskDisplayId: '#8',
        authorLabel: 'alice',
      }),
    ]);
  });

  it('resolves task and process owners by stable owner id aliases, not only member names', () => {
    const adapter = TeamGraphAdapter.create();

    const graph = adapter.adapt(
      createBaseTeamData({
        config: {
          name: 'My Team',
          members: [
            { name: 'team-lead', agentId: 'lead-agent' },
            { name: 'alice', agentId: 'agent-alice' },
          ],
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
            agentId: 'lead-agent',
          },
          {
            name: 'alice',
            status: 'active',
            currentTaskId: null,
            taskCount: 1,
            lastActiveAt: null,
            messageCount: 0,
            agentId: 'agent-alice',
          },
        ],
        tasks: [
          {
            id: 'task-owned-by-stable-id',
            displayId: '#42',
            subject: 'Stable owner task',
            owner: 'agent-alice',
            status: 'completed',
            comments: [],
            reviewState: 'none',
          } as TeamTaskWithKanban,
        ],
        processes: [
          {
            id: 'proc-owned-by-stable-id',
            label: 'Stable owner process',
            pid: 4242,
            registeredBy: 'agent-alice',
            registeredAt: '2026-03-28T19:00:02.000Z',
          },
        ],
      }),
      'my-team'
    );

    expect(findNode(graph, 'task:my-team:task-owned-by-stable-id')).toMatchObject({
      ownerId: 'member:my-team:agent-alice',
      taskStatus: 'completed',
    });
    expect(findNode(graph, 'process:my-team:proc-owned-by-stable-id')).toMatchObject({
      ownerId: 'member:my-team:agent-alice',
    });
    expect(
      graph.edges.some(
        (edge) =>
          edge.id ===
          'edge:own:member:my-team:agent-alice:task:my-team:task-owned-by-stable-id'
      )
    ).toBe(true);
  });

  it('skips noisy idle inbox rows in the activity feed while keeping cross-team traffic on the lead lane', () => {
    const adapter = TeamGraphAdapter.create();

    const graph = adapter.adapt(
      createBaseTeamData({
        messages: [
          {
            from: 'alice',
            to: 'team-lead',
            text: JSON.stringify({ type: 'idle_notification' }),
            timestamp: '2026-03-28T19:00:01.000Z',
            read: true,
            messageId: 'idle-generic',
          },
          {
            from: 'team-b.alex',
            text: '[cross-team] Need status update',
            timestamp: '2026-03-28T19:00:02.000Z',
            read: false,
            messageId: 'cross-team-1',
            source: 'cross_team',
          },
        ],
      }),
      'my-team'
    );

    expect(findNode(graph, 'member:my-team:alice')?.activityItems).toEqual([]);
    expect(findNode(graph, 'lead:my-team')?.activityItems).toEqual([
      expect.objectContaining({
        id: 'activity:msg:my-team:cross-team-1',
        title: 'team-b -> team-lead',
        preview: 'Need status update',
      }),
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

  it('keeps only one most relevant process rail per owner and prefers running over finished', () => {
    const adapter = TeamGraphAdapter.create();
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
            status: 'active',
            currentTaskId: null,
            taskCount: 1,
            lastActiveAt: null,
            messageCount: 0,
          },
        ],
        config: {
          name: 'My Team',
          members: [{ name: 'team-lead' }, { name: 'alice' }],
          projectPath: '/repo',
        },
        processes: [
          {
            id: 'proc-finished',
            label: 'Build API',
            pid: 101,
            registeredBy: 'alice',
            registeredAt: '2026-03-28T19:00:01.000Z',
            stoppedAt: '2026-03-28T19:00:10.000Z',
          },
          {
            id: 'proc-running',
            label: 'Watch dev server',
            pid: 102,
            registeredBy: 'alice',
            registeredAt: '2026-03-28T19:00:02.000Z',
          },
        ],
      }),
      'my-team'
    );

    const processNodes = graph.nodes.filter((node) => node.kind === 'process');
    expect(processNodes).toHaveLength(1);
    expect(processNodes[0]).toMatchObject({
      id: 'process:my-team:proc-running',
      ownerId: 'member:my-team:alice',
      label: 'Watch dev server',
    });
  });

  it('falls back to the most recent finished process when no running process exists', () => {
    const adapter = TeamGraphAdapter.create();
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
            status: 'active',
            currentTaskId: null,
            taskCount: 1,
            lastActiveAt: null,
            messageCount: 0,
          },
        ],
        config: {
          name: 'My Team',
          members: [{ name: 'team-lead' }, { name: 'alice' }],
          projectPath: '/repo',
        },
        processes: [
          {
            id: 'proc-old-finished',
            label: 'Older finished process',
            pid: 101,
            registeredBy: 'alice',
            registeredAt: '2026-03-28T19:00:01.000Z',
            stoppedAt: '2026-03-28T19:00:10.000Z',
          },
          {
            id: 'proc-new-finished',
            label: 'Newest finished process',
            pid: 102,
            registeredBy: 'alice',
            registeredAt: '2026-03-28T19:00:03.000Z',
            stoppedAt: '2026-03-28T19:00:11.000Z',
          },
        ],
      }),
      'my-team'
    );

    const processNodes = graph.nodes.filter((node) => node.kind === 'process');
    expect(processNodes).toHaveLength(1);
    expect(processNodes[0]).toMatchObject({
      id: 'process:my-team:proc-new-finished',
      ownerId: 'member:my-team:alice',
      label: 'Newest finished process',
    });
  });

  it('derives graph launch visuals from shared provisioning semantics', () => {
    const adapter = TeamGraphAdapter.create();
    const graph = adapter.adapt(
      createBaseTeamData(),
      'my-team',
      {
        alice: {
          status: 'online',
          launchState: 'runtime_pending_bootstrap',
          livenessSource: 'process',
          runtimeAlive: true,
          updatedAt: '2026-03-28T19:00:01.000Z',
        },
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        runId: 'run-1',
        teamName: 'my-team',
        state: 'finalizing',
        startedAt: '2026-03-28T19:00:00.000Z',
        message: 'Waiting for bootstrap contact',
        pid: 1234,
        configReady: true,
      } as never
    );

    expect(findNode(graph, 'member:my-team:alice')).toMatchObject({
      launchVisualState: 'waiting',
      launchStatusLabel: 'waiting to start',
    });
  });

  it('keeps confirmed teammates in settling visuals while launch is still joining', () => {
    const adapter = TeamGraphAdapter.create();
    const graph = adapter.adapt(
      createBaseTeamData(),
      'my-team',
      {
        alice: {
          status: 'online',
          launchState: 'confirmed_alive',
          livenessSource: 'heartbeat',
          runtimeAlive: true,
          updatedAt: '2026-03-28T19:00:01.000Z',
        },
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        runId: 'run-1',
        teamName: 'my-team',
        state: 'ready',
        startedAt: '2026-03-28T19:00:00.000Z',
        message: 'Finishing launch',
        pid: 1234,
        configReady: true,
      } as never,
      {
        runId: 'run-1',
        expectedMembers: ['alice', 'bob'],
        statuses: {},
        summary: {
          confirmedCount: 1,
          pendingCount: 1,
          failedCount: 0,
          runtimeAlivePendingCount: 0,
        },
        source: 'merged',
      } as never
    );

    expect(findNode(graph, 'member:my-team:alice')).toMatchObject({
      launchVisualState: 'settling',
      launchStatusLabel: 'joining team',
    });
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

  it('treats permission-blocked spawn state as awaiting approval even without pending approval feed', () => {
    const adapter = TeamGraphAdapter.create();
    const teamData = createBaseTeamData();

    adapter.adapt(teamData, 'my-team');

    const graph = adapter.adapt(teamData, 'my-team', {
      alice: {
        status: 'online',
        launchState: 'runtime_pending_permission',
        runtimeAlive: true,
        agentToolAccepted: true,
        bootstrapConfirmed: false,
        hardFailure: false,
        updatedAt: '2026-04-08T20:00:00.000Z',
      },
    });

    expect(findNode(graph, 'member:my-team:alice')).toMatchObject({
      state: 'waiting',
      spawnStatus: 'online',
      launchVisualState: 'permission_pending',
      launchStatusLabel: 'awaiting permission',
      exceptionTone: 'warning',
      exceptionLabel: 'awaiting approval',
      pendingApproval: false,
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

  it('aggregates blocking edges through overflow stacks so hidden blockers stay visible', () => {
    const adapter = TeamGraphAdapter.create();
    const graph = adapter.adapt(
      createBaseTeamData({
        tasks: [
          ...Array.from({ length: 7 }, (_, index) => ({
            id: `task-a-${index + 1}`,
            displayId: `#A${index + 1}`,
            subject: `Alice task ${index + 1}`,
            owner: 'alice',
            status: 'pending',
            reviewState: 'none',
            blocks: index >= 5 ? ['task-b-1'] : [],
          })),
          {
            id: 'task-b-1',
            displayId: '#B1',
            subject: 'Visible blocked task',
            owner: 'bob',
            status: 'pending',
            reviewState: 'none',
            blockedBy: ['task-a-6', 'task-a-7'],
          } as TeamTaskWithKanban,
        ] as TeamTaskWithKanban[],
      }),
      'my-team'
    );

    const overflowNode = graph.nodes.find(
      (node) => node.kind === 'task' && node.isOverflowStack && node.ownerId === 'member:my-team:alice'
    );
    const blockingEdges = graph.edges.filter((edge) => edge.type === 'blocking');

    expect(overflowNode).toBeDefined();
    expect(blockingEdges).toContainEqual(
      expect.objectContaining({
        source: overflowNode?.id,
        target: 'task:my-team:task-b-1',
        aggregateCount: 2,
        sourceTaskIds: ['task-a-6', 'task-a-7'],
        targetTaskIds: ['task-b-1'],
      })
    );
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

  it('does not project warning-only change presence as file changes', () => {
    const adapter = TeamGraphAdapter.create();
    const graph = adapter.adapt(
      createBaseTeamData({
        tasks: [
          {
            id: 'task-warning-only',
            displayId: '#6',
            subject: 'Needs attention without file diff',
            owner: 'alice',
            status: 'in_progress',
            changePresence: 'needs_attention',
          } as TeamTaskWithKanban,
        ],
      }),
      'my-team'
    );

    expect(findNode(graph, 'task:my-team:task-warning-only')).toMatchObject({
      changePresence: 'unknown',
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
