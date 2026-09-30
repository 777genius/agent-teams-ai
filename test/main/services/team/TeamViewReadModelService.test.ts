import { describe, expect, it, vi } from 'vitest';

import {
  TeamViewReadModelService,
  type TeamViewReadModelServicePorts,
} from '../../../../src/main/services/team/TeamViewReadModelService';

import type {
  InboxMessage,
  TeamConfig,
  TeamProcess,
  TeamTask,
  TeamTaskWithKanban,
} from '../../../../src/shared/types';

function createPorts(
  overrides: Partial<TeamViewReadModelServicePorts> = {}
): TeamViewReadModelServicePorts {
  const config: TeamConfig = {
    name: 'My Team',
    members: [{ name: 'team-lead', role: 'Lead' }],
    leadSessionId: 'lead-session',
  };

  return {
    readConfig: vi.fn(async () => config),
    readTasks: vi.fn(async () => []),
    readInboxNames: vi.fn(async () => []),
    readMembersMeta: vi.fn(async () => []),
    readTeamMeta: vi.fn(async () => null),
    readLaunchSnapshot: vi.fn(async () => null),
    readKanbanState: vi.fn(async (teamName) => ({
      teamName,
      reviewers: [],
      tasks: {},
    })),
    startTaskChangePresenceRead: vi.fn(() => ({
      enabled: false,
      logSourceSnapshot: null,
      presenceIndex: Promise.resolve(null),
    })),
    projectTaskWithKanban: vi.fn((task) => task as TeamTaskWithKanban),
    projectTaskChangePresence: vi.fn(() => ({})),
    resolveMembers: vi.fn(() => []),
    readMemberRuntimeAdvisories: vi.fn(async () => new Map()),
    resolveGitBranch: vi.fn(async () => null),
    memberBranchConcurrency: 2,
    readProcesses: vi.fn(async () => []),
    selectCurrentActiveTask: vi.fn(() => null),
    compactTask: vi.fn((task) => task),
    logDebug: vi.fn(),
    logWarning: vi.fn(),
    projectResolver: {
      getLiveBaseContext: vi.fn(async () => null),
      getContext: vi.fn(async () => null),
    },
    readInboxMessages: vi.fn(async () => []),
    readSentMessages: vi.fn(async () => []),
    ...overrides,
  };
}

describe('TeamViewReadModelService', () => {
  it('assembles the team snapshot through narrow ports without reading message sources', async () => {
    const task: TeamTask = {
      id: 'task-1',
      subject: 'Extract read model',
      status: 'in_progress',
    };
    const process: TeamProcess = {
      id: 'process-1',
      label: 'Lead',
      pid: 101,
      registeredAt: '2026-07-30T10:00:00.000Z',
    };
    const ports = createPorts({
      readTasks: vi.fn(async () => [task]),
      readProcesses: vi.fn(async () => [process]),
    });
    const service = new TeamViewReadModelService(ports);

    const snapshot = await service.getTeamData('my-team');

    expect(snapshot).toMatchObject({
      teamName: 'my-team',
      isAlive: true,
      tasks: [expect.objectContaining({ id: 'task-1', subject: 'Extract read model' })],
    });
    expect(ports.readTasks).toHaveBeenCalledWith('my-team');
    expect(ports.readProcesses).toHaveBeenCalledWith('my-team');
    expect(ports.readInboxMessages).not.toHaveBeenCalled();
    expect(ports.readSentMessages).not.toHaveBeenCalled();
  });

  it('owns message normalization for feed and paginated reads', async () => {
    const messages: InboxMessage[] = [
      {
        from: 'user',
        to: 'team-lead',
        text: '/cost',
        timestamp: '2026-07-30T10:00:00.000Z',
        read: true,
        source: 'user_sent',
        messageId: 'slash-1',
      },
      {
        from: 'team-lead',
        text: 'Total cost: $1.05',
        timestamp: '2026-07-30T10:00:01.000Z',
        read: true,
        source: 'lead_process',
        messageId: 'result-1',
      },
      {
        from: 'alice',
        text: JSON.stringify({
          type: 'idle_notification',
          idleReason: 'available',
          summary: '[to user] acknowledged',
        }),
        timestamp: '2026-07-30T10:00:03.000Z',
        read: true,
        messageId: 'passive-1',
      },
    ];
    const sentMessages: InboxMessage[] = [
      {
        from: 'alice',
        to: 'user',
        text: 'Acknowledged and ready.',
        summary: 'acknowledged',
        timestamp: '2026-07-30T10:00:02.000Z',
        read: true,
        source: 'user_sent',
        messageId: 'reply-1',
      },
    ];
    const service = new TeamViewReadModelService(
      createPorts({
        readInboxMessages: vi.fn(async () => messages),
        readSentMessages: vi.fn(async () => sentMessages),
      })
    );

    const feed = await service.getMessageFeed('my-team');
    const page = await service.getMessagesPage('my-team', { limit: 10 });

    expect(feed.messages.find((message) => message.messageId === 'result-1')).toMatchObject({
      messageKind: 'slash_command_result',
      commandOutput: { stream: 'stdout', commandLabel: '/cost' },
    });
    expect(feed.messages.find((message) => message.messageId === 'passive-1')).toMatchObject({
      relayOfMessageId: 'reply-1',
    });
    expect(messages[2].relayOfMessageId).toBeUndefined();
    expect(page.messages.map((message) => message.messageId)).toEqual([
      'passive-1',
      'reply-1',
      'result-1',
      'slash-1',
    ]);
    expect(page.feedRevision).toMatch(/^[a-f0-9]{24}$/);
  });

  it('invalidates both the feed and member-activity projection', async () => {
    let messages: InboxMessage[] = [
      {
        from: 'alice',
        text: 'First update',
        timestamp: '2026-07-30T10:00:00.000Z',
        read: true,
        messageId: 'message-1',
      },
    ];
    const readInboxMessages = vi.fn(async () => messages);
    const service = new TeamViewReadModelService(createPorts({ readInboxMessages }));

    const first = await service.getMemberActivityMeta('my-team');
    messages = [
      ...messages,
      {
        from: 'alice',
        text: 'Second update',
        timestamp: '2026-07-30T10:01:00.000Z',
        read: true,
        messageId: 'message-2',
      },
    ];
    const cached = await service.getMemberActivityMeta('my-team');
    service.invalidateMessageFeed('my-team');
    const refreshed = await service.getMemberActivityMeta('my-team');

    expect(first.members.alice.messageCountExact).toBe(1);
    expect(cached).toBe(first);
    expect(refreshed.members.alice).toMatchObject({
      messageCountExact: 2,
      lastAuthoredMessageAt: '2026-07-30T10:01:00.000Z',
    });
    expect(readInboxMessages).toHaveBeenCalledTimes(2);
  });

  it('deduplicates notification-context reads and honors explicit invalidation', async () => {
    const readConfig = vi
      .fn<() => Promise<TeamConfig | null>>()
      .mockResolvedValueOnce({
        name: 'First Team',
        projectPath: '/projects/first',
        members: [],
      })
      .mockResolvedValue({
        name: 'Second Team',
        projectPath: '/projects/second',
        members: [],
      });
    const service = new TeamViewReadModelService(createPorts({ readConfig }));

    const [first, duplicate] = await Promise.all([
      service.getTeamNotificationContext('my-team'),
      service.getTeamNotificationContext('my-team'),
    ]);
    const cached = await service.getTeamNotificationContext('my-team');
    service.invalidateNotificationContext('my-team');
    const refreshed = await service.getTeamNotificationContext('my-team');
    const displayName = await service.getTeamDisplayName('my-team');

    expect(first).toEqual({
      displayName: 'First Team',
      projectPath: '/projects/first',
    });
    expect(duplicate).toBe(first);
    expect(cached).toBe(first);
    expect(refreshed).toEqual({
      displayName: 'Second Team',
      projectPath: '/projects/second',
    });
    expect(displayName).toBe('Second Team');
    expect(readConfig).toHaveBeenCalledTimes(3);
  });

  it('falls back to the team name when display config reads fail', async () => {
    const service = new TeamViewReadModelService(
      createPorts({
        readConfig: vi.fn(async () => {
          throw new Error('config unavailable');
        }),
      })
    );

    await expect(service.getTeamDisplayName('my-team')).resolves.toBe('my-team');
    await expect(service.getTeamNotificationContext('my-team')).resolves.toEqual({
      displayName: 'my-team',
    });
  });
});
