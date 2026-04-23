import * as os from 'os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BoardTaskActivityDetailResult,
  BoardTaskActivityEntry,
  BoardTaskLogStreamResponse,
  BoardTaskExactLogDetailResult,
  BoardTaskExactLogSummariesResponse,
  InboxMessage,
  MessagesPage,
  TeamViewSnapshot,
  TeamCreateRequest,
  TeamProvisioningProgress,
} from '@shared/types/team';

vi.mock('electron', () => ({
  app: { getLocale: vi.fn(() => 'en'), getPath: vi.fn(() => '/tmp'), isPackaged: false },
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
const { mockGetMembersMetaFile, mockWriteMembersMeta } = vi.hoisted(() => ({
  mockGetMembersMetaFile: vi.fn(),
  mockWriteMembersMeta: vi.fn(),
}));
const { mockTeamDataWorkerClient } = vi.hoisted(() => ({
  mockTeamDataWorkerClient: {
    isAvailable: vi.fn(),
    getTeamData: vi.fn(),
    getMessagesPage: vi.fn(),
    getMemberActivityMeta: vi.fn(),
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
    getMeta: mockGetMembersMetaFile,
    writeMembers: mockWriteMembersMeta,
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
  TEAM_GET_MEMBER_ACTIVITY_META,
  TEAM_GET_MESSAGES_PAGE,
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
import { ConfigManager } from '../../../src/main/services/infrastructure/ConfigManager';

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
    getTeamData: vi.fn(async (): Promise<TeamViewSnapshot & { messages?: InboxMessage[] }> => ({
      teamName: 'my-team',
      config: { name: 'My Team' },
      tasks: [],
      members: [],
      kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
      processes: [],
    })),
    getMessageFeed: vi.fn(async () => ({
      teamName: 'my-team',
      feedRevision: 'rev-1',
      messages: [] as InboxMessage[],
    })),
    getMessagesPage: vi.fn(async (..._args: unknown[]): Promise<MessagesPage> => ({
      messages: [] as InboxMessage[],
      nextCursor: null,
      hasMore: false,
      feedRevision: 'rev-1',
    })),
    getMemberActivityMeta: vi.fn(async () => ({
      teamName: 'my-team',
      computedAt: '2026-03-12T10:00:00.000Z',
      members: {},
      feedRevision: 'rev-1',
    })),
    getTaskChangePresence: vi.fn(async () => ({ 'task-1': 'has_changes' })),
    reconcileTeamArtifacts: vi.fn(async () => undefined),
    setTaskChangePresenceTracking: vi.fn(() => undefined),
    getTeamNotificationContext: vi.fn(async () => ({
      displayName: 'My Team',
      projectPath: '/tmp/project',
    })),
    deleteTeam: vi.fn(async () => undefined),
    getLeadMemberName: vi.fn(async () => 'team-lead'),
    getTeamDisplayName: vi.fn(async () => 'My Team'),
    updateConfig: vi.fn(async () => ({ name: 'My Team' })),
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
    getCurrentRunId: vi.fn(() => 'run-2' as string | null),
    pushLiveLeadProcessMessage: vi.fn(),
    relayLeadInboxMessages: vi.fn(async () => 0),
    relayMemberInboxMessages: vi.fn(async () => 0),
    getLiveLeadProcessMessages: vi.fn(() => [] as InboxMessage[]),
    getCurrentLeadSessionId: vi.fn(() => null as string | null),
    getAliveTeams: vi.fn(() => ['my-team']),
    getLeadActivityState: vi.fn(() => 'idle'),
    stopTeam: vi.fn(() => undefined),
    reattachOpenCodeOwnedMemberLane: vi.fn(async () => undefined),
    detachOpenCodeOwnedMemberLane: vi.fn(async () => undefined),
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
    mockGetMembersMetaFile.mockReset();
    mockGetMembersMetaFile.mockResolvedValue({
      version: 1,
      providerBackendId: undefined,
      members: [],
    });
    mockWriteMembersMeta.mockReset();
    mockWriteMembersMeta.mockResolvedValue(undefined);
    mockTeamDataWorkerClient.isAvailable.mockReturnValue(false);
    mockTeamDataWorkerClient.getTeamData.mockReset();
    mockTeamDataWorkerClient.getMessagesPage.mockReset();
    mockTeamDataWorkerClient.getMemberActivityMeta.mockReset();
    mockTeamDataWorkerClient.findLogsForTask.mockReset();
    initializeTeamHandlers(
      service as never,
      provisioningService as never,
      undefined,
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

  afterEach(() => {
    vi.useRealTimers();
  });

  it('registers all expected handlers', () => {
    expect(handlers.has(TEAM_LIST)).toBe(true);
    expect(handlers.has(TEAM_GET_DATA)).toBe(true);
    expect(handlers.has(TEAM_GET_MESSAGES_PAGE)).toBe(true);
    expect(handlers.has(TEAM_GET_MEMBER_ACTIVITY_META)).toBe(true);
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

  it('keeps TEAM_GET_DATA structural and does not expose message transport', async () => {
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
      data: Record<string, unknown>;
    };
    expect(result.success).toBe(true);
    expect(result.data.teamName).toBe('my-team');
    expect(result.data).not.toHaveProperty('messages');
    expect(service.getMessageFeed).not.toHaveBeenCalled();
  });

  it('falls back TEAM_GET_DATA to the main thread in packaged runtime when worker is unavailable', async () => {
    const electron = await import('electron');
    mockTeamDataWorkerClient.isAvailable.mockReturnValue(false);
    (electron.app as { isPackaged: boolean }).isPackaged = true;

    const handler = handlers.get(TEAM_GET_DATA)!;
    const result = (await handler({} as never, 'my-team')) as {
      success: boolean;
      data?: { teamName: string };
    };

    expect(result.success).toBe(true);
    expect(result.data?.teamName).toBe('my-team');
    expect(service.getTeamData).toHaveBeenCalledWith('my-team');
    vi.mocked(console.error).mockClear();

    (electron.app as { isPackaged: boolean }).isPackaged = false;
  });

  it('does not let a live duplicate of the same session rate-limit reply delay auto-resume', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-17T12:00:30.000Z'));
    const configManager = ConfigManager.getInstance();
    const actualConfig = configManager.getConfig();
    const getConfigSpy = vi.spyOn(configManager, 'getConfig').mockImplementation(
      () =>
        ({
          ...actualConfig,
          notifications: {
            ...actualConfig.notifications,
            autoResumeOnRateLimit: true,
          },
        }) as never
    );

    try {
      provisioningService.isTeamAlive.mockReturnValue(true);
      provisioningService.getCurrentLeadSessionId.mockReturnValue('sess-123');
      provisioningService.sendMessageToTeam.mockResolvedValue(undefined);
      service.getTeamData.mockResolvedValueOnce({
        teamName: 'my-team',
        config: { name: 'My Team' },
        tasks: [],
        members: [],
        messages: [
          {
            from: 'team-lead',
            text: "You've hit your limit. Resets in 5 minutes.",
            timestamp: '2026-04-17T12:00:00.000Z',
            read: true,
            source: 'lead_session' as const,
            messageId: 'persisted-rate-limit-1',
            leadSessionId: 'sess-123',
          },
        ],
        kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
        processes: [],
      });
      provisioningService.getLiveLeadProcessMessages.mockReturnValueOnce([
        {
          from: 'team-lead',
          text: "You've hit your limit. Resets in 5 minutes.",
          timestamp: '2026-04-17T12:00:02.000Z',
          read: true,
          source: 'lead_process' as const,
          messageId: 'live-rate-limit-1',
          leadSessionId: 'sess-123',
        },
      ]);

      const getDataHandler = handlers.get(TEAM_GET_DATA)!;
      const result = (await getDataHandler({} as never, 'my-team')) as {
        success: boolean;
        data: { messages?: InboxMessage[] };
      };

      expect(result.success).toBe(true);
      expect(result.data.messages).toEqual([
        expect.objectContaining({
          source: 'lead_session',
          messageId: 'persisted-rate-limit-1',
        }),
      ]);

      await vi.advanceTimersByTimeAsync(4 * 60 * 1000 + 59 * 1000);
      expect(provisioningService.sendMessageToTeam).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1100);
      expect(provisioningService.sendMessageToTeam).toHaveBeenCalledTimes(1);
    } finally {
      getConfigSpy.mockRestore();
    }
  });

  it('uses the team-data worker for TEAM_GET_MESSAGES_PAGE when available', async () => {
    mockTeamDataWorkerClient.isAvailable.mockReturnValue(true);
    mockTeamDataWorkerClient.getMessagesPage.mockResolvedValueOnce({
      messages: [
        {
          from: 'team-lead',
          text: 'Hello there',
          timestamp: '2026-02-23T10:00:01.000Z',
          read: true,
          source: 'lead_session' as const,
          messageId: 'msg-1',
        },
      ],
      nextCursor: null,
      hasMore: false,
      feedRevision: 'rev-worker',
    });

    const handler = handlers.get(TEAM_GET_MESSAGES_PAGE)!;
    const result = (await handler({} as never, 'my-team', {
      limit: 50,
    })) as { success: boolean; data: { feedRevision: string } };

    expect(result.success).toBe(true);
    expect(result.data.feedRevision).toBe('rev-worker');
    expect(mockTeamDataWorkerClient.getMessagesPage).toHaveBeenCalledWith('my-team', {
      cursor: undefined,
      limit: 50,
    });
    expect(service.getMessagesPage).not.toHaveBeenCalled();
  });

  it('scans rate-limit notifications from message-page results without hydrating TEAM_GET_DATA feed', async () => {
    mockTeamDataWorkerClient.isAvailable.mockReturnValue(true);
    mockTeamDataWorkerClient.getMessagesPage.mockResolvedValueOnce({
      messages: [
        {
          from: 'team-lead',
          text: "You've hit your limit. Please wait a bit before retrying.",
          timestamp: '2026-02-23T10:00:01.000Z',
          read: true,
          source: 'lead_session' as const,
          messageId: 'msg-rate-limit-1',
        },
      ],
      nextCursor: null,
      hasMore: false,
      feedRevision: 'rev-worker',
    });

    const handler = handlers.get(TEAM_GET_MESSAGES_PAGE)!;
    const result = (await handler({} as never, 'my-team', {
      limit: 50,
    })) as { success: boolean; data: { feedRevision: string } };

    expect(result.success).toBe(true);
    expect(result.data.feedRevision).toBe('rev-worker');
    expect(mockAddTeamNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        teamEventType: 'rate_limit',
        teamName: 'my-team',
        teamDisplayName: 'My Team',
        from: 'team-lead',
        dedupeKey: 'rate-limit:my-team:msg-rate-limit-1',
      })
    );
    expect(service.getMessageFeed).not.toHaveBeenCalled();
  });

  it('falls back TEAM_GET_MESSAGES_PAGE to the main thread in packaged runtime when worker is unavailable', async () => {
    const electron = await import('electron');
    mockTeamDataWorkerClient.isAvailable.mockReturnValue(false);
    (electron.app as { isPackaged: boolean }).isPackaged = true;

    const handler = handlers.get(TEAM_GET_MESSAGES_PAGE)!;
    const result = (await handler({} as never, 'my-team', {
      limit: 50,
    })) as { success: boolean; data?: { feedRevision: string } };

    expect(result.success).toBe(true);
    expect(result.data?.feedRevision).toBe('rev-1');
    expect(service.getMessagesPage).toHaveBeenCalledWith('my-team', {
      cursor: undefined,
      limit: 50,
    });
    vi.mocked(console.error).mockClear();

    (electron.app as { isPackaged: boolean }).isPackaged = false;
  });

  it('uses the team-data worker for TEAM_GET_MEMBER_ACTIVITY_META when available', async () => {
    mockTeamDataWorkerClient.isAvailable.mockReturnValue(true);
    mockTeamDataWorkerClient.getMemberActivityMeta.mockResolvedValueOnce({
      teamName: 'my-team',
      computedAt: '2026-03-12T10:00:00.000Z',
      members: {
        alice: {
          memberName: 'alice',
          lastAuthoredMessageAt: '2026-03-12T10:00:00.000Z',
          messageCountExact: 4,
          latestAuthoredMessageSignalsTermination: false,
        },
      },
      feedRevision: 'rev-worker',
    });

    const handler = handlers.get(TEAM_GET_MEMBER_ACTIVITY_META)!;
    const result = (await handler({} as never, 'my-team')) as {
      success: boolean;
      data: { feedRevision: string };
    };

    expect(result.success).toBe(true);
    expect(result.data.feedRevision).toBe('rev-worker');
    expect(mockTeamDataWorkerClient.getMemberActivityMeta).toHaveBeenCalledWith('my-team');
    expect(service.getMemberActivityMeta).not.toHaveBeenCalled();
  });

  it('falls back TEAM_GET_MEMBER_ACTIVITY_META to the main thread in packaged runtime when worker is unavailable', async () => {
    const electron = await import('electron');
    mockTeamDataWorkerClient.isAvailable.mockReturnValue(false);
    (electron.app as { isPackaged: boolean }).isPackaged = true;

    const handler = handlers.get(TEAM_GET_MEMBER_ACTIVITY_META)!;
    const result = (await handler({} as never, 'my-team')) as {
      success: boolean;
      data?: { feedRevision: string };
    };

    expect(result.success).toBe(true);
    expect(result.data?.feedRevision).toBe('rev-1');
    expect(service.getMemberActivityMeta).toHaveBeenCalledWith('my-team');
    vi.mocked(console.error).mockClear();

    (electron.app as { isPackaged: boolean }).isPackaged = false;
  });

  it('rebuilds only the remaining auto-resume delay from persisted rate-limit history', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-17T12:02:00.000Z'));
    const configManager = ConfigManager.getInstance();
    const actualConfig = configManager.getConfig();
    const getConfigSpy = vi.spyOn(configManager, 'getConfig').mockImplementation(
      () =>
        ({
          ...actualConfig,
          notifications: {
            ...actualConfig.notifications,
            autoResumeOnRateLimit: true,
          },
        }) as never
    );

    try {
      provisioningService.isTeamAlive.mockReturnValue(true);
      provisioningService.getCurrentLeadSessionId.mockReturnValue('sess-live');
      provisioningService.sendMessageToTeam.mockResolvedValue(undefined);
      service.getTeamData.mockResolvedValueOnce({
        teamName: 'my-team',
        config: { name: 'My Team' },
        tasks: [],
        members: [],
        messages: [
          {
            from: 'team-lead',
            text: "You've hit your limit. Resets in 5 minutes.",
            timestamp: '2026-04-17T12:00:00.000Z',
            read: true,
            source: 'lead_session' as const,
            leadSessionId: 'sess-live',
            messageId: 'rate-limit-1',
          },
        ],
        kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
        processes: [],
      });

      const getDataHandler = handlers.get(TEAM_GET_DATA)!;
      const result = (await getDataHandler({} as never, 'my-team')) as {
        success: boolean;
        data: { messages: { source?: string; text: string }[] };
      };

      expect(result.success).toBe(true);

      await vi.advanceTimersByTimeAsync(3 * 60 * 1000 + 29 * 1000);
      expect(provisioningService.sendMessageToTeam).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1100);
      expect(provisioningService.sendMessageToTeam).toHaveBeenCalledTimes(1);
    } finally {
      getConfigSpy.mockRestore();
    }
  });

  it('can schedule auto-resume when the setting is enabled after an earlier history scan', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-17T12:02:00.000Z'));
    const configManager = ConfigManager.getInstance();
    const actualConfig = configManager.getConfig();
    let autoResumeEnabled = false;
    const getConfigSpy = vi.spyOn(configManager, 'getConfig').mockImplementation(
      () =>
        ({
          ...actualConfig,
          notifications: {
            ...actualConfig.notifications,
            autoResumeOnRateLimit: autoResumeEnabled,
          },
        }) as never
    );

    try {
      provisioningService.isTeamAlive.mockReturnValue(true);
      provisioningService.getCurrentLeadSessionId.mockReturnValue('sess-live');
      provisioningService.sendMessageToTeam.mockResolvedValue(undefined);
      service.getTeamData.mockResolvedValue({
        teamName: 'my-team',
        config: { name: 'My Team' },
        tasks: [],
        members: [],
        messages: [
          {
            from: 'team-lead',
            text: "You've hit your limit. Resets in 5 minutes.",
            timestamp: '2026-04-17T12:00:00.000Z',
            read: true,
            source: 'lead_session' as const,
            leadSessionId: 'sess-live',
            messageId: 'rate-limit-enable-later',
          },
        ],
        kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
        processes: [],
      });

      const getDataHandler = handlers.get(TEAM_GET_DATA)!;

      const firstResult = (await getDataHandler({} as never, 'my-team')) as {
        success: boolean;
      };
      expect(firstResult.success).toBe(true);
      expect(provisioningService.sendMessageToTeam).not.toHaveBeenCalled();

      autoResumeEnabled = true;

      const secondResult = (await getDataHandler({} as never, 'my-team')) as {
        success: boolean;
      };
      expect(secondResult.success).toBe(true);

      await vi.advanceTimersByTimeAsync(3 * 60 * 1000 + 29 * 1000);
      expect(provisioningService.sendMessageToTeam).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1100);
      expect(provisioningService.sendMessageToTeam).toHaveBeenCalledTimes(1);
    } finally {
      getConfigSpy.mockRestore();
    }
  });

  it('retries a previously over-ceiling history message once it becomes schedulable', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-17T00:00:00.000Z'));
    const configManager = ConfigManager.getInstance();
    const actualConfig = configManager.getConfig();
    const getConfigSpy = vi.spyOn(configManager, 'getConfig').mockImplementation(
      () =>
        ({
          ...actualConfig,
          notifications: {
            ...actualConfig.notifications,
            autoResumeOnRateLimit: true,
          },
        }) as never
    );

    try {
      provisioningService.isTeamAlive.mockReturnValue(true);
      provisioningService.getCurrentLeadSessionId.mockReturnValue('sess-live');
      provisioningService.sendMessageToTeam.mockResolvedValue(undefined);
      service.getTeamData.mockResolvedValue({
        teamName: 'my-team',
        config: { name: 'My Team' },
        tasks: [],
        members: [],
        messages: [
          {
            from: 'team-lead',
            text: "You've hit your limit. Resets at 12:20 UTC.",
            timestamp: '2026-04-17T00:00:00.000Z',
            read: true,
            source: 'lead_session' as const,
            leadSessionId: 'sess-live',
            messageId: 'rate-limit-over-ceiling',
          },
        ],
        kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
        processes: [],
      });

      const getDataHandler = handlers.get(TEAM_GET_DATA)!;

      const firstResult = (await getDataHandler({} as never, 'my-team')) as {
        success: boolean;
      };
      expect(firstResult.success).toBe(true);
      expect(provisioningService.sendMessageToTeam).not.toHaveBeenCalled();

      vi.setSystemTime(new Date('2026-04-17T12:20:00.000Z'));

      const secondResult = (await getDataHandler({} as never, 'my-team')) as {
        success: boolean;
      };
      expect(secondResult.success).toBe(true);

      await vi.advanceTimersByTimeAsync(29 * 1000);
      expect(provisioningService.sendMessageToTeam).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1500);
      expect(provisioningService.sendMessageToTeam).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
      getConfigSpy.mockRestore();
    }
  });

  it('does not rebuild auto-resume from persisted history while the team is offline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-17T12:02:00.000Z'));
    const configManager = ConfigManager.getInstance();
    const actualConfig = configManager.getConfig();
    const getConfigSpy = vi.spyOn(configManager, 'getConfig').mockImplementation(
      () =>
        ({
          ...actualConfig,
          notifications: {
            ...actualConfig.notifications,
            autoResumeOnRateLimit: true,
          },
        }) as never
    );

    try {
      provisioningService.isTeamAlive.mockReturnValue(false);
      provisioningService.sendMessageToTeam.mockResolvedValue(undefined);
      service.getTeamData.mockResolvedValue({
        teamName: 'my-team',
        config: { name: 'My Team' },
        tasks: [],
        members: [],
        messages: [
          {
            from: 'team-lead',
            text: "You've hit your limit. Resets in 5 minutes.",
            timestamp: '2026-04-17T12:00:00.000Z',
            read: true,
            source: 'lead_session' as const,
            messageId: 'rate-limit-offline-history',
          },
        ],
        kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
        processes: [],
      });

      const getDataHandler = handlers.get(TEAM_GET_DATA)!;
      const result = (await getDataHandler({} as never, 'my-team')) as {
        success: boolean;
      };
      expect(result.success).toBe(true);

      // Simulate the user manually starting a fresh run later; stale persisted history
      // should not have armed an auto-resume timer while the team was offline.
      provisioningService.isTeamAlive.mockReturnValue(true);

      await vi.advanceTimersByTimeAsync(3 * 60 * 1000 + 31 * 1000);
      expect(provisioningService.sendMessageToTeam).not.toHaveBeenCalled();
    } finally {
      getConfigSpy.mockRestore();
    }
  });

  it('does not rebuild auto-resume from an older lead session after the team was manually restarted', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-17T12:02:00.000Z'));
    const configManager = ConfigManager.getInstance();
    const actualConfig = configManager.getConfig();
    const getConfigSpy = vi.spyOn(configManager, 'getConfig').mockImplementation(
      () =>
        ({
          ...actualConfig,
          notifications: {
            ...actualConfig.notifications,
            autoResumeOnRateLimit: true,
          },
        }) as never
    );

    try {
      provisioningService.isTeamAlive.mockReturnValue(true);
      provisioningService.getCurrentLeadSessionId.mockReturnValue('sess-new');
      provisioningService.sendMessageToTeam.mockResolvedValue(undefined);
      service.getTeamData.mockResolvedValue({
        teamName: 'my-team',
        config: { name: 'My Team' },
        tasks: [],
        members: [],
        messages: [
          {
            from: 'team-lead',
            text: "You've hit your limit. Resets in 5 minutes.",
            timestamp: '2026-04-17T12:00:00.000Z',
            read: true,
            source: 'lead_session' as const,
            leadSessionId: 'sess-old',
            messageId: 'rate-limit-old-session',
          },
        ],
        kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
        processes: [],
      });

      const getDataHandler = handlers.get(TEAM_GET_DATA)!;
      const result = (await getDataHandler({} as never, 'my-team')) as {
        success: boolean;
      };
      expect(result.success).toBe(true);

      await vi.advanceTimersByTimeAsync(3 * 60 * 1000 + 31 * 1000);
      expect(provisioningService.sendMessageToTeam).not.toHaveBeenCalled();
    } finally {
      getConfigSpy.mockRestore();
    }
  });

  it('does not arm lead auto-resume from a teammate inbox rate-limit message', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-17T12:02:00.000Z'));
    const configManager = ConfigManager.getInstance();
    const actualConfig = configManager.getConfig();
    const getConfigSpy = vi.spyOn(configManager, 'getConfig').mockImplementation(
      () =>
        ({
          ...actualConfig,
          notifications: {
            ...actualConfig.notifications,
            autoResumeOnRateLimit: true,
          },
        }) as never
    );

    try {
      provisioningService.isTeamAlive.mockReturnValue(true);
      provisioningService.getCurrentLeadSessionId.mockReturnValue('sess-live');
      provisioningService.sendMessageToTeam.mockResolvedValue(undefined);
      service.getTeamData.mockResolvedValue({
        teamName: 'my-team',
        config: { name: 'My Team' },
        tasks: [],
        members: [],
        messages: [
          {
            from: 'alice',
            to: 'team-lead',
            text: "You've hit your limit. Resets in 5 minutes.",
            timestamp: '2026-04-17T12:00:00.000Z',
            read: false,
            messageId: 'member-rate-limit-1',
          },
        ],
        kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
        processes: [],
      });

      const getDataHandler = handlers.get(TEAM_GET_DATA)!;
      const result = (await getDataHandler({} as never, 'my-team')) as {
        success: boolean;
      };
      expect(result.success).toBe(true);

      await vi.advanceTimersByTimeAsync(3 * 60 * 1000 + 31 * 1000);
      expect(provisioningService.sendMessageToTeam).not.toHaveBeenCalled();
    } finally {
      getConfigSpy.mockRestore();
    }
  });

  it('rebuilds capped newest messages through getMessagesPage so live duplicates do not leak back in', async () => {
    service.getTeamData.mockResolvedValueOnce({
      teamName: 'my-team',
      config: { name: 'My Team' },
      tasks: [],
      members: [],
      messages: Array.from({ length: 50 }, (_, index) => ({
        from: 'alice',
        text: `filler-${index}`,
        timestamp: `2026-02-23T10:${String(index).padStart(2, '0')}:00.000Z`,
        read: true,
        source: 'inbox' as const,
        messageId: `durable-${index}`,
      })),
      kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
      processes: [],
    });
    service.getMessagesPage.mockResolvedValueOnce({
      messages: [
        {
          from: 'alice',
          text: 'filler-0',
          timestamp: '2026-02-23T10:00:00.000Z',
          read: true,
          source: 'inbox' as const,
          messageId: 'durable-0',
        },
      ],
      nextCursor: null,
      hasMore: false,
      feedRevision: 'rev-1',
    });
    provisioningService.getLiveLeadProcessMessages.mockReturnValueOnce([
      {
        from: 'team-lead',
        text: 'Already persisted thought',
        timestamp: '2026-02-23T11:00:00.000Z',
        read: true,
        source: 'lead_process' as const,
        messageId: 'live-dup',
        leadSessionId: 'lead-1',
      },
    ]);

    const getDataHandler = handlers.get(TEAM_GET_DATA)!;
    const result = (await getDataHandler({} as never, 'my-team')) as {
      success: boolean;
      data: { messages?: InboxMessage[] };
    };

    expect(result.success).toBe(true);
    expect(service.getMessagesPage).toHaveBeenCalledWith('my-team', {
      limit: 50,
      liveMessages: expect.arrayContaining([
        expect.objectContaining({
          messageId: 'live-dup',
          source: 'lead_process',
        }),
      ]),
    });
    expect(result.data.messages).toHaveLength(50);
  });

  it('overlays live lead_process messages onto the newest messages page', async () => {
    service.getMessagesPage.mockImplementationOnce(async (...args: unknown[]) => {
      const { liveMessages = [] } = (args[1] ?? {}) as { liveMessages?: InboxMessage[] };
      return {
        messages: [
          {
            from: 'user',
            text: 'Ping',
            timestamp: '2026-02-23T10:00:00.000Z',
            read: true,
            source: 'user_sent' as const,
            messageId: 'durable-1',
          },
          ...liveMessages,
        ].sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp)),
        nextCursor: '2026-02-23T10:00:00.000Z|durable-1',
        hasMore: true,
        feedRevision: 'rev-1',
      } satisfies MessagesPage;
    });
    provisioningService.getLiveLeadProcessMessages.mockReturnValueOnce([
      {
        from: 'team-lead',
        text: 'Команда поднята, приступаю к раздаче задач.',
        timestamp: '2026-02-23T10:00:01.000Z',
        read: true,
        source: 'lead_process' as const,
        messageId: 'live-1',
      },
    ]);

    const result = (await handlers.get(TEAM_GET_MESSAGES_PAGE)!({} as never, 'my-team', {
      limit: 20,
    })) as {
      success: boolean;
      data: { messages: InboxMessage[]; nextCursor: string | null; hasMore: boolean };
    };

    expect(result.success).toBe(true);
    expect(result.data.messages).toHaveLength(2);
    expect(result.data.messages[0]?.source).toBe('lead_process');
    expect(result.data.messages[0]?.text).toBe('Команда поднята, приступаю к раздаче задач.');
    expect(result.data.nextCursor).toBe('2026-02-23T10:00:00.000Z|durable-1');
    expect(result.data.hasMore).toBe(true);
    expect(service.getMessagesPage).toHaveBeenCalledWith('my-team', {
      limit: 20,
      cursor: undefined,
      liveMessages: expect.arrayContaining([
        expect.objectContaining({
          source: 'lead_process',
          messageId: 'live-1',
        }),
      ]),
    });
  });

  it('dedups live lead thoughts on the newest messages page when durable lead_session already exists', async () => {
    service.getMessagesPage.mockImplementationOnce(async (...args: unknown[]) => {
      const { liveMessages = [] } = (args[1] ?? {}) as { liveMessages?: InboxMessage[] };
      expect(liveMessages).toHaveLength(1);
      return {
        messages: [
          {
            from: 'team-lead',
            text: 'Hello there',
            timestamp: '2026-02-23T10:00:00.000Z',
            read: true,
            source: 'lead_session' as const,
            leadSessionId: 'lead-1',
            messageId: 'durable-1',
          },
        ],
        nextCursor: null,
        hasMore: false,
        feedRevision: 'rev-1',
      } satisfies MessagesPage;
    });
    provisioningService.getLiveLeadProcessMessages.mockReturnValueOnce([
      {
        from: 'team-lead',
        text: 'Hello there',
        timestamp: '2026-02-23T10:00:01.000Z',
        read: true,
        source: 'lead_process' as const,
        leadSessionId: 'lead-1',
        messageId: 'live-1',
      },
    ]);

    const result = (await handlers.get(TEAM_GET_MESSAGES_PAGE)!({} as never, 'my-team', {
      limit: 20,
    })) as {
      success: boolean;
      data: { messages: InboxMessage[] };
    };

    expect(result.success).toBe(true);
    expect(result.data.messages).toHaveLength(1);
    expect(result.data.messages[0]?.source).toBe('lead_session');
  });

  it('does not overlay live lead_process messages onto older paginated pages', async () => {
    service.getMessagesPage.mockResolvedValueOnce({
      messages: [
        {
          from: 'user',
          text: 'Older durable message',
          timestamp: '2026-02-23T09:59:00.000Z',
          read: true,
          source: 'user_sent' as const,
          messageId: 'durable-older-1',
        },
      ],
      nextCursor: null,
      hasMore: false,
      feedRevision: 'rev-1',
    });

    const result = (await handlers.get(TEAM_GET_MESSAGES_PAGE)!({} as never, 'my-team', {
      limit: 20,
      cursor: '2026-02-23T10:00:00.000Z|cursor',
    })) as {
      success: boolean;
      data: { messages: InboxMessage[] };
    };

    expect(result.success).toBe(true);
    expect(provisioningService.getLiveLeadProcessMessages).not.toHaveBeenCalled();
    expect(result.data.messages).toHaveLength(1);
    expect(result.data.messages[0]?.messageId).toBe('durable-older-1');
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

    it('blocks live addMember for a running OpenCode-led team before metadata is written', async () => {
      const handler = handlers.get(TEAM_ADD_MEMBER)!;
      service.getTeamData.mockResolvedValueOnce({
        teamName: 'my-team',
        config: { name: 'My Team' },
        tasks: [],
        members: [
          {
            name: 'team-lead',
            providerId: 'opencode',
            role: 'Team Lead',
            currentTaskId: null,
            taskCount: 0,
          },
        ],
        kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
        processes: [],
      });

      const result = (await handler({} as never, 'my-team', {
        name: 'alice',
        role: 'developer',
        providerId: 'opencode',
      })) as { success: boolean; error?: string };

      expect(result.success).toBe(false);
      expect(result.error).toContain('running OpenCode-led team');
      expect(service.addMember).not.toHaveBeenCalled();
      expect(provisioningService.reattachOpenCodeOwnedMemberLane).not.toHaveBeenCalled();
      vi.mocked(console.error).mockClear();
    });

    it('rolls back live OpenCode addMember metadata when controlled reattach fails', async () => {
      const handler = handlers.get(TEAM_ADD_MEMBER)!;
      mockGetMembersMetaFile.mockResolvedValueOnce({
        version: 1,
        providerBackendId: 'codex-native',
        members: [
          {
            name: 'team-lead',
            providerId: 'codex',
            providerBackendId: 'codex-native',
            role: 'Team Lead',
            agentType: 'team-lead',
          },
          {
            name: 'bob',
            providerId: 'codex',
            providerBackendId: 'codex-native',
            role: 'Developer',
            agentType: 'general-purpose',
            agentId: 'agent-bob',
          },
        ],
      });
      service.getTeamData.mockResolvedValueOnce({
        teamName: 'my-team',
        config: { name: 'My Team' },
        tasks: [],
        members: [
          {
            name: 'team-lead',
            providerId: 'codex',
            role: 'Team Lead',
            currentTaskId: null,
            taskCount: 0,
          },
          {
            name: 'bob',
            providerId: 'codex',
            role: 'Developer',
            currentTaskId: null,
            taskCount: 0,
          },
        ],
        kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
        processes: [],
      });
      provisioningService.reattachOpenCodeOwnedMemberLane.mockRejectedValueOnce(
        new Error('reattach failed')
      );

      const result = (await handler({} as never, 'my-team', {
        name: 'alice',
        role: 'developer',
        providerId: 'opencode',
        model: 'minimax-m2.5-free',
      })) as { success: boolean; error?: string };

      expect(result.success).toBe(false);
      expect(result.error).toContain('reattach failed');
      expect(service.addMember).toHaveBeenCalledWith('my-team', {
        name: 'alice',
        role: 'developer',
        workflow: undefined,
        isolation: undefined,
        providerId: 'opencode',
        model: 'minimax-m2.5-free',
        effort: undefined,
      });
      expect(service.replaceMembers).not.toHaveBeenCalled();
      expect(mockWriteMembersMeta).toHaveBeenCalledWith(
        'my-team',
        [
          {
            name: 'team-lead',
            providerId: 'codex',
            providerBackendId: 'codex-native',
            role: 'Team Lead',
            agentType: 'team-lead',
          },
          {
            name: 'bob',
            providerId: 'codex',
            providerBackendId: 'codex-native',
            role: 'Developer',
            agentType: 'general-purpose',
            agentId: 'agent-bob',
          },
        ],
        { providerBackendId: 'codex-native' }
      );
      expect(provisioningService.detachOpenCodeOwnedMemberLane).toHaveBeenCalledWith(
        'my-team',
        'alice'
      );
      vi.mocked(console.error).mockClear();
    });
  });

  describe('updateConfig', () => {
    it('notifies a live lead only when the team name actually changes', async () => {
      const handler = handlers.get(TEAM_UPDATE_CONFIG)!;
      service.getTeamDisplayName.mockResolvedValueOnce('My Team');
      provisioningService.isTeamAlive = vi.fn(() => true);

      const result = (await handler({} as never, 'my-team', {
        name: 'Renamed Team',
      })) as { success: boolean };

      expect(result.success).toBe(true);
      expect(service.updateConfig).toHaveBeenCalledWith('my-team', {
        name: 'Renamed Team',
        description: undefined,
        color: undefined,
      });
      expect(provisioningService.sendMessageToTeam).toHaveBeenCalledWith(
        'my-team',
        'The team has been renamed to "Renamed Team". Please use this name when referring to the team going forward.'
      );
    });

    it('does not notify the lead when the submitted team name is unchanged', async () => {
      const handler = handlers.get(TEAM_UPDATE_CONFIG)!;
      service.getTeamDisplayName.mockResolvedValueOnce('My Team');
      provisioningService.isTeamAlive = vi.fn(() => true);

      const result = (await handler({} as never, 'my-team', {
        name: 'My Team',
      })) as { success: boolean };

      expect(result.success).toBe(true);
      expect(service.updateConfig).toHaveBeenCalledWith('my-team', {
        name: 'My Team',
        description: undefined,
        color: undefined,
      });
      expect(provisioningService.sendMessageToTeam).not.toHaveBeenCalled();
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

    it('blocks live removeMember for a running OpenCode-led team before metadata is changed', async () => {
      const handler = handlers.get(TEAM_REMOVE_MEMBER)!;
      service.getTeamData.mockResolvedValueOnce({
        teamName: 'my-team',
        config: { name: 'My Team' },
        tasks: [],
        members: [
          {
            name: 'team-lead',
            providerId: 'opencode',
            role: 'Team Lead',
            currentTaskId: null,
            taskCount: 0,
          },
          {
            name: 'alice',
            providerId: 'opencode',
            role: 'Developer',
            currentTaskId: null,
            taskCount: 0,
          },
        ],
        kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
        processes: [],
      });

      const result = (await handler({} as never, 'my-team', 'alice')) as {
        success: boolean;
        error?: string;
      };

      expect(result.success).toBe(false);
      expect(result.error).toContain('running OpenCode-led team');
      expect(service.removeMember).not.toHaveBeenCalled();
      expect(provisioningService.detachOpenCodeOwnedMemberLane).not.toHaveBeenCalled();
      vi.mocked(console.error).mockClear();
    });

    it('rolls back live OpenCode removeMember metadata when lane detach fails', async () => {
      const handler = handlers.get(TEAM_REMOVE_MEMBER)!;
      mockGetMembersMetaFile.mockResolvedValueOnce({
        version: 1,
        providerBackendId: undefined,
        members: [
          {
            name: 'team-lead',
            providerId: 'codex',
            role: 'Team Lead',
            agentType: 'team-lead',
          },
          {
            name: 'alice',
            providerId: 'opencode',
            model: 'nemotron-3-super-free',
            role: 'Developer',
            agentType: 'general-purpose',
            agentId: 'agent-alice',
          },
        ],
      });
      service.getTeamData.mockResolvedValueOnce({
        teamName: 'my-team',
        config: { name: 'My Team' },
        tasks: [],
        members: [
          {
            name: 'team-lead',
            providerId: 'codex',
            role: 'Team Lead',
            currentTaskId: null,
            taskCount: 0,
          },
          {
            name: 'alice',
            providerId: 'opencode',
            model: 'nemotron-3-super-free',
            role: 'Developer',
            currentTaskId: null,
            taskCount: 0,
          },
        ],
        kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
        processes: [],
      });
      provisioningService.detachOpenCodeOwnedMemberLane.mockRejectedValueOnce(
        new Error('detach failed')
      );

      const result = (await handler({} as never, 'my-team', 'alice')) as {
        success: boolean;
        error?: string;
      };

      expect(result.success).toBe(false);
      expect(result.error).toContain('detach failed');
      expect(service.removeMember).toHaveBeenCalledWith('my-team', 'alice');
      expect(service.replaceMembers).not.toHaveBeenCalled();
      expect(mockWriteMembersMeta).toHaveBeenCalledWith(
        'my-team',
        [
          {
            name: 'team-lead',
            providerId: 'codex',
            role: 'Team Lead',
            agentType: 'team-lead',
          },
          {
            name: 'alice',
            providerId: 'opencode',
            model: 'nemotron-3-super-free',
            role: 'Developer',
            agentType: 'general-purpose',
            agentId: 'agent-alice',
          },
        ],
        { providerBackendId: undefined }
      );
      expect(provisioningService.reattachOpenCodeOwnedMemberLane).toHaveBeenCalledWith(
        'my-team',
        'alice',
        { reason: 'member_updated' }
      );
      vi.mocked(console.error).mockClear();
    });
  });

  describe('replaceMembers', () => {
    it('blocks live replaceMembers for a running OpenCode-led team before metadata is changed', async () => {
      const handler = handlers.get(TEAM_REPLACE_MEMBERS)!;
      service.getTeamData.mockResolvedValueOnce({
        teamName: 'my-team',
        config: { name: 'My Team' },
        tasks: [],
        members: [
          {
            name: 'team-lead',
            providerId: 'opencode',
            role: 'Team Lead',
            currentTaskId: null,
            taskCount: 0,
          },
          {
            name: 'alice',
            providerId: 'opencode',
            role: 'Developer',
            currentTaskId: null,
            taskCount: 0,
          },
        ],
        kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
        processes: [],
      });

      const result = (await handler({} as never, 'my-team', {
        members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
      })) as { success: boolean; error?: string };

      expect(result.success).toBe(false);
      expect(result.error).toContain('running OpenCode-led team');
      expect(service.replaceMembers).not.toHaveBeenCalled();
      expect(provisioningService.reattachOpenCodeOwnedMemberLane).not.toHaveBeenCalled();
      expect(provisioningService.detachOpenCodeOwnedMemberLane).not.toHaveBeenCalled();
      vi.mocked(console.error).mockClear();
    });

    it('rolls back live OpenCode replaceMembers metadata when lane reattach fails', async () => {
      const handler = handlers.get(TEAM_REPLACE_MEMBERS)!;
      mockGetMembersMetaFile.mockResolvedValueOnce({
        version: 1,
        providerBackendId: 'codex-native',
        members: [
          {
            name: 'team-lead',
            providerId: 'codex',
            providerBackendId: 'codex-native',
            role: 'Team Lead',
            agentType: 'team-lead',
          },
          {
            name: 'alice',
            providerId: 'opencode',
            model: 'nemotron-3-super-free',
            role: 'Developer',
            agentType: 'general-purpose',
            agentId: 'agent-alice',
          },
          {
            name: 'bob',
            providerId: 'codex',
            providerBackendId: 'codex-native',
            role: 'Developer',
            agentType: 'general-purpose',
            agentId: 'agent-bob',
          },
        ],
      });
      service.getTeamData.mockResolvedValueOnce({
        teamName: 'my-team',
        config: { name: 'My Team' },
        tasks: [],
        members: [
          {
            name: 'team-lead',
            providerId: 'codex',
            role: 'Team Lead',
            currentTaskId: null,
            taskCount: 0,
          },
          {
            name: 'alice',
            providerId: 'opencode',
            model: 'nemotron-3-super-free',
            role: 'Developer',
            currentTaskId: null,
            taskCount: 0,
          },
          {
            name: 'bob',
            providerId: 'codex',
            role: 'Developer',
            currentTaskId: null,
            taskCount: 0,
          },
        ],
        kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
        processes: [],
      });
      provisioningService.reattachOpenCodeOwnedMemberLane.mockRejectedValueOnce(
        new Error('reattach failed')
      );

      const result = (await handler({} as never, 'my-team', {
        members: [
          {
            name: 'alice',
            role: 'Developer',
            providerId: 'opencode',
            model: 'minimax-m2.5-free',
          },
          {
            name: 'bob',
            role: 'Developer',
            providerId: 'codex',
          },
        ],
      })) as { success: boolean; error?: string };

      expect(result.success).toBe(false);
      expect(result.error).toContain('reattach failed');
      expect(service.replaceMembers).toHaveBeenNthCalledWith(1, 'my-team', {
        members: [
          {
            name: 'alice',
            role: 'Developer',
            workflow: undefined,
            isolation: undefined,
            providerId: 'opencode',
            providerBackendId: undefined,
            model: 'minimax-m2.5-free',
            effort: undefined,
            fastMode: undefined,
          },
          {
            name: 'bob',
            role: 'Developer',
            workflow: undefined,
            isolation: undefined,
            providerId: 'codex',
            providerBackendId: undefined,
            model: undefined,
            effort: undefined,
            fastMode: undefined,
          },
        ],
      });
      expect(service.replaceMembers).toHaveBeenCalledTimes(1);
      expect(mockWriteMembersMeta).toHaveBeenCalledWith(
        'my-team',
        [
          {
            name: 'team-lead',
            providerId: 'codex',
            providerBackendId: 'codex-native',
            role: 'Team Lead',
            agentType: 'team-lead',
          },
          {
            name: 'alice',
            providerId: 'opencode',
            model: 'nemotron-3-super-free',
            role: 'Developer',
            agentType: 'general-purpose',
            agentId: 'agent-alice',
          },
          {
            name: 'bob',
            providerId: 'codex',
            providerBackendId: 'codex-native',
            role: 'Developer',
            agentType: 'general-purpose',
            agentId: 'agent-bob',
          },
        ],
        { providerBackendId: 'codex-native' }
      );
      expect(provisioningService.reattachOpenCodeOwnedMemberLane).toHaveBeenNthCalledWith(
        1,
        'my-team',
        'alice',
        { reason: 'member_updated' }
      );
      expect(provisioningService.reattachOpenCodeOwnedMemberLane).toHaveBeenNthCalledWith(
        2,
        'my-team',
        'alice',
        { reason: 'member_updated' }
      );
      vi.mocked(console.error).mockClear();
    });

    it('blocks live replaceMembers when a member migrates from primary runtime ownership to OpenCode', async () => {
      const handler = handlers.get(TEAM_REPLACE_MEMBERS)!;
      service.getTeamData.mockResolvedValueOnce({
        teamName: 'my-team',
        config: { name: 'My Team' },
        tasks: [],
        members: [
          {
            name: 'team-lead',
            providerId: 'codex',
            role: 'Team Lead',
            currentTaskId: null,
            taskCount: 0,
          },
          {
            name: 'alice',
            providerId: 'codex',
            role: 'Developer',
            currentTaskId: null,
            taskCount: 0,
          },
        ],
        kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
        processes: [],
      });

      const result = (await handler({} as never, 'my-team', {
        members: [
          {
            name: 'alice',
            role: 'Developer',
            providerId: 'opencode',
            model: 'minimax-m2.5-free',
          },
        ],
      })) as { success: boolean; error?: string };

      expect(result.success).toBe(false);
      expect(result.error).toContain('Live member migration between OpenCode and the primary runtime owner');
      expect(result.error).toContain('alice');
      expect(service.replaceMembers).not.toHaveBeenCalled();
      expect(provisioningService.reattachOpenCodeOwnedMemberLane).not.toHaveBeenCalled();
      expect(provisioningService.detachOpenCodeOwnedMemberLane).not.toHaveBeenCalled();
      vi.mocked(console.error).mockClear();
    });

    it('blocks live replaceMembers when a member migrates from OpenCode to primary runtime ownership', async () => {
      const handler = handlers.get(TEAM_REPLACE_MEMBERS)!;
      service.getTeamData.mockResolvedValueOnce({
        teamName: 'my-team',
        config: { name: 'My Team' },
        tasks: [],
        members: [
          {
            name: 'team-lead',
            providerId: 'codex',
            role: 'Team Lead',
            currentTaskId: null,
            taskCount: 0,
          },
          {
            name: 'alice',
            providerId: 'opencode',
            model: 'nemotron-3-super-free',
            role: 'Developer',
            currentTaskId: null,
            taskCount: 0,
          },
        ],
        kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
        processes: [],
      });

      const result = (await handler({} as never, 'my-team', {
        members: [
          {
            name: 'alice',
            role: 'Developer',
            providerId: 'codex',
          },
        ],
      })) as { success: boolean; error?: string };

      expect(result.success).toBe(false);
      expect(result.error).toContain('Live member migration between OpenCode and the primary runtime owner');
      expect(result.error).toContain('alice');
      expect(service.replaceMembers).not.toHaveBeenCalled();
      expect(provisioningService.reattachOpenCodeOwnedMemberLane).not.toHaveBeenCalled();
      expect(provisioningService.detachOpenCodeOwnedMemberLane).not.toHaveBeenCalled();
      vi.mocked(console.error).mockClear();
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
