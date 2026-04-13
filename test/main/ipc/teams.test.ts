import * as os from 'os';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BoardTaskActivityDetailResult,
  BoardTaskActivityEntry,
  BoardTaskLogStreamResponse,
  BoardTaskExactLogDetailResult,
  BoardTaskExactLogSummariesResponse,
  InboxMessage,
  TeamCreateRequest,
  TeamProvisioningProgress,
} from '@shared/types/team';

vi.mock('electron', () => ({
  app: { getLocale: vi.fn(() => 'en'), getPath: vi.fn(() => '/tmp') },
  Notification: Object.assign(vi.fn(), { isSupported: vi.fn(() => false) }),
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));

// Keep this mock resilient to new exports (avoid drift).
vi.mock('@preload/constants/ipcChannels', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@preload/constants/ipcChannels')>();
  return { ...actual };
});

// Mock NotificationManager — handleShowMessageNotification calls addTeamNotification
const { mockAddTeamNotification } = vi.hoisted(() => ({
  mockAddTeamNotification: vi.fn().mockResolvedValue({ id: 'n1', isRead: false, createdAt: Date.now() }),
}));
const { mockGetMembersMeta } = vi.hoisted(() => ({
  mockGetMembersMeta: vi.fn(),
}));
const { mockTeamDataWorkerClient } = vi.hoisted(() => ({
  mockTeamDataWorkerClient: {
    isAvailable: vi.fn(),
    getTeamData: vi.fn(),
    findLogsForTask: vi.fn(),
  },
}));
vi.mock('@main/services/infrastructure/NotificationManager', () => ({
  NotificationManager: {
    getInstance: vi.fn().mockReturnValue({
      addTeamNotification: mockAddTeamNotification,
    }),
  },
}));
vi.mock('@main/services/team/TeamMembersMetaStore', () => ({
  TeamMembersMetaStore: vi.fn().mockImplementation(() => ({
    getMembers: mockGetMembersMeta,
  })),
}));
vi.mock('@main/services/team/TeamDataWorkerClient', () => ({
  getTeamDataWorkerClient: () => mockTeamDataWorkerClient,
}));

import {
  TEAM_ALIVE_LIST,
  TEAM_STOP,
  TEAM_CANCEL_PROVISIONING,
  TEAM_CREATE,
  TEAM_CREATE_CONFIG,
  TEAM_CREATE_TASK,
  TEAM_DELETE_TEAM,
  TEAM_GET_DATA,
  TEAM_LAUNCH,
  TEAM_LIST,
  TEAM_PREPARE_PROVISIONING,
  TEAM_PROCESS_ALIVE,
  TEAM_PROCESS_SEND,
  TEAM_PROVISIONING_STATUS,
  TEAM_REQUEST_REVIEW,
  TEAM_SEND_MESSAGE,
  TEAM_SET_CHANGE_PRESENCE_TRACKING,
  TEAM_GET_ALL_TASKS,
  TEAM_GET_LOGS_FOR_TASK,
  TEAM_GET_TASK_ACTIVITY,
  TEAM_GET_TASK_ACTIVITY_DETAIL,
  TEAM_GET_TASK_LOG_STREAM,
  TEAM_GET_TASK_EXACT_LOG_DETAIL,
  TEAM_GET_TASK_EXACT_LOG_SUMMARIES,
  TEAM_GET_MEMBER_LOGS,
  TEAM_GET_MEMBER_STATS,
  TEAM_START_TASK,
  TEAM_UPDATE_CONFIG,
  TEAM_UPDATE_KANBAN,
  TEAM_UPDATE_KANBAN_COLUMN_ORDER,
  TEAM_UPDATE_TASK_STATUS,
  TEAM_ADD_MEMBER,
  TEAM_ADD_TASK_COMMENT,
  TEAM_GET_ATTACHMENTS,
  TEAM_GET_DELETED_TASKS,
  TEAM_GET_TASK_CHANGE_PRESENCE,
  TEAM_GET_PROJECT_BRANCH,
  TEAM_KILL_PROCESS,
  TEAM_LEAD_ACTIVITY,
  TEAM_PERMANENTLY_DELETE,
  TEAM_REMOVE_MEMBER,
  TEAM_RESTORE,
  TEAM_SET_TASK_CLARIFICATION,
  TEAM_SOFT_DELETE_TASK,
  TEAM_UPDATE_MEMBER_ROLE,
  TEAM_ADD_TASK_RELATIONSHIP,
  TEAM_REMOVE_TASK_RELATIONSHIP,
  TEAM_REPLACE_MEMBERS,
  TEAM_UPDATE_TASK_OWNER,
  TEAM_UPDATE_TASK_FIELDS,
  TEAM_LEAD_CONTEXT,
  TEAM_RESTORE_TASK,
  TEAM_SHOW_MESSAGE_NOTIFICATION,
  TEAM_SAVE_TASK_ATTACHMENT,
  TEAM_GET_TASK_ATTACHMENT,
  TEAM_DELETE_TASK_ATTACHMENT,
} from '../../../src/preload/constants/ipcChannels';
import {
  initializeTeamHandlers,
  registerTeamHandlers,
  removeTeamHandlers,
} from '../../../src/main/ipc/teams';

describe('ipc teams handlers', () => {
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  const ipcMain = {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => Promise<unknown>) => {
      handlers.set(channel, fn);
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel);
    }),
  };

  const service = {
    listTeams: vi.fn(async () => [{ teamName: 'my-team', displayName: 'My Team' }]),
    getTeamData: vi.fn(async () => ({
      teamName: 'my-team',
      config: { name: 'My Team' },
      tasks: [],
      members: [],
      messages: [] as InboxMessage[],
      kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
      processes: [],
    })),
    getTaskChangePresence: vi.fn(async () => ({ 'task-1': 'has_changes' })),
    reconcileTeamArtifacts: vi.fn(async () => undefined),
    setTaskChangePresenceTracking: vi.fn(() => undefined),
    deleteTeam: vi.fn(async () => undefined),
    getLeadMemberName: vi.fn(async () => 'team-lead'),
    getTeamDisplayName: vi.fn(async () => 'My Team'),
    sendMessage: vi.fn(async () => ({ deliveredToInbox: true, messageId: 'm1' })),
    sendDirectToLead: vi.fn(async () => ({ deliveredToInbox: false, messageId: 'direct-1' })),
    createTask: vi.fn(async () => ({ id: '1', subject: 'Test', status: 'pending' })),
    requestReview: vi.fn(async () => undefined),
    updateKanban: vi.fn(async () => undefined),
    updateKanbanColumnOrder: vi.fn(async () => undefined),
    updateTaskStatus: vi.fn(async () => undefined),
    startTask: vi.fn(async () => undefined),
    addTaskComment: vi.fn(async () => ({
      id: 'c1',
      author: 'user',
      text: 'test comment',
      createdAt: new Date().toISOString(),
    })),
    addMember: vi.fn(async () => undefined),
    removeMember: vi.fn(async () => undefined),
    updateMemberRole: vi.fn(async () => ({ oldRole: undefined, changed: true })),
    softDeleteTask: vi.fn(async () => undefined),
    getDeletedTasks: vi.fn(async () => []),
    setTaskNeedsClarification: vi.fn(async () => undefined),
    addTaskRelationship: vi.fn(async () => undefined),
    removeTaskRelationship: vi.fn(async () => undefined),
    replaceMembers: vi.fn(async () => undefined),
    createTeamConfig: vi.fn(async () => undefined),
  };
  const provisioningService = {
    prepareForProvisioning: vi.fn(async () => ({
      ready: true,
      message: 'CLI прогрет и готов к запуску',
    })),
    createTeam: vi.fn(
      async (_req: TeamCreateRequest, _onProgress: (p: TeamProvisioningProgress) => void) => ({
        runId: 'run-1',
      })
    ),
    getProvisioningStatus: vi.fn(async () => ({
      runId: 'run-1',
      teamName: 'my-team',
      state: 'spawning',
      message: 'Starting',
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })),
    cancelProvisioning: vi.fn(async () => undefined),
    launchTeam: vi.fn(async () => ({ runId: 'run-2' })),
    sendMessageToTeam: vi.fn(async () => undefined),
    isTeamAlive: vi.fn(() => true),
    pushLiveLeadProcessMessage: vi.fn(),
    relayLeadInboxMessages: vi.fn(async () => 0),
    relayMemberInboxMessages: vi.fn(async () => 0),
    getLiveLeadProcessMessages: vi.fn(() => [] as InboxMessage[]),
    getAliveTeams: vi.fn(() => ['my-team']),
    getLeadActivityState: vi.fn(() => 'idle'),
    stopTeam: vi.fn(() => undefined),
  };
  const boardTaskActivityService = {
    getTaskActivity: vi.fn<() => Promise<BoardTaskActivityEntry[]>>(async () => []),
  };
  const boardTaskActivityDetailService = {
    getTaskActivityDetail:
      vi.fn<() => Promise<BoardTaskActivityDetailResult>>(async () => ({ status: 'missing' })),
  };
  const boardTaskLogStreamService = {
    getTaskLogStream:
      vi.fn<() => Promise<BoardTaskLogStreamResponse>>(async () => ({
        participants: [],
        defaultFilter: 'all',
        segments: [],
      })),
  };
  const boardTaskExactLogsService = {
    getTaskExactLogSummaries:
      vi.fn<() => Promise<BoardTaskExactLogSummariesResponse>>(async () => ({ items: [] })),
  };
  const boardTaskExactLogDetailService = {
    getTaskExactLogDetail:
      vi.fn<() => Promise<BoardTaskExactLogDetailResult>>(async () => ({ status: 'missing' })),
  };

  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
    mockGetMembersMeta.mockReset();
    mockGetMembersMeta.mockResolvedValue([]);
    mockTeamDataWorkerClient.isAvailable.mockReturnValue(false);
    mockTeamDataWorkerClient.getTeamData.mockReset();
    mockTeamDataWorkerClient.findLogsForTask.mockReset();
    initializeTeamHandlers(
      service as never,
      provisioningService as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      boardTaskActivityService as never,
      boardTaskActivityDetailService as never,
      boardTaskLogStreamService as never,
      boardTaskExactLogsService as never,
      boardTaskExactLogDetailService as never,
    );
    registerTeamHandlers(ipcMain as never);
  });

  it('registers all expected handlers', () => {
    expect(handlers.has(TEAM_LIST)).toBe(true);
    expect(handlers.has(TEAM_GET_DATA)).toBe(true);
    expect(handlers.has(TEAM_GET_TASK_CHANGE_PRESENCE)).toBe(true);
    expect(handlers.has(TEAM_SET_CHANGE_PRESENCE_TRACKING)).toBe(true);
    expect(handlers.has(TEAM_DELETE_TEAM)).toBe(true);
    expect(handlers.has(TEAM_PREPARE_PROVISIONING)).toBe(true);
    expect(handlers.has(TEAM_CREATE)).toBe(true);
    expect(handlers.has(TEAM_LAUNCH)).toBe(true);
    expect(handlers.has(TEAM_CREATE_TASK)).toBe(true);
    expect(handlers.has(TEAM_PROVISIONING_STATUS)).toBe(true);
    expect(handlers.has(TEAM_CANCEL_PROVISIONING)).toBe(true);
    expect(handlers.has(TEAM_SEND_MESSAGE)).toBe(true);
    expect(handlers.has(TEAM_REQUEST_REVIEW)).toBe(true);
    expect(handlers.has(TEAM_UPDATE_KANBAN)).toBe(true);
    expect(handlers.has(TEAM_UPDATE_KANBAN_COLUMN_ORDER)).toBe(true);
    expect(handlers.has(TEAM_UPDATE_TASK_STATUS)).toBe(true);
    expect(handlers.has(TEAM_START_TASK)).toBe(true);
    expect(handlers.has(TEAM_PROCESS_SEND)).toBe(true);
    expect(handlers.has(TEAM_PROCESS_ALIVE)).toBe(true);
    expect(handlers.has(TEAM_ALIVE_LIST)).toBe(true);
    expect(handlers.has(TEAM_STOP)).toBe(true);
    expect(handlers.has(TEAM_CREATE_CONFIG)).toBe(true);
    expect(handlers.has(TEAM_GET_MEMBER_LOGS)).toBe(true);
    expect(handlers.has(TEAM_GET_LOGS_FOR_TASK)).toBe(true);
    expect(handlers.has(TEAM_GET_TASK_ACTIVITY)).toBe(true);
    expect(handlers.has(TEAM_GET_TASK_LOG_STREAM)).toBe(true);
    expect(handlers.has(TEAM_GET_TASK_EXACT_LOG_SUMMARIES)).toBe(true);
    expect(handlers.has(TEAM_GET_TASK_EXACT_LOG_DETAIL)).toBe(true);
    expect(handlers.has(TEAM_GET_MEMBER_STATS)).toBe(true);
    expect(handlers.has(TEAM_UPDATE_CONFIG)).toBe(true);
    expect(handlers.has(TEAM_GET_ALL_TASKS)).toBe(true);
    expect(handlers.has(TEAM_ADD_TASK_COMMENT)).toBe(true);
    expect(handlers.has(TEAM_ADD_MEMBER)).toBe(true);
    expect(handlers.has(TEAM_REMOVE_MEMBER)).toBe(true);
    expect(handlers.has(TEAM_UPDATE_MEMBER_ROLE)).toBe(true);
    expect(handlers.has(TEAM_KILL_PROCESS)).toBe(true);
    expect(handlers.has(TEAM_LEAD_ACTIVITY)).toBe(true);
    expect(handlers.has(TEAM_SOFT_DELETE_TASK)).toBe(true);
    expect(handlers.has(TEAM_GET_DELETED_TASKS)).toBe(true);
    expect(handlers.has(TEAM_SET_TASK_CLARIFICATION)).toBe(true);
    expect(handlers.has(TEAM_RESTORE)).toBe(true);
    expect(handlers.has(TEAM_PERMANENTLY_DELETE)).toBe(true);
    expect(handlers.has(TEAM_ADD_TASK_RELATIONSHIP)).toBe(true);
    expect(handlers.has(TEAM_REMOVE_TASK_RELATIONSHIP)).toBe(true);
    expect(handlers.has(TEAM_UPDATE_TASK_OWNER)).toBe(true);
    expect(handlers.has(TEAM_UPDATE_TASK_FIELDS)).toBe(true);
    expect(handlers.has(TEAM_REPLACE_MEMBERS)).toBe(true);
    expect(handlers.has(TEAM_GET_PROJECT_BRANCH)).toBe(true);
    expect(handlers.has(TEAM_GET_ATTACHMENTS)).toBe(true);
    expect(handlers.has(TEAM_LEAD_CONTEXT)).toBe(true);
    expect(handlers.has(TEAM_RESTORE_TASK)).toBe(true);
    expect(handlers.has(TEAM_SHOW_MESSAGE_NOTIFICATION)).toBe(true);
    expect(handlers.has(TEAM_SAVE_TASK_ATTACHMENT)).toBe(true);
    expect(handlers.has(TEAM_GET_TASK_ATTACHMENT)).toBe(true);
    expect(handlers.has(TEAM_DELETE_TASK_ATTACHMENT)).toBe(true);
  });

  it('updates change presence tracking for a team', async () => {
    const handler = handlers.get(TEAM_SET_CHANGE_PRESENCE_TRACKING);
    expect(handler).toBeDefined();

    const result = (await handler!({} as never, 'my-team', true)) as {
      success: boolean;
      data?: void;
    };

    expect(result.success).toBe(true);
    expect(service.setTaskChangePresenceTracking).toHaveBeenCalledWith('my-team', true);
  });

  it('returns lightweight task change presence for a team', async () => {
    const handler = handlers.get(TEAM_GET_TASK_CHANGE_PRESENCE);
    expect(handler).toBeDefined();

    const result = (await handler!({} as never, 'my-team')) as {
      success: boolean;
      data?: Record<string, string>;
    };

    expect(result).toEqual({ success: true, data: { 'task-1': 'has_changes' } });
    expect(service.getTaskChangePresence).toHaveBeenCalledWith('my-team');
  });

  it('returns explicit exact task-log summaries for a task', async () => {
    boardTaskExactLogsService.getTaskExactLogSummaries.mockResolvedValueOnce({
      items: [
        {
          id: 'tool:/tmp/task.jsonl:tool-1',
          timestamp: '2026-04-12T16:00:00.000Z',
          actor: {
            memberName: 'alice',
            role: 'member',
            sessionId: 'session-1',
            agentId: 'agent-1',
            isSidechain: true,
          },
          source: {
            filePath: '/tmp/task.jsonl',
            messageUuid: 'msg-1',
            toolUseId: 'tool-1',
            sourceOrder: 1,
          },
          anchorKind: 'tool',
          actionLabel: 'Added a comment',
          actionCategory: 'comment',
          canonicalToolName: 'task_add_comment',
          linkKinds: ['board_action'],
          canLoadDetail: true,
          sourceGeneration: 'gen-1',
        },
      ],
    });

    const handler = handlers.get(TEAM_GET_TASK_EXACT_LOG_SUMMARIES);
    expect(handler).toBeDefined();

    const result = (await handler!(
      {} as never,
      'my-team',
      '123e4567-e89b-12d3-a456-426614174000'
    )) as {
      success: boolean;
      data?: BoardTaskExactLogSummariesResponse;
    };

    expect(result.success).toBe(true);
    expect(result.data?.items).toHaveLength(1);
    expect(boardTaskExactLogsService.getTaskExactLogSummaries).toHaveBeenCalledWith(
      'my-team',
      '123e4567-e89b-12d3-a456-426614174000'
    );
  });

  it('returns one task log stream for a task', async () => {
    boardTaskLogStreamService.getTaskLogStream.mockResolvedValueOnce({
      participants: [
        {
          key: 'member:alice',
          label: 'alice',
          role: 'member',
          isLead: false,
          isSidechain: true,
        },
      ],
      defaultFilter: 'all',
      segments: [],
    });

    const handler = handlers.get(TEAM_GET_TASK_LOG_STREAM);
    expect(handler).toBeDefined();

    const result = (await handler!(
      {} as never,
      'my-team',
      '123e4567-e89b-12d3-a456-426614174000'
    )) as {
      success: boolean;
      data?: BoardTaskLogStreamResponse;
    };

    expect(result.success).toBe(true);
    expect(result.data?.participants).toHaveLength(1);
    expect(boardTaskLogStreamService.getTaskLogStream).toHaveBeenCalledWith(
      'my-team',
      '123e4567-e89b-12d3-a456-426614174000'
    );
  });

  it('returns exact task-log detail for a task bundle', async () => {
    boardTaskExactLogDetailService.getTaskExactLogDetail.mockResolvedValueOnce({
      status: 'ok',
      detail: {
        id: 'tool:/tmp/task.jsonl:tool-1',
        chunks: [],
      },
    });

    const handler = handlers.get(TEAM_GET_TASK_EXACT_LOG_DETAIL);
    expect(handler).toBeDefined();

    const result = (await handler!(
      {} as never,
      'my-team',
      '123e4567-e89b-12d3-a456-426614174000',
      'tool:/tmp/task.jsonl:tool-1',
      'gen-1'
    )) as {
      success: boolean;
      data?: BoardTaskExactLogDetailResult;
    };

    expect(result.success).toBe(true);
    expect(result.data?.status).toBe('ok');
    expect(boardTaskExactLogDetailService.getTaskExactLogDetail).toHaveBeenCalledWith(
      'my-team',
      '123e4567-e89b-12d3-a456-426614174000',
      'tool:/tmp/task.jsonl:tool-1',
      'gen-1'
    );
  });

  it('returns exact task-log detail stale status without rewriting the service result', async () => {
    boardTaskExactLogDetailService.getTaskExactLogDetail.mockResolvedValueOnce({
      status: 'stale',
    });

    const handler = handlers.get(TEAM_GET_TASK_EXACT_LOG_DETAIL);
    expect(handler).toBeDefined();

    const result = (await handler!(
      {} as never,
      'my-team',
      '123e4567-e89b-12d3-a456-426614174000',
      'tool:/tmp/task.jsonl:tool-1',
      'gen-2'
    )) as {
      success: boolean;
      data?: BoardTaskExactLogDetailResult;
    };

    expect(result).toEqual({
      success: true,
      data: { status: 'stale' },
    });
  });

  it('returns success false on invalid sendMessage args', async () => {
    const sendHandler = handlers.get(TEAM_SEND_MESSAGE);
    expect(sendHandler).toBeDefined();
    const result = (await sendHandler!({} as never, '../bad', {
      member: 'alice',
      text: 'hi',
    })) as { success: boolean };
    expect(result.success).toBe(false);
  });

  it('passes hidden ask-mode instructions to a live lead without exposing them in stored text', async () => {
    const sendHandler = handlers.get(TEAM_SEND_MESSAGE);
    expect(sendHandler).toBeDefined();

    const result = (await sendHandler!({} as never, 'my-team', {
      member: 'team-lead',
      text: 'Can you review the approach?',
      actionMode: 'ask',
    })) as { success: boolean };

    expect(result.success).toBe(true);
    expect(provisioningService.sendMessageToTeam).toHaveBeenCalledWith(
      'my-team',
      expect.stringContaining('TURN ACTION MODE: ASK'),
      undefined
    );
    expect(provisioningService.sendMessageToTeam).toHaveBeenCalledWith(
      'my-team',
      expect.stringContaining('FORBIDDEN: editing files, changing code, changing task/board state, delegating work, launching Agent/subagents'),
      undefined
    );
    expect(service.sendDirectToLead).toHaveBeenCalledWith(
      'my-team',
      'team-lead',
      'Can you review the approach?',
      undefined,
      undefined,
      undefined,
      expect.any(String)
    );
  });

  it('injects durable teammate roster context into the first live lead direct-message wrapper', async () => {
    mockGetMembersMeta.mockResolvedValueOnce([
      { name: 'team-lead', role: 'lead' },
      { name: 'alice', role: 'reviewer' },
      { name: 'jack', role: 'developer' },
    ]);
    const sendHandler = handlers.get(TEAM_SEND_MESSAGE);
    expect(sendHandler).toBeDefined();

    const result = (await sendHandler!({} as never, 'my-team', {
      member: 'team-lead',
      text: 'Who is on the team right now?',
    })) as { success: boolean };

    expect(result.success).toBe(true);
    expect(provisioningService.sendMessageToTeam).toHaveBeenCalledWith(
      'my-team',
      expect.stringContaining('Current durable team context:'),
      undefined
    );
    expect(provisioningService.sendMessageToTeam).toHaveBeenCalledWith(
      'my-team',
      expect.stringContaining('Persistent teammates currently configured: alice (reviewer), jack (developer)'),
      undefined
    );
    expect(provisioningService.sendMessageToTeam).toHaveBeenCalledWith(
      'my-team',
      expect.stringContaining('This team is NOT in solo mode'),
      undefined
    );
  });

  it('adds a visible-first acknowledgement contract for live lead delegate turns', async () => {
    const sendHandler = handlers.get(TEAM_SEND_MESSAGE);
    expect(sendHandler).toBeDefined();

    const result = (await sendHandler!({} as never, 'my-team', {
      member: 'team-lead',
      text: 'Delegate this work',
      actionMode: 'delegate',
    })) as { success: boolean };

    expect(result.success).toBe(true);
    expect(provisioningService.sendMessageToTeam).toHaveBeenCalledWith(
      'my-team',
      expect.stringContaining('DELEGATE MODE USER ACK CONTRACT:'),
      undefined
    );
    expect(provisioningService.sendMessageToTeam).toHaveBeenCalledWith(
      'my-team',
      expect.stringContaining('Make the acknowledgement at least 40 characters so it is preserved in the Messages panel.'),
      undefined
    );
  });

  it('omits roster context when durable teammate roster is empty', async () => {
    mockGetMembersMeta.mockResolvedValueOnce([]);
    service.getTeamData.mockResolvedValueOnce({
      teamName: 'my-team',
      config: { name: 'My Team' },
      tasks: [],
      members: [],
      messages: [] as InboxMessage[],
      kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
      processes: [],
    });
    const sendHandler = handlers.get(TEAM_SEND_MESSAGE);
    expect(sendHandler).toBeDefined();

    const result = (await sendHandler!({} as never, 'my-team', {
      member: 'team-lead',
      text: 'Who is on the team right now?',
    })) as { success: boolean };

    expect(result.success).toBe(true);
    const stdinCall = vi.mocked(provisioningService.sendMessageToTeam).mock.calls[0] as
      | unknown[]
      | undefined;
    expect(String(stdinCall?.[1] ?? '')).not.toContain('Current durable team context:');
  });

  it('sends standalone slash commands to lead stdin without the UI routing wrapper', async () => {
    const sendHandler = handlers.get(TEAM_SEND_MESSAGE);
    expect(sendHandler).toBeDefined();

    const result = (await sendHandler!({} as never, 'my-team', {
      member: 'team-lead',
      text: '  /COMPACT keep kanban  ',
    })) as { success: boolean };

    expect(result.success).toBe(true);
    expect(provisioningService.sendMessageToTeam).toHaveBeenCalledWith(
      'my-team',
      '/COMPACT keep kanban',
      undefined
    );
    const compactCall = vi.mocked(provisioningService.sendMessageToTeam).mock
      .calls as unknown[][];
    expect(String(compactCall[0]?.[1] ?? '')).not.toContain('You received a direct message from the user');
    expect(String(compactCall[0]?.[1] ?? '')).not.toContain('Current durable team context:');
    expect(service.sendDirectToLead).toHaveBeenCalledWith(
      'my-team',
      'team-lead',
      '/COMPACT keep kanban',
      undefined,
      undefined,
      undefined,
      expect.any(String)
    );
  });

  it('routes unknown standalone slash commands through the same raw stdin path', async () => {
    const sendHandler = handlers.get(TEAM_SEND_MESSAGE);
    expect(sendHandler).toBeDefined();

    const result = (await sendHandler!({} as never, 'my-team', {
      member: 'team-lead',
      text: ' /foo bar ',
    })) as { success: boolean };

    expect(result.success).toBe(true);
    expect(provisioningService.sendMessageToTeam).toHaveBeenCalledWith(
      'my-team',
      '/foo bar',
      undefined
    );
    const unknownSlashCall = vi.mocked(provisioningService.sendMessageToTeam).mock
      .calls as unknown[][];
    expect(String(unknownSlashCall[0]?.[1] ?? '')).not.toContain(
      'You received a direct message from the user'
    );
    expect(String(unknownSlashCall[0]?.[1] ?? '')).not.toContain('Current durable team context:');
    expect(service.sendDirectToLead).toHaveBeenCalledWith(
      'my-team',
      'team-lead',
      '/foo bar',
      undefined,
      undefined,
      undefined,
      expect.any(String)
    );
  });

  it('does not route slash commands through raw stdin when attachments are present', async () => {
    const sendHandler = handlers.get(TEAM_SEND_MESSAGE);
    expect(sendHandler).toBeDefined();
    vi.stubEnv('HOME', os.tmpdir());
    try {
      const result = (await sendHandler!({} as never, 'my-team', {
        member: 'team-lead',
        text: '/compact keep kanban',
        attachments: [
          {
            id: 'att-1',
            filename: 'note.txt',
            mimeType: 'text/plain',
            size: 4,
            data: Buffer.from('test').toString('base64'),
          },
        ],
      })) as { success: boolean };

      expect(result.success).toBe(true);
      expect(provisioningService.sendMessageToTeam).toHaveBeenCalledWith(
        'my-team',
        expect.stringContaining('You received a direct message from the user'),
        expect.arrayContaining([
          expect.objectContaining({
            id: 'att-1',
            filename: 'note.txt',
          }),
        ])
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('rejects delegate mode when recipient is not the team lead', async () => {
    const sendHandler = handlers.get(TEAM_SEND_MESSAGE);
    expect(sendHandler).toBeDefined();

    const result = (await sendHandler!({} as never, 'my-team', {
      member: 'alice',
      text: 'Take this on',
      actionMode: 'delegate',
    })) as { success: boolean; error?: string };

    expect(result.success).toBe(false);
    expect(result.error).toBe('Delegate mode is only supported when messaging the team lead');
  });

  it('calls service and returns success on happy paths', async () => {
    const listResult = (await handlers.get(TEAM_LIST)!({} as never)) as {
      success: boolean;
      data: unknown[];
    };
    expect(listResult.success).toBe(true);
    expect(service.listTeams).toHaveBeenCalledTimes(1);

    const createResult = (await handlers.get(TEAM_CREATE)!({ sender: { send: vi.fn() } } as never, {
      teamName: 'my-team',
      members: [{ name: 'alice' }],
      cwd: os.tmpdir(),
    })) as { success: boolean };
    expect(createResult.success).toBe(true);
    expect(provisioningService.createTeam).toHaveBeenCalledTimes(1);

    const statusResult = (await handlers.get(TEAM_PROVISIONING_STATUS)!({} as never, 'run-1')) as {
      success: boolean;
    };
    expect(statusResult.success).toBe(true);
    expect(provisioningService.getProvisioningStatus).toHaveBeenCalledWith('run-1');

    const cancelResult = (await handlers.get(TEAM_CANCEL_PROVISIONING)!({} as never, 'run-1')) as {
      success: boolean;
    };
    expect(cancelResult.success).toBe(true);
    expect(provisioningService.cancelProvisioning).toHaveBeenCalledWith('run-1');

    const reviewResult = (await handlers.get(TEAM_REQUEST_REVIEW)!(
      {} as never,
      'my-team',
      '12'
    )) as {
      success: boolean;
    };
    expect(reviewResult.success).toBe(true);
    expect(service.requestReview).toHaveBeenCalledWith('my-team', '12');

    const kanbanResult = (await handlers.get(TEAM_UPDATE_KANBAN)!({} as never, 'my-team', '12', {
      op: 'set_column',
      column: 'approved',
    })) as { success: boolean };
    expect(kanbanResult.success).toBe(true);
    expect(service.updateKanban).toHaveBeenCalledWith('my-team', '12', {
      op: 'set_column',
      column: 'approved',
    });
  });

  it('dedups live lead replies when lead_session already has same text', async () => {
    service.getTeamData.mockResolvedValueOnce({
      teamName: 'my-team',
      config: { name: 'My Team' },
      tasks: [],
      members: [],
      messages: [
        {
          from: 'team-lead',
          text: 'Hello there',
          timestamp: '2026-02-23T10:00:00.000Z',
          read: true,
          source: 'lead_session' as const,
        },
      ],
      kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
      processes: [],
    });
    provisioningService.getLiveLeadProcessMessages.mockReturnValueOnce([
      {
        from: 'team-lead',
        text: 'Hello there',
        timestamp: '2026-02-23T10:00:01.000Z',
        read: true,
        source: 'lead_process' as const,
        messageId: 'live-1',
      },
    ]);

    const getDataHandler = handlers.get(TEAM_GET_DATA)!;
    const result = (await getDataHandler({} as never, 'my-team')) as {
      success: boolean;
      data: { messages: { source?: string }[] };
    };
    expect(result.success).toBe(true);
    const sources = result.data.messages.map((m) => m.source);
    expect(sources.filter((s) => s === 'lead_process')).toHaveLength(0);
    expect(sources.filter((s) => s === 'lead_session')).toHaveLength(1);
  });

  it('merges early live messages before durable lead_session backfill exists', async () => {
    // Simulate: team just became readable but lead_session JSONL hasn't been written yet.
    // Only live in-memory messages exist from the provisioning process.
    service.getTeamData.mockResolvedValueOnce({
      teamName: 'my-team',
      config: { name: 'My Team' },
      tasks: [],
      members: [],
      messages: [], // No durable messages yet
      kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
      processes: [],
    });
    provisioningService.getLiveLeadProcessMessages.mockReturnValueOnce([
      {
        from: 'team-lead',
        text: 'Команда создана. Запускаю тиммейтов.',
        timestamp: '2026-02-23T10:00:00.000Z',
        read: true,
        source: 'lead_process' as const,
        messageId: 'lead-turn-run-1-1',
      },
      {
        from: 'team-lead',
        text: 'All teammates online!',
        timestamp: '2026-02-23T10:00:01.000Z',
        read: true,
        source: 'lead_process' as const,
        messageId: 'lead-turn-run-1-2',
        to: 'user',
      },
    ]);

    const getDataHandler = handlers.get(TEAM_GET_DATA)!;
    const result = (await getDataHandler({} as never, 'my-team')) as {
      success: boolean;
      data: { messages: { source?: string; text: string }[] };
    };
    expect(result.success).toBe(true);
    // Both live messages should appear since there's no durable backfill yet
    // Sorted by timestamp descending (newest first)
    expect(result.data.messages).toHaveLength(2);
    expect(result.data.messages[0].source).toBe('lead_process');
    expect(result.data.messages[0].text).toBe('All teammates online!');
    expect(result.data.messages[1].source).toBe('lead_process');
    expect(result.data.messages[1].text).toBe('Команда создана. Запускаю тиммейтов.');
  });

  it('keeps TEAM_GET_DATA read-only and never triggers reconcile side effects', async () => {
    const getDataHandler = handlers.get(TEAM_GET_DATA)!;
    const result = (await getDataHandler({} as never, 'my-team')) as {
      success: boolean;
      data: { teamName: string };
    };

    expect(result.success).toBe(true);
    expect(result.data.teamName).toBe('my-team');
    expect(service.getTeamData).toHaveBeenCalledWith('my-team');
    expect(service.reconcileTeamArtifacts).not.toHaveBeenCalled();
  });

  describe('createTask prompt validation', () => {
    it('accepts valid prompt string', async () => {
      const handler = handlers.get(TEAM_CREATE_TASK)!;
      const result = (await handler({} as never, 'my-team', {
        subject: 'Do something',
        prompt: 'Custom instructions here',
      })) as { success: boolean };
      expect(result.success).toBe(true);
      expect(service.createTask).toHaveBeenCalledWith('my-team', {
        subject: 'Do something',
        description: undefined,
        owner: undefined,
        blockedBy: undefined,
        prompt: 'Custom instructions here',
        startImmediately: undefined,
      });
    });

    it('rejects non-string prompt', async () => {
      const handler = handlers.get(TEAM_CREATE_TASK)!;
      const result = (await handler({} as never, 'my-team', {
        subject: 'Do something',
        prompt: 42,
      })) as { success: boolean; error: string };
      expect(result.success).toBe(false);
      expect(result.error).toContain('prompt must be a string');
    });

    it('rejects prompt exceeding max length', async () => {
      const handler = handlers.get(TEAM_CREATE_TASK)!;
      const result = (await handler({} as never, 'my-team', {
        subject: 'Do something',
        prompt: 'x'.repeat(5001),
      })) as { success: boolean; error: string };
      expect(result.success).toBe(false);
      expect(result.error).toContain('prompt exceeds max length');
    });

    it('passes undefined prompt when not provided', async () => {
      const handler = handlers.get(TEAM_CREATE_TASK)!;
      const result = (await handler({} as never, 'my-team', {
        subject: 'Do something',
      })) as { success: boolean };
      expect(result.success).toBe(true);
      expect(service.createTask).toHaveBeenCalledWith('my-team', {
        subject: 'Do something',
        description: undefined,
        owner: undefined,
        blockedBy: undefined,
        prompt: undefined,
        startImmediately: undefined,
      });
    });
  });

  describe('addMember', () => {
    it('calls service on valid input', async () => {
      const handler = handlers.get(TEAM_ADD_MEMBER)!;
      const result = (await handler({} as never, 'my-team', {
        name: 'alice',
        role: 'developer',
      })) as { success: boolean };
      expect(result.success).toBe(true);
      expect(service.addMember).toHaveBeenCalledWith('my-team', {
        name: 'alice',
        role: 'developer',
      });
    });

    it('notifies a live lead to use member_briefing bootstrap for the new teammate', async () => {
      const handler = handlers.get(TEAM_ADD_MEMBER)!;
      const result = (await handler({} as never, 'my-team', {
        name: 'alice',
        role: 'developer',
        workflow: 'Focus on frontend polish',
      })) as { success: boolean };

      expect(result.success).toBe(true);
      expect(provisioningService.sendMessageToTeam).toHaveBeenCalledWith(
        'my-team',
        expect.stringContaining('and the exact prompt below:')
      );
      expect(provisioningService.sendMessageToTeam).toHaveBeenCalledWith(
        'my-team',
        expect.stringContaining('Your FIRST action: call MCP tool member_briefing')
      );
      expect(provisioningService.sendMessageToTeam).toHaveBeenCalledWith(
        'my-team',
        expect.stringContaining('Do NOT start work, claim tasks, or improvise workflow/task/process rules')
      );
      expect(provisioningService.sendMessageToTeam).toHaveBeenCalledWith(
        'my-team',
        expect.stringContaining('You are alice, a developer on team "My Team" (my-team).')
      );
      expect(provisioningService.sendMessageToTeam).toHaveBeenCalledWith(
        'my-team',
        expect.stringContaining('Their workflow: Focus on frontend polish')
      );
    });

    it('rejects invalid team name', async () => {
      const handler = handlers.get(TEAM_ADD_MEMBER)!;
      const result = (await handler({} as never, '../bad', {
        name: 'alice',
      })) as { success: boolean };
      expect(result.success).toBe(false);
    });

    it('rejects invalid member name', async () => {
      const handler = handlers.get(TEAM_ADD_MEMBER)!;
      const result = (await handler({} as never, 'my-team', {
        name: '../bad',
      })) as { success: boolean };
      expect(result.success).toBe(false);
    });

    it('rejects missing payload', async () => {
      const handler = handlers.get(TEAM_ADD_MEMBER)!;
      const result = (await handler({} as never, 'my-team', null)) as { success: boolean };
      expect(result.success).toBe(false);
    });
  });

  describe('removeMember', () => {
    it('calls service on valid input', async () => {
      const handler = handlers.get(TEAM_REMOVE_MEMBER)!;
      const result = (await handler({} as never, 'my-team', 'alice')) as { success: boolean };
      expect(result.success).toBe(true);
      expect(service.removeMember).toHaveBeenCalledWith('my-team', 'alice');
    });

    it('rejects invalid team name', async () => {
      const handler = handlers.get(TEAM_REMOVE_MEMBER)!;
      const result = (await handler({} as never, '../bad', 'alice')) as { success: boolean };
      expect(result.success).toBe(false);
    });

    it('rejects invalid member name', async () => {
      const handler = handlers.get(TEAM_REMOVE_MEMBER)!;
      const result = (await handler({} as never, 'my-team', '../bad')) as { success: boolean };
      expect(result.success).toBe(false);
    });
  });

  describe('updateMemberRole', () => {
    it('calls service on valid input', async () => {
      const handler = handlers.get(TEAM_UPDATE_MEMBER_ROLE)!;
      const result = (await handler({} as never, 'my-team', 'alice', 'developer')) as {
        success: boolean;
      };
      expect(result.success).toBe(true);
      expect(service.updateMemberRole).toHaveBeenCalledWith('my-team', 'alice', 'developer');
    });

    it('normalizes null role to undefined', async () => {
      const handler = handlers.get(TEAM_UPDATE_MEMBER_ROLE)!;
      const result = (await handler({} as never, 'my-team', 'alice', null)) as {
        success: boolean;
      };
      expect(result.success).toBe(true);
      expect(service.updateMemberRole).toHaveBeenCalledWith('my-team', 'alice', undefined);
    });

    it('rejects invalid team name', async () => {
      const handler = handlers.get(TEAM_UPDATE_MEMBER_ROLE)!;
      const result = (await handler({} as never, '../bad', 'alice', 'dev')) as {
        success: boolean;
      };
      expect(result.success).toBe(false);
    });

    it('rejects invalid member name', async () => {
      const handler = handlers.get(TEAM_UPDATE_MEMBER_ROLE)!;
      const result = (await handler({} as never, 'my-team', '../bad', 'dev')) as {
        success: boolean;
      };
      expect(result.success).toBe(false);
    });
  });

  describe('createTeam prompt validation', () => {
    it('accepts valid prompt in team create request', async () => {
      const handler = handlers.get(TEAM_CREATE)!;
      const result = (await handler({ sender: { send: vi.fn() } } as never, {
        teamName: 'test-team',
        members: [{ name: 'alice' }],
        cwd: os.tmpdir(),
        prompt: 'Build a web app',
      })) as { success: boolean };
      expect(result.success).toBe(true);
      const callArg = provisioningService.createTeam.mock.calls[0][0];
      expect(callArg.prompt).toBe('Build a web app');
    });

    it('rejects non-string prompt in team create request', async () => {
      const handler = handlers.get(TEAM_CREATE)!;
      const result = (await handler({ sender: { send: vi.fn() } } as never, {
        teamName: 'test-team',
        members: [{ name: 'alice' }],
        cwd: os.tmpdir(),
        prompt: 123,
      })) as { success: boolean; error: string };
      expect(result.success).toBe(false);
      expect(result.error).toContain('prompt must be a string');
    });
  });

  it('removes handlers', () => {
    removeTeamHandlers(ipcMain as never);
    expect(handlers.has(TEAM_LIST)).toBe(false);
    expect(handlers.has(TEAM_GET_DATA)).toBe(false);
    expect(handlers.has(TEAM_DELETE_TEAM)).toBe(false);
    expect(handlers.has(TEAM_PREPARE_PROVISIONING)).toBe(false);
    expect(handlers.has(TEAM_CREATE)).toBe(false);
    expect(handlers.has(TEAM_LAUNCH)).toBe(false);
    expect(handlers.has(TEAM_CREATE_TASK)).toBe(false);
    expect(handlers.has(TEAM_PROVISIONING_STATUS)).toBe(false);
    expect(handlers.has(TEAM_CANCEL_PROVISIONING)).toBe(false);
    expect(handlers.has(TEAM_SEND_MESSAGE)).toBe(false);
    expect(handlers.has(TEAM_REQUEST_REVIEW)).toBe(false);
    expect(handlers.has(TEAM_UPDATE_KANBAN)).toBe(false);
    expect(handlers.has(TEAM_UPDATE_KANBAN_COLUMN_ORDER)).toBe(false);
    expect(handlers.has(TEAM_UPDATE_TASK_STATUS)).toBe(false);
    expect(handlers.has(TEAM_START_TASK)).toBe(false);
    expect(handlers.has(TEAM_PROCESS_SEND)).toBe(false);
    expect(handlers.has(TEAM_PROCESS_ALIVE)).toBe(false);
    expect(handlers.has(TEAM_ALIVE_LIST)).toBe(false);
    expect(handlers.has(TEAM_STOP)).toBe(false);
    expect(handlers.has(TEAM_CREATE_CONFIG)).toBe(false);
    expect(handlers.has(TEAM_GET_MEMBER_LOGS)).toBe(false);
    expect(handlers.has(TEAM_GET_LOGS_FOR_TASK)).toBe(false);
    expect(handlers.has(TEAM_GET_TASK_ACTIVITY)).toBe(false);
    expect(handlers.has(TEAM_GET_TASK_LOG_STREAM)).toBe(false);
    expect(handlers.has(TEAM_GET_MEMBER_STATS)).toBe(false);
    expect(handlers.has(TEAM_UPDATE_CONFIG)).toBe(false);
    expect(handlers.has(TEAM_GET_ALL_TASKS)).toBe(false);
    expect(handlers.has(TEAM_ADD_TASK_COMMENT)).toBe(false);
    expect(handlers.has(TEAM_ADD_MEMBER)).toBe(false);
    expect(handlers.has(TEAM_REMOVE_MEMBER)).toBe(false);
    expect(handlers.has(TEAM_UPDATE_MEMBER_ROLE)).toBe(false);
    expect(handlers.has(TEAM_GET_PROJECT_BRANCH)).toBe(false);
    expect(handlers.has(TEAM_GET_ATTACHMENTS)).toBe(false);
    expect(handlers.has(TEAM_KILL_PROCESS)).toBe(false);
    expect(handlers.has(TEAM_LEAD_ACTIVITY)).toBe(false);
    expect(handlers.has(TEAM_SOFT_DELETE_TASK)).toBe(false);
    expect(handlers.has(TEAM_GET_DELETED_TASKS)).toBe(false);
    expect(handlers.has(TEAM_SET_TASK_CLARIFICATION)).toBe(false);
    expect(handlers.has(TEAM_RESTORE)).toBe(false);
    expect(handlers.has(TEAM_PERMANENTLY_DELETE)).toBe(false);
    expect(handlers.has(TEAM_ADD_TASK_RELATIONSHIP)).toBe(false);
    expect(handlers.has(TEAM_REMOVE_TASK_RELATIONSHIP)).toBe(false);
    expect(handlers.has(TEAM_UPDATE_TASK_OWNER)).toBe(false);
    expect(handlers.has(TEAM_UPDATE_TASK_FIELDS)).toBe(false);
    expect(handlers.has(TEAM_REPLACE_MEMBERS)).toBe(false);
    expect(handlers.has(TEAM_LEAD_CONTEXT)).toBe(false);
    expect(handlers.has(TEAM_RESTORE_TASK)).toBe(false);
    expect(handlers.has(TEAM_SHOW_MESSAGE_NOTIFICATION)).toBe(false);
    expect(handlers.has(TEAM_SAVE_TASK_ATTACHMENT)).toBe(false);
    expect(handlers.has(TEAM_GET_TASK_ATTACHMENT)).toBe(false);
    expect(handlers.has(TEAM_DELETE_TASK_ATTACHMENT)).toBe(false);
  });

  it('returns explicit task activity rows', async () => {
    const handler = handlers.get(TEAM_GET_TASK_ACTIVITY);
    expect(handler).toBeDefined();

    const activityRows: BoardTaskActivityEntry[] = [
      {
        id: 'activity-1',
        timestamp: '2026-04-12T10:00:00.000Z',
        task: {
          locator: { ref: 'abcd1234', refKind: 'display' },
          resolution: 'resolved',
        },
        linkKind: 'lifecycle',
        targetRole: 'subject',
        actor: {
          role: 'lead',
          sessionId: 'session-1',
          isSidechain: false,
        },
        actorContext: {
          relation: 'idle',
        },
        source: {
          messageUuid: 'message-1',
          filePath: '/tmp/transcript.jsonl',
          sourceOrder: 1,
        },
      },
    ];
    boardTaskActivityService.getTaskActivity.mockResolvedValueOnce(activityRows);

    const result = (await handler!({} as never, 'my-team', 'task-1')) as {
      success: boolean;
      data: typeof activityRows;
    };

    expect(result).toEqual({ success: true, data: activityRows });
    expect(boardTaskActivityService.getTaskActivity).toHaveBeenCalledWith('my-team', 'task-1');
  });

  it('returns focused task activity detail for one row', async () => {
    const handler = handlers.get(TEAM_GET_TASK_ACTIVITY_DETAIL);
    expect(handler).toBeDefined();

    boardTaskActivityDetailService.getTaskActivityDetail.mockResolvedValueOnce({
      status: 'ok',
      detail: {
        entryId: 'activity-1',
        summaryLabel: 'Added a comment',
        actorLabel: 'bob',
        timestamp: '2026-04-13T10:35:00.000Z',
        contextLines: ['while working on #peer12345'],
        metadataRows: [{ label: 'Comment', value: '42' }],
      },
    });

    const result = (await handler!({} as never, 'my-team', 'task-1', 'activity-1')) as {
      success: boolean;
      data?: BoardTaskActivityDetailResult;
    };

    expect(result.success).toBe(true);
    expect(result.data?.status).toBe('ok');
    expect(boardTaskActivityDetailService.getTaskActivityDetail).toHaveBeenCalledWith(
      'my-team',
      'task-1',
      'activity-1'
    );
  });

  describe('addTaskRelationship', () => {
    it('calls service on valid input', async () => {
      const handler = handlers.get(TEAM_ADD_TASK_RELATIONSHIP)!;
      const result = (await handler({} as never, 'my-team', '1', '2', 'blockedBy')) as {
        success: boolean;
      };
      expect(result.success).toBe(true);
      expect(service.addTaskRelationship).toHaveBeenCalledWith('my-team', '1', '2', 'blockedBy');
    });

    it('rejects invalid team name', async () => {
      const handler = handlers.get(TEAM_ADD_TASK_RELATIONSHIP)!;
      const result = (await handler({} as never, '../bad', '1', '2', 'blockedBy')) as {
        success: boolean;
      };
      expect(result.success).toBe(false);
    });

    it('rejects invalid task id', async () => {
      const handler = handlers.get(TEAM_ADD_TASK_RELATIONSHIP)!;
      const result = (await handler({} as never, 'my-team', 'bad/id', '2', 'blockedBy')) as {
        success: boolean;
      };
      expect(result.success).toBe(false);
    });

    it('rejects invalid target id', async () => {
      const handler = handlers.get(TEAM_ADD_TASK_RELATIONSHIP)!;
      const result = (await handler({} as never, 'my-team', '1', '', 'blockedBy')) as {
        success: boolean;
      };
      expect(result.success).toBe(false);
    });

    it('rejects invalid relationship type', async () => {
      const handler = handlers.get(TEAM_ADD_TASK_RELATIONSHIP)!;
      const result = (await handler({} as never, 'my-team', '1', '2', 'invalid')) as {
        success: boolean;
      };
      expect(result.success).toBe(false);
    });
  });

  describe('removeTaskRelationship', () => {
    it('calls service on valid input', async () => {
      const handler = handlers.get(TEAM_REMOVE_TASK_RELATIONSHIP)!;
      const result = (await handler({} as never, 'my-team', '1', '2', 'related')) as {
        success: boolean;
      };
      expect(result.success).toBe(true);
      expect(service.removeTaskRelationship).toHaveBeenCalledWith('my-team', '1', '2', 'related');
    });

    it('rejects invalid team name', async () => {
      const handler = handlers.get(TEAM_REMOVE_TASK_RELATIONSHIP)!;
      const result = (await handler({} as never, '../bad', '1', '2', 'related')) as {
        success: boolean;
      };
      expect(result.success).toBe(false);
    });

    it('rejects invalid relationship type', async () => {
      const handler = handlers.get(TEAM_REMOVE_TASK_RELATIONSHIP)!;
      const result = (await handler({} as never, 'my-team', '1', '2', 'unknown')) as {
        success: boolean;
      };
      expect(result.success).toBe(false);
    });
  });

  describe('solo team (zero members)', () => {
    it('createTeam accepts members: [] (provisioning validation)', async () => {
      const handler = handlers.get(TEAM_CREATE)!;
      const result = (await handler({ sender: { send: vi.fn() } } as never, {
        teamName: 'solo-team',
        members: [],
        cwd: os.tmpdir(),
      })) as { success: boolean };
      expect(result.success).toBe(true);
      expect(provisioningService.createTeam).toHaveBeenCalledTimes(1);
      const callArg = provisioningService.createTeam.mock.calls[0][0];
      expect(callArg.members).toEqual([]);
    });

    it('handleCreateConfig accepts members: []', async () => {
      const handler = handlers.get(TEAM_CREATE_CONFIG)!;
      const result = (await handler({} as never, {
        teamName: 'solo-team',
        members: [],
        cwd: os.tmpdir(),
      })) as { success: boolean };
      expect(result.success).toBe(true);
    });

    it('handleReplaceMembers accepts members: []', async () => {
      const handler = handlers.get(TEAM_REPLACE_MEMBERS)!;
      const result = (await handler({} as never, 'my-team', {
        members: [],
      })) as { success: boolean };
      expect(result.success).toBe(true);
      expect(service.replaceMembers).toHaveBeenCalledWith('my-team', { members: [] });
    });

    it('still rejects members as non-array in createTeam', async () => {
      const handler = handlers.get(TEAM_CREATE)!;
      const result = (await handler({ sender: { send: vi.fn() } } as never, {
        teamName: 'solo-team',
        members: 'not-array',
        cwd: os.tmpdir(),
      })) as { success: boolean; error: string };
      expect(result.success).toBe(false);
      expect(result.error).toContain('members must be an array');
    });

    it('still rejects members as non-array in handleCreateConfig', async () => {
      const handler = handlers.get(TEAM_CREATE_CONFIG)!;
      const result = (await handler({} as never, {
        teamName: 'solo-team',
        members: 'not-array',
      })) as { success: boolean; error: string };
      expect(result.success).toBe(false);
      expect(result.error).toContain('members must be an array');
    });

    it('still rejects members as non-array in handleReplaceMembers', async () => {
      const handler = handlers.get(TEAM_REPLACE_MEMBERS)!;
      const result = (await handler({} as never, 'my-team', {
        members: 'not-array',
      })) as { success: boolean; error: string };
      expect(result.success).toBe(false);
      expect(result.error).toContain('members must be an array');
    });
  });

  describe('showMessageNotification', () => {
    it('returns success on valid notification data', async () => {
      const handler = handlers.get(TEAM_SHOW_MESSAGE_NOTIFICATION)!;
      const result = (await handler({} as never, {
        teamDisplayName: 'My Team',
        from: 'alice',
        body: 'Hello!',
        teamName: 'my-team',
        teamEventType: 'task_clarification',
        dedupeKey: 'clarification:my-team:42',
      })) as { success: boolean };
      expect(result.success).toBe(true);
    });

    it('rejects when missing required fields', async () => {
      const handler = handlers.get(TEAM_SHOW_MESSAGE_NOTIFICATION)!;
      const result = (await handler({} as never, {
        teamDisplayName: 'My Team',
        // missing from and body
      })) as { success: boolean; error: string };
      expect(result.success).toBe(false);
      expect(result.error).toContain('Missing required fields');
    });

    it('rejects null data', async () => {
      const handler = handlers.get(TEAM_SHOW_MESSAGE_NOTIFICATION)!;
      const result = (await handler({} as never, null)) as { success: boolean };
      expect(result.success).toBe(false);
    });

    it('generates fallback dedupeKey when not provided', async () => {
      const handler = handlers.get(TEAM_SHOW_MESSAGE_NOTIFICATION)!;
      const result = (await handler({} as never, {
        teamDisplayName: 'My Team',
        teamName: 'my-team',
        from: 'bob',
        body: 'Some message',
      })) as { success: boolean };
      // Should succeed even without explicit dedupeKey (fallback is generated)
      expect(result.success).toBe(true);
    });

    it('rejects when teamName is missing', async () => {
      const handler = handlers.get(TEAM_SHOW_MESSAGE_NOTIFICATION)!;
      const result = (await handler({} as never, {
        teamDisplayName: 'My Team',
        from: 'alice',
        body: 'Hello!',
        // teamName intentionally omitted
      })) as { success: boolean; error: string };
      expect(result.success).toBe(false);
      expect(result.error).toContain('teamName');
    });
  });

  describe('reserved teammate names', () => {
    it('rejects teammate name "user" in createTeam', async () => {
      const handler = handlers.get(TEAM_CREATE)!;
      const result = (await handler({ sender: { send: vi.fn() } } as never, {
        teamName: 'solo-team',
        members: [{ name: 'user' }],
        cwd: os.tmpdir(),
      })) as { success: boolean; error: string };
      expect(result.success).toBe(false);
      expect(result.error.toLowerCase()).toContain('reserved');
    });

    it('rejects teammate name "team-lead" in createTeam', async () => {
      const handler = handlers.get(TEAM_CREATE)!;
      const result = (await handler({ sender: { send: vi.fn() } } as never, {
        teamName: 'solo-team',
        members: [{ name: 'team-lead' }],
        cwd: os.tmpdir(),
      })) as { success: boolean; error: string };
      expect(result.success).toBe(false);
      expect(result.error.toLowerCase()).toContain('reserved');
    });

    it('rejects addMember name "user"', async () => {
      const handler = handlers.get(TEAM_ADD_MEMBER)!;
      const result = (await handler({} as never, 'my-team', {
        name: 'user',
      })) as { success: boolean; error: string };
      expect(result.success).toBe(false);
      expect(result.error.toLowerCase()).toContain('reserved');
    });

    it('rejects addMember name "team-lead"', async () => {
      const handler = handlers.get(TEAM_ADD_MEMBER)!;
      const result = (await handler({} as never, 'my-team', {
        name: 'team-lead',
      })) as { success: boolean; error: string };
      expect(result.success).toBe(false);
      expect(result.error.toLowerCase()).toContain('reserved');
    });
  });
});
