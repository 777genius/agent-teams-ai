import * as os from 'os';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@preload/constants/ipcChannels', () => ({
  TEAM_LIST: 'team:list',
  TEAM_GET_DATA: 'team:getData',
  TEAM_DELETE_TEAM: 'team:deleteTeam',
  TEAM_PREPARE_PROVISIONING: 'team:prepareProvisioning',
  TEAM_CREATE: 'team:create',
  TEAM_LAUNCH: 'team:launch',
  TEAM_CREATE_CONFIG: 'team:createConfig',
  TEAM_CREATE_TASK: 'team:createTask',
  TEAM_PROVISIONING_STATUS: 'team:provisioningStatus',
  TEAM_CANCEL_PROVISIONING: 'team:cancelProvisioning',
  TEAM_PROVISIONING_PROGRESS: 'team:provisioningProgress',
  TEAM_SEND_MESSAGE: 'team:sendMessage',
  TEAM_REQUEST_REVIEW: 'team:requestReview',
  TEAM_UPDATE_KANBAN: 'team:updateKanban',
  TEAM_UPDATE_TASK_STATUS: 'team:updateTaskStatus',
  TEAM_PROCESS_SEND: 'team:processSend',
  TEAM_PROCESS_ALIVE: 'team:processAlive',
  TEAM_ALIVE_LIST: 'team:aliveList',
  TEAM_GET_MEMBER_LOGS: 'team:getMemberLogs',
  TEAM_GET_MEMBER_STATS: 'team:getMemberStats',
  TEAM_UPDATE_CONFIG: 'team:updateConfig',
  TEAM_START_TASK: 'team:startTask',
  TEAM_GET_ALL_TASKS: 'team:getAllTasks',
}));

import {
  TEAM_ALIVE_LIST,
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
  TEAM_GET_MEMBER_LOGS,
  TEAM_START_TASK,
  TEAM_UPDATE_CONFIG,
  TEAM_UPDATE_KANBAN,
  TEAM_UPDATE_TASK_STATUS,
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
    getTeamData: vi.fn(async () => ({ teamName: 'my-team' })),
    deleteTeam: vi.fn(async () => undefined),
    sendMessage: vi.fn(async () => ({ deliveredToInbox: true, messageId: 'm1' })),
    createTask: vi.fn(async () => ({ id: '1', subject: 'Test', status: 'pending' })),
    requestReview: vi.fn(async () => undefined),
    updateKanban: vi.fn(async () => undefined),
    updateTaskStatus: vi.fn(async () => undefined),
    startTask: vi.fn(async () => undefined),
  };
  const provisioningService = {
    prepareForProvisioning: vi.fn(async () => ({
      ready: true,
      message: 'CLI прогрет и готов к запуску',
    })),
    createTeam: vi.fn(async () => ({ runId: 'run-1' })),
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
    getAliveTeams: vi.fn(() => ['my-team']),
  };

  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
    initializeTeamHandlers(service as never, provisioningService as never);
    registerTeamHandlers(ipcMain as never);
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
    expect(handlers.has(TEAM_UPDATE_TASK_STATUS)).toBe(true);
    expect(handlers.has(TEAM_START_TASK)).toBe(true);
    expect(handlers.has(TEAM_PROCESS_SEND)).toBe(true);
    expect(handlers.has(TEAM_PROCESS_ALIVE)).toBe(true);
    expect(handlers.has(TEAM_ALIVE_LIST)).toBe(true);
    expect(handlers.has(TEAM_CREATE_CONFIG)).toBe(true);
    expect(handlers.has(TEAM_GET_MEMBER_LOGS)).toBe(true);
    expect(handlers.has(TEAM_UPDATE_CONFIG)).toBe(true);
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
    expect(handlers.has(TEAM_UPDATE_TASK_STATUS)).toBe(false);
    expect(handlers.has(TEAM_START_TASK)).toBe(false);
    expect(handlers.has(TEAM_PROCESS_SEND)).toBe(false);
    expect(handlers.has(TEAM_PROCESS_ALIVE)).toBe(false);
    expect(handlers.has(TEAM_ALIVE_LIST)).toBe(false);
    expect(handlers.has(TEAM_CREATE_CONFIG)).toBe(false);
  });
});
