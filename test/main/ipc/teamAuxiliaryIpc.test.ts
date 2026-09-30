import * as path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const auxiliaryMocks = vi.hoisted(() => {
  const logger = {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
  const worktreeGitReceiver = {
    getStatus: vi.fn(),
    initializeRepository: vi.fn(),
    createInitialCommit: vi.fn(),
  };
  const gitIdentityReceiver = {
    getBranch: vi.fn(),
  };
  const addTeamNotification = vi.fn();
  const notificationListeners: Array<Map<string, (...args: unknown[]) => void>> = [];
  const notificationInstances: Array<{
    on: ReturnType<typeof vi.fn>;
    show: ReturnType<typeof vi.fn>;
  }> = [];
  const Notification = Object.assign(
    vi.fn(function MockNotification() {
      const listeners = new Map<string, (...args: unknown[]) => void>();
      const instance = {
        on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
          listeners.set(event, listener);
          return instance;
        }),
        show: vi.fn(),
      };
      notificationListeners.push(listeners);
      notificationInstances.push(instance);
      return instance;
    }),
    { isSupported: vi.fn() }
  );
  const mainWindow = {
    focus: vi.fn(),
    isDestroyed: vi.fn(),
    show: vi.fn(),
  };
  const getAllWindows = vi.fn();
  const notificationsConfig = {
    enabled: true,
    snoozedUntil: null as number | null,
    soundEnabled: true,
  };

  return {
    addTeamNotification,
    getAllWindows,
    gitIdentityReceiver,
    logger,
    mainWindow,
    Notification,
    notificationInstances,
    notificationListeners,
    notificationsConfig,
    worktreeGitReceiver,
  };
});

vi.mock('@shared/utils/logger', () => ({
  createLogger: vi.fn(() => auxiliaryMocks.logger),
}));

vi.mock('@main/services/team/TeamWorktreeGitService', () => ({
  TeamWorktreeGitService: vi.fn(function MockTeamWorktreeGitService() {
    return auxiliaryMocks.worktreeGitReceiver;
  }),
}));

vi.mock('@main/services/parsing/GitIdentityResolver', () => ({
  gitIdentityResolver: auxiliaryMocks.gitIdentityReceiver,
}));

vi.mock('@main/services/infrastructure/NotificationManager', () => ({
  NotificationManager: {
    getInstance: vi.fn(() => ({
      addTeamNotification: auxiliaryMocks.addTeamNotification,
    })),
  },
}));

vi.mock('@main/services/infrastructure/ConfigManager', () => ({
  ConfigManager: {
    getInstance: vi.fn(() => ({
      getConfig: () => ({ notifications: auxiliaryMocks.notificationsConfig }),
    })),
  },
}));

vi.mock('@main/utils/appIcon', () => ({
  getAppIconPath: vi.fn(() => '/icons/app.png'),
}));

vi.mock('@main/utils/textFormatting', () => ({
  stripMarkdown: vi.fn((value: string) => value.replaceAll('*', '')),
}));

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: auxiliaryMocks.getAllWindows,
  },
  Notification: auxiliaryMocks.Notification,
}));

import {
  initializeTeamAuxiliaryIpc,
  registerTeamAuxiliaryIpc,
  removeTeamAuxiliaryIpc,
  showTeamNativeNotification,
} from '../../../src/main/ipc/teamAuxiliaryIpc';
import {
  TEAM_CREATE_INITIAL_GIT_COMMIT,
  TEAM_GET_PROJECT_BRANCH,
  TEAM_GET_WORKTREE_GIT_STATUS,
  TEAM_INITIALIZE_GIT_REPOSITORY,
  TEAM_SET_PROJECT_BRANCH_TRACKING,
  TEAM_SET_TASK_LOG_STREAM_TRACKING,
  TEAM_SET_TOOL_ACTIVITY_TRACKING,
  TEAM_SHOW_MESSAGE_NOTIFICATION,
} from '../../../src/preload/constants/ipcChannels';

type Handler = (...args: unknown[]) => Promise<unknown>;

const AUXILIARY_CHANNELS = [
  TEAM_SET_PROJECT_BRANCH_TRACKING,
  TEAM_SET_TASK_LOG_STREAM_TRACKING,
  TEAM_SET_TOOL_ACTIVITY_TRACKING,
  TEAM_GET_WORKTREE_GIT_STATUS,
  TEAM_INITIALIZE_GIT_REPOSITORY,
  TEAM_CREATE_INITIAL_GIT_COMMIT,
  TEAM_GET_PROJECT_BRANCH,
  TEAM_SHOW_MESSAGE_NOTIFICATION,
] as const;

function gitStatus(projectPath: string) {
  return {
    projectPath,
    isGitRepo: true,
    hasHead: true,
    canUseWorktrees: true,
  };
}

describe('teamAuxiliaryIpc', () => {
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle: vi.fn((channel: string, handler: Handler) => {
      handlers.set(channel, handler);
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel);
    }),
  };

  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    handlers.clear();
    auxiliaryMocks.notificationInstances.length = 0;
    auxiliaryMocks.notificationListeners.length = 0;
    auxiliaryMocks.notificationsConfig.enabled = true;
    auxiliaryMocks.notificationsConfig.snoozedUntil = null;
    auxiliaryMocks.notificationsConfig.soundEnabled = true;
    auxiliaryMocks.Notification.isSupported.mockReturnValue(false);
    auxiliaryMocks.getAllWindows.mockReturnValue([]);
    auxiliaryMocks.mainWindow.isDestroyed.mockReturnValue(false);
    auxiliaryMocks.addTeamNotification.mockResolvedValue({
      id: 'notification-1',
      isRead: false,
      createdAt: Date.now(),
    });
    auxiliaryMocks.worktreeGitReceiver.getStatus.mockImplementation(function (
      this: unknown,
      projectPath: string
    ) {
      if (this !== auxiliaryMocks.worktreeGitReceiver) {
        throw new Error('getStatus receiver was lost');
      }
      return Promise.resolve(gitStatus(projectPath));
    });
    auxiliaryMocks.worktreeGitReceiver.initializeRepository.mockImplementation(function (
      this: unknown,
      projectPath: string
    ) {
      if (this !== auxiliaryMocks.worktreeGitReceiver) {
        throw new Error('initializeRepository receiver was lost');
      }
      return Promise.resolve(gitStatus(projectPath));
    });
    auxiliaryMocks.worktreeGitReceiver.createInitialCommit.mockImplementation(function (
      this: unknown,
      projectPath: string
    ) {
      if (this !== auxiliaryMocks.worktreeGitReceiver) {
        throw new Error('createInitialCommit receiver was lost');
      }
      return Promise.resolve(gitStatus(projectPath));
    });
    auxiliaryMocks.gitIdentityReceiver.getBranch.mockImplementation(function (
      this: unknown,
      _projectPath: string
    ) {
      if (this !== auxiliaryMocks.gitIdentityReceiver) {
        throw new Error('getBranch receiver was lost');
      }
      return Promise.resolve('feature/auxiliary-ipc');
    });
    initializeTeamAuxiliaryIpc({});
    registerTeamAuxiliaryIpc(ipcMain as never);
  });

  it('registers and removes exactly the eight auxiliary channels', () => {
    expect(new Set(handlers.keys())).toEqual(new Set(AUXILIARY_CHANNELS));
    expect(ipcMain.handle).toHaveBeenCalledTimes(AUXILIARY_CHANNELS.length);

    removeTeamAuxiliaryIpc(ipcMain as never);

    expect(ipcMain.removeHandler).toHaveBeenCalledTimes(AUXILIARY_CHANNELS.length);
    expect(new Set(ipcMain.removeHandler.mock.calls.map(([channel]) => channel))).toEqual(
      new Set(AUXILIARY_CHANNELS)
    );
    expect(handlers.size).toBe(0);
  });

  it('preserves tracker validation, trimming, task-log source, and success envelopes', async () => {
    const branchTracker = { setTracking: vi.fn().mockResolvedValue(undefined) };
    const logTracker = {
      enableTracking: vi.fn().mockResolvedValue(undefined),
      disableTracking: vi.fn().mockResolvedValue(undefined),
    };
    const toolTracker = { setTracking: vi.fn().mockResolvedValue(undefined) };
    initializeTeamAuxiliaryIpc({
      branchTracker: branchTracker as never,
      logSourceTracker: logTracker as never,
      toolTracker: toolTracker as never,
    });

    await expect(
      handlers.get(TEAM_SET_PROJECT_BRANCH_TRACKING)!({}, '  project/../project  ', true)
    ).resolves.toEqual({ success: true, data: undefined });
    await expect(
      handlers.get(TEAM_SET_TASK_LOG_STREAM_TRACKING)!({}, 'my-team', true)
    ).resolves.toEqual({ success: true, data: undefined });
    await expect(
      handlers.get(TEAM_SET_TASK_LOG_STREAM_TRACKING)!({}, 'my-team', false)
    ).resolves.toEqual({ success: true, data: undefined });
    await expect(
      handlers.get(TEAM_SET_TOOL_ACTIVITY_TRACKING)!({}, 'my-team', false)
    ).resolves.toEqual({ success: true, data: undefined });

    expect(branchTracker.setTracking).toHaveBeenCalledWith('project/../project', true);
    expect(logTracker.enableTracking).toHaveBeenCalledWith('my-team', 'task_log_stream');
    expect(logTracker.disableTracking).toHaveBeenCalledWith('my-team', 'task_log_stream');
    expect(toolTracker.setTracking).toHaveBeenCalledWith('my-team', false);
  });

  it('preserves tracker-unavailable envelopes and operation log text', async () => {
    await expect(
      handlers.get(TEAM_SET_PROJECT_BRANCH_TRACKING)!({}, '/project', true)
    ).resolves.toEqual({
      success: false,
      error: 'Branch status service is not initialized',
    });
    await expect(
      handlers.get(TEAM_SET_TASK_LOG_STREAM_TRACKING)!({}, 'my-team', true)
    ).resolves.toEqual({
      success: false,
      error: 'Team log source tracker is not initialized',
    });
    await expect(
      handlers.get(TEAM_SET_TOOL_ACTIVITY_TRACKING)!({}, 'my-team', true)
    ).resolves.toEqual({
      success: false,
      error: 'Teammate tool tracker is not initialized',
    });

    expect(auxiliaryMocks.logger.error.mock.calls).toEqual([
      ['[teams:setProjectBranchTracking] Branch status service is not initialized'],
      ['[teams:setTaskLogStreamTracking] Team log source tracker is not initialized'],
      ['[teams:setToolActivityTracking] Teammate tool tracker is not initialized'],
    ]);
  });

  it('preserves tracker input validation before dependency access', async () => {
    await expect(handlers.get(TEAM_SET_PROJECT_BRANCH_TRACKING)!({}, '  ', true)).resolves.toEqual({
      success: false,
      error: 'projectPath must be a non-empty string',
    });
    await expect(
      handlers.get(TEAM_SET_PROJECT_BRANCH_TRACKING)!({}, '/project', 'yes')
    ).resolves.toEqual({
      success: false,
      error: 'enabled must be a boolean',
    });
    await expect(
      handlers.get(TEAM_SET_TASK_LOG_STREAM_TRACKING)!({}, '../bad', true)
    ).resolves.toEqual({
      success: false,
      error: expect.any(String),
    });
    await expect(
      handlers.get(TEAM_SET_TOOL_ACTIVITY_TRACKING)!({}, 'my-team', 'yes')
    ).resolves.toEqual({
      success: false,
      error: 'enabled must be a boolean',
    });
    expect(auxiliaryMocks.logger.error).not.toHaveBeenCalled();
  });

  it('normalizes all four git paths and preserves each service receiver', async () => {
    const input = `  folder${path.sep}..${path.sep}project  `;
    const normalized = path.normalize(input.trim());

    await expect(handlers.get(TEAM_GET_WORKTREE_GIT_STATUS)!({}, input)).resolves.toEqual({
      success: true,
      data: gitStatus(normalized),
    });
    await expect(handlers.get(TEAM_INITIALIZE_GIT_REPOSITORY)!({}, input)).resolves.toEqual({
      success: true,
      data: gitStatus(normalized),
    });
    await expect(handlers.get(TEAM_CREATE_INITIAL_GIT_COMMIT)!({}, input)).resolves.toEqual({
      success: true,
      data: gitStatus(normalized),
    });
    await expect(handlers.get(TEAM_GET_PROJECT_BRANCH)!({}, input)).resolves.toEqual({
      success: true,
      data: 'feature/auxiliary-ipc',
    });

    expect(auxiliaryMocks.worktreeGitReceiver.getStatus).toHaveBeenCalledWith(normalized);
    expect(auxiliaryMocks.worktreeGitReceiver.initializeRepository).toHaveBeenCalledWith(
      normalized
    );
    expect(auxiliaryMocks.worktreeGitReceiver.createInitialCommit).toHaveBeenCalledWith(normalized);
    expect(auxiliaryMocks.gitIdentityReceiver.getBranch).toHaveBeenCalledWith(normalized);
  });

  it('preserves git validation and failure envelopes with operation log text', async () => {
    for (const channel of [
      TEAM_GET_WORKTREE_GIT_STATUS,
      TEAM_INITIALIZE_GIT_REPOSITORY,
      TEAM_CREATE_INITIAL_GIT_COMMIT,
      TEAM_GET_PROJECT_BRANCH,
    ]) {
      await expect(handlers.get(channel)!({}, '  ')).resolves.toEqual({
        success: false,
        error: 'projectPath must be a non-empty string',
      });
    }

    auxiliaryMocks.worktreeGitReceiver.getStatus.mockRejectedValueOnce(
      new Error('status unavailable')
    );
    auxiliaryMocks.gitIdentityReceiver.getBranch.mockRejectedValueOnce('branch unavailable');

    await expect(handlers.get(TEAM_GET_WORKTREE_GIT_STATUS)!({}, '/project')).resolves.toEqual({
      success: false,
      error: 'status unavailable',
    });
    await expect(handlers.get(TEAM_GET_PROJECT_BRANCH)!({}, '/project')).resolves.toEqual({
      success: false,
      error: 'branch unavailable',
    });
    expect(auxiliaryMocks.logger.error.mock.calls).toEqual([
      ['[teams:getWorktreeGitStatus] status unavailable'],
      ['[teams:getProjectBranch] branch unavailable'],
    ]);
  });

  it('preserves notification validation, defaults, dedupe, and fire-and-forget behavior', async () => {
    let settleNotification!: () => void;
    auxiliaryMocks.addTeamNotification.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        settleNotification = resolve;
      })
    );
    const body = 'x'.repeat(80);

    await expect(
      handlers.get(TEAM_SHOW_MESSAGE_NOTIFICATION)!(
        {},
        {
          teamDisplayName: 'My Team',
          teamName: 'my-team',
          from: 'alice',
          body,
        }
      )
    ).resolves.toEqual({ success: true, data: undefined });
    expect(auxiliaryMocks.addTeamNotification).toHaveBeenCalledWith({
      teamEventType: 'task_clarification',
      teamName: 'my-team',
      teamDisplayName: 'My Team',
      from: 'alice',
      to: undefined,
      summary: 'alice → team',
      body,
      dedupeKey: `msg:my-team:alice:${body.slice(0, 50)}`,
      target: undefined,
      suppressToast: undefined,
    });
    settleNotification();

    await expect(handlers.get(TEAM_SHOW_MESSAGE_NOTIFICATION)!({}, null)).resolves.toEqual({
      success: false,
      error: 'Invalid notification data',
    });
    await expect(
      handlers.get(TEAM_SHOW_MESSAGE_NOTIFICATION)!(
        {},
        {
          teamDisplayName: 'My Team',
          body: 'hello',
        }
      )
    ).resolves.toEqual({
      success: false,
      error: 'Missing required fields (teamDisplayName, from, body)',
    });
    await expect(
      handlers.get(TEAM_SHOW_MESSAGE_NOTIFICATION)!(
        {},
        {
          teamDisplayName: 'My Team',
          from: 'alice',
          body: 'hello',
        }
      )
    ).resolves.toEqual({
      success: false,
      error: 'Missing required field: teamName (needed for deep-link navigation)',
    });
  });

  it('preserves explicit notification fields and swallows asynchronous manager failures', async () => {
    auxiliaryMocks.addTeamNotification.mockRejectedValueOnce(new Error('storage failed'));

    await expect(
      handlers.get(TEAM_SHOW_MESSAGE_NOTIFICATION)!(
        {},
        {
          teamDisplayName: 'My Team',
          teamName: 'my-team',
          from: 'alice',
          to: 'bob',
          summary: 'Needs input',
          body: 'Please decide',
          teamEventType: 'task_error',
          dedupeKey: 'task-error:42',
          target: { type: 'task', teamName: 'my-team', taskId: '42' },
          suppressToast: true,
        }
      )
    ).resolves.toEqual({ success: true, data: undefined });
    expect(auxiliaryMocks.addTeamNotification).toHaveBeenCalledWith({
      teamEventType: 'task_error',
      teamName: 'my-team',
      teamDisplayName: 'My Team',
      from: 'alice',
      to: 'bob',
      summary: 'Needs input',
      body: 'Please decide',
      dedupeKey: 'task-error:42',
      target: { type: 'task', teamName: 'my-team', taskId: '42' },
      suppressToast: true,
    });
  });

  it('preserves native notification retention, click cleanup, and window focus behavior', () => {
    vi.useFakeTimers();
    auxiliaryMocks.Notification.isSupported.mockReturnValue(true);
    auxiliaryMocks.getAllWindows.mockReturnValue([auxiliaryMocks.mainWindow]);

    showTeamNativeNotification({
      title: 'Task update',
      subtitle: 'My Team',
      body: '**Done**',
    });

    expect(auxiliaryMocks.Notification).toHaveBeenCalledWith(
      process.platform === 'darwin'
        ? {
            title: 'Task update',
            subtitle: 'My Team',
            body: 'Done',
            sound: 'default',
          }
        : {
            title: 'Task update',
            body: 'My Team\nDone',
            sound: 'default',
            icon: '/icons/app.png',
          }
    );
    expect(auxiliaryMocks.notificationInstances[0].show).toHaveBeenCalledTimes(1);
    expect([...auxiliaryMocks.notificationListeners[0].keys()]).toEqual([
      'click',
      'close',
      'show',
      'failed',
    ]);
    expect(vi.getTimerCount()).toBe(1);

    auxiliaryMocks.notificationListeners[0].get('click')!();

    expect(auxiliaryMocks.mainWindow.show).toHaveBeenCalledTimes(1);
    expect(auxiliaryMocks.mainWindow.focus).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
