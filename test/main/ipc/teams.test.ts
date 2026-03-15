import * as os from 'os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboxMessage, TeamCreateRequest, TeamProvisioningProgress } from '@shared/types/team';

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
vi.mock('@main/services/infrastructure/NotificationManager', () => ({
  NotificationManager: {
    getInstance: vi.fn().mockReturnValue({
      addTeamNotification: mockAddTeamNotification,
    }),
  },
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
  TEAM_GET_ALL_TASKS,
  TEAM_GET_LOGS_FOR_TASK,
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
import { MEMBER_BRIEFING_BOOTSTRAP_ENV } from '../../../src/main/services/team/TeamProvisioningService';

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
  let originalMemberBriefingBootstrapEnv: string | undefined;

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
    reconcileTeamArtifacts: vi.fn(async () => undefined),
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

  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
    originalMemberBriefingBootstrapEnv = process.env[MEMBER_BRIEFING_BOOTSTRAP_ENV];
    process.env[MEMBER_BRIEFING_BOOTSTRAP_ENV] = '1';
    initializeTeamHandlers(service as never, provisioningService as never);
    registerTeamHandlers(ipcMain as never);
  });

  afterEach(() => {
    if (originalMemberBriefingBootstrapEnv === undefined) {
      delete process.env[MEMBER_BRIEFING_BOOTSTRAP_ENV];
    } else {
      process.env[MEMBER_BRIEFING_BOOTSTRAP_ENV] = originalMemberBriefingBootstrapEnv;
    }
  });

  it('registers all expected handlers', () => {
    expect(handlers.has(TEAM_LIST)).toBe(true);
    expect(handlers.has(TEAM_GET_DATA)).toBe(true);
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
    expect(service.sendDirectToLead).toHaveBeenCalledWith(
      'my-team',
      'team-lead',
      'Can you review the approach?',
      undefined,
      undefined,
      undefined
    );
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

    it('falls back to the legacy add-member spawn instruction when bootstrap flag is disabled', async () => {
      process.env[MEMBER_BRIEFING_BOOTSTRAP_ENV] = '0';
      const handler = handlers.get(TEAM_ADD_MEMBER)!;
      const result = (await handler({} as never, 'my-team', {
        name: 'alice',
        role: 'developer',
      })) as { success: boolean };

      expect(result.success).toBe(true);
      expect(provisioningService.sendMessageToTeam).toHaveBeenCalledWith(
        'my-team',
        expect.stringContaining('Please spawn them immediately using the Task tool with team_name="my-team" and name="alice".')
      );
      expect(provisioningService.sendMessageToTeam).not.toHaveBeenCalledWith(
        'my-team',
        expect.stringContaining('Your FIRST action: call MCP tool member_briefing')
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
