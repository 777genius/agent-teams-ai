import { setClaudeBasePathOverride } from '@main/utils/pathDecoder';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  BoardTaskActivityDetailResult,
  BoardTaskActivityEntry,
  BoardTaskExactLogDetailResult,
  BoardTaskExactLogSummariesResponse,
  BoardTaskLogStreamResponse,
  InboxMessage,
  MessagesPage,
  OpenCodeRuntimeDeliveryStatus,
  SendMessageResult,
  TeamCreateRequest,
  TeamLaunchRequest,
  TeamProviderId,
  TeamProvisioningProgress,
  TeamViewSnapshot,
} from '@shared/types/team';

vi.mock('electron', () => ({
  app: { getLocale: vi.fn(() => 'en'), getPath: vi.fn(() => '/tmp'), isPackaged: false },
  Notification: Object.assign(vi.fn(), { isSupported: vi.fn(() => false) }),
  BrowserWindow: { fromWebContents: vi.fn(() => null), getAllWindows: vi.fn(() => []) },
}));

// Keep this mock resilient to new exports (avoid drift).
vi.mock('@preload/constants/ipcChannels', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@preload/constants/ipcChannels')>();
  return { ...actual };
});

// Mock NotificationManager — handleShowMessageNotification calls addTeamNotification
const { mockAddTeamNotification } = vi.hoisted(() => ({
  mockAddTeamNotification: vi
    .fn()
    .mockResolvedValue({ id: 'n1', isRead: false, createdAt: Date.now() }),
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
    invalidateTeamConfig: vi.fn(),
    invalidateTeamMessageFeed: vi.fn(),
    invalidateMemberRuntimeAdvisory: vi.fn(),
  },
}));

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function resolved<T>(value: T): Promise<T> {
  return Promise.resolve(value);
}

function resolvedUndefined(): Promise<void> {
  return Promise.resolve();
}

function secondMockArgString(call: unknown[] | undefined): string {
  const [, value] = call ?? [];
  return typeof value === 'string' ? value : '';
}

const TEST_PROJECT_PATH = path.join(os.tmpdir(), 'project');
const DRAFT_TEAM_CWD = path.join(os.tmpdir(), 'draft-team');
const TASK_LOG_JSONL_PATH = path.join(os.tmpdir(), 'task.jsonl');
const TASK_LOG_BUNDLE_ID = `tool:${TASK_LOG_JSONL_PATH}:tool-1`;
const TRANSCRIPT_JSONL_PATH = path.join(os.tmpdir(), 'transcript.jsonl');

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
  isTeamDataWorkerFatalError: (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    return (
      message.includes('ERR_WORKER_OUT_OF_MEMORY') ||
      message.includes('Worker terminated due to reaching memory limit') ||
      message.includes('JS heap out of memory') ||
      /Worker exited with code (?!0\b)\d+/.test(message) ||
      message.includes('Worker call timeout after')
    );
  },
}));

import {
  type CanonicalListTeamLifecycleResult,
  TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
} from '../../../src/features/team-lifecycle';
import { createUnavailablePhase2ReadHost } from '../../../src/main/composition/hosted/phase2ReadComposition';
import {
  handlePhase2ListTeamLifecycle,
  initializePhase2TeamReadHandler,
  initializeTeamHandlers,
  registerTeamHandlers,
  removeTeamHandlers,
} from '../../../src/main/ipc/teams';
import { ConfigManager } from '../../../src/main/services/infrastructure/ConfigManager';
import {
  computeTeamWatchScope,
  resetTeamWatchScopeForTests,
} from '../../../src/main/services/infrastructure/teamWatchScope';
import { getAutoResumeService } from '../../../src/main/services/team/AutoResumeService';
import { LaunchIoGovernor } from '../../../src/main/services/team/LaunchIoGovernor';
import { getAppDataPath } from '../../../src/main/utils/pathDecoder';
import {
  TEAM_ADD_MEMBER,
  TEAM_ADD_TASK_COMMENT,
  TEAM_ADD_TASK_RELATIONSHIP,
  TEAM_ALIVE_LIST,
  TEAM_CANCEL_PROVISIONING,
  TEAM_CREATE,
  TEAM_CREATE_CONFIG,
  TEAM_CREATE_INITIAL_GIT_COMMIT,
  TEAM_CREATE_TASK,
  TEAM_DELETE_DRAFT,
  TEAM_DELETE_TASK_ATTACHMENT,
  TEAM_DELETE_TEAM,
  TEAM_GET_AGENT_RUNTIME,
  TEAM_GET_ALL_TASKS,
  TEAM_GET_ATTACHMENTS,
  TEAM_GET_CLAUDE_LOGS,
  TEAM_GET_DATA,
  TEAM_GET_DELETED_TASKS,
  TEAM_GET_LOGS_FOR_TASK,
  TEAM_GET_MEMBER_ACTIVITY_META,
  TEAM_GET_MEMBER_LOGS,
  TEAM_GET_MEMBER_STATS,
  TEAM_GET_MESSAGES_PAGE,
  TEAM_GET_OPENCODE_RUNTIME_DELIVERY_STATUS,
  TEAM_GET_PROJECT_BRANCH,
  TEAM_GET_SAVED_REQUEST,
  TEAM_GET_TASK,
  TEAM_GET_TASK_ACTIVITY,
  TEAM_GET_TASK_ACTIVITY_DETAIL,
  TEAM_GET_TASK_ATTACHMENT,
  TEAM_GET_TASK_CHANGE_PRESENCE,
  TEAM_GET_TASK_EXACT_LOG_DETAIL,
  TEAM_GET_TASK_EXACT_LOG_SUMMARIES,
  TEAM_GET_TASK_LOG_STREAM,
  TEAM_GET_TASK_LOG_STREAM_SUMMARY,
  TEAM_GET_WORKTREE_GIT_STATUS,
  TEAM_INITIALIZE_GIT_REPOSITORY,
  TEAM_KILL_PROCESS,
  TEAM_LAUNCH,
  TEAM_LAUNCH_FAILURE_DIAGNOSTICS,
  TEAM_LEAD_ACTIVITY,
  TEAM_LEAD_CONTEXT,
  TEAM_LIST,
  TEAM_MEMBER_SPAWN_STATUSES,
  TEAM_PERMANENTLY_DELETE,
  TEAM_PREPARE_PROVISIONING,
  TEAM_PROCESS_ALIVE,
  TEAM_PROCESS_SEND,
  TEAM_PROVISIONING_STATUS,
  TEAM_REMOVE_MEMBER,
  TEAM_REMOVE_TASK_RELATIONSHIP,
  TEAM_REPLACE_MEMBERS,
  TEAM_REQUEST_REVIEW,
  TEAM_RESTART_MEMBER,
  TEAM_RESTORE,
  TEAM_RESTORE_MEMBER,
  TEAM_RESTORE_TASK,
  TEAM_RETRY_FAILED_OPENCODE_SECONDARY_LANES,
  TEAM_SAVE_TASK_ATTACHMENT,
  TEAM_SEND_MESSAGE,
  TEAM_SET_CHANGE_PRESENCE_TRACKING,
  TEAM_SET_PROJECT_BRANCH_TRACKING,
  TEAM_SET_TASK_CLARIFICATION,
  TEAM_SET_TASK_LOG_STREAM_TRACKING,
  TEAM_SET_TOOL_ACTIVITY_TRACKING,
  TEAM_SHOW_MESSAGE_NOTIFICATION,
  TEAM_SKIP_MEMBER_FOR_LAUNCH,
  TEAM_SOFT_DELETE_TASK,
  TEAM_START_TASK,
  TEAM_START_TASK_BY_USER,
  TEAM_STOP,
  TEAM_TOOL_APPROVAL_READ_FILE,
  TEAM_TOOL_APPROVAL_RESPOND,
  TEAM_TOOL_APPROVAL_SETTINGS,
  TEAM_UPDATE_CONFIG,
  TEAM_UPDATE_KANBAN,
  TEAM_UPDATE_KANBAN_COLUMN_ORDER,
  TEAM_UPDATE_MEMBER_ROLE,
  TEAM_UPDATE_TASK_FIELDS,
  TEAM_UPDATE_TASK_OWNER,
  TEAM_UPDATE_TASK_STATUS,
  TEAM_VALIDATE_CLI_ARGS,
} from '../../../src/preload/constants/ipcChannels';
import { parseRevision, parseTeamId, parseWorkspaceId } from '../../../src/shared/contracts/hosted';

import type { TeamIpcHandlerApis } from '../../../src/main/services/team/contracts/TeamProvisioningApis';

type CreateTeamMock = (
  request: TeamCreateRequest,
  onProgress: (progress: TeamProvisioningProgress) => void
) => Promise<{ runId: string }>;

const TEAM_HANDLER_KEYS = [
  TEAM_ADD_MEMBER,
  TEAM_ADD_TASK_COMMENT,
  TEAM_ADD_TASK_RELATIONSHIP,
  TEAM_ALIVE_LIST,
  TEAM_CANCEL_PROVISIONING,
  TEAM_CREATE,
  TEAM_CREATE_CONFIG,
  TEAM_CREATE_INITIAL_GIT_COMMIT,
  TEAM_CREATE_TASK,
  TEAM_DELETE_DRAFT,
  TEAM_DELETE_TASK_ATTACHMENT,
  TEAM_DELETE_TEAM,
  TEAM_GET_AGENT_RUNTIME,
  TEAM_GET_ALL_TASKS,
  TEAM_GET_ATTACHMENTS,
  TEAM_GET_CLAUDE_LOGS,
  TEAM_GET_DATA,
  TEAM_GET_DELETED_TASKS,
  TEAM_GET_LOGS_FOR_TASK,
  TEAM_GET_MEMBER_ACTIVITY_META,
  TEAM_GET_MEMBER_LOGS,
  TEAM_GET_MEMBER_STATS,
  TEAM_GET_MESSAGES_PAGE,
  TEAM_GET_OPENCODE_RUNTIME_DELIVERY_STATUS,
  TEAM_GET_PROJECT_BRANCH,
  TEAM_GET_SAVED_REQUEST,
  TEAM_GET_TASK,
  TEAM_GET_TASK_ACTIVITY,
  TEAM_GET_TASK_ACTIVITY_DETAIL,
  TEAM_GET_TASK_ATTACHMENT,
  TEAM_GET_TASK_CHANGE_PRESENCE,
  TEAM_GET_TASK_EXACT_LOG_DETAIL,
  TEAM_GET_TASK_EXACT_LOG_SUMMARIES,
  TEAM_GET_TASK_LOG_STREAM,
  TEAM_GET_TASK_LOG_STREAM_SUMMARY,
  TEAM_GET_WORKTREE_GIT_STATUS,
  TEAM_INITIALIZE_GIT_REPOSITORY,
  TEAM_KILL_PROCESS,
  TEAM_LAUNCH,
  TEAM_LAUNCH_FAILURE_DIAGNOSTICS,
  TEAM_LEAD_ACTIVITY,
  TEAM_LEAD_CONTEXT,
  TEAM_LIST,
  TEAM_MEMBER_SPAWN_STATUSES,
  TEAM_PERMANENTLY_DELETE,
  TEAM_PREPARE_PROVISIONING,
  TEAM_PROCESS_ALIVE,
  TEAM_PROCESS_SEND,
  TEAM_PROVISIONING_STATUS,
  TEAM_REMOVE_MEMBER,
  TEAM_REMOVE_TASK_RELATIONSHIP,
  TEAM_REPLACE_MEMBERS,
  TEAM_REQUEST_REVIEW,
  TEAM_RESTART_MEMBER,
  TEAM_RESTORE,
  TEAM_RESTORE_MEMBER,
  TEAM_RESTORE_TASK,
  TEAM_RETRY_FAILED_OPENCODE_SECONDARY_LANES,
  TEAM_SAVE_TASK_ATTACHMENT,
  TEAM_SEND_MESSAGE,
  TEAM_SET_CHANGE_PRESENCE_TRACKING,
  TEAM_SET_PROJECT_BRANCH_TRACKING,
  TEAM_SET_TASK_CLARIFICATION,
  TEAM_SET_TASK_LOG_STREAM_TRACKING,
  TEAM_SET_TOOL_ACTIVITY_TRACKING,
  TEAM_SHOW_MESSAGE_NOTIFICATION,
  TEAM_SKIP_MEMBER_FOR_LAUNCH,
  TEAM_SOFT_DELETE_TASK,
  TEAM_START_TASK,
  TEAM_START_TASK_BY_USER,
  TEAM_STOP,
  TEAM_TOOL_APPROVAL_READ_FILE,
  TEAM_TOOL_APPROVAL_RESPOND,
  TEAM_TOOL_APPROVAL_SETTINGS,
  TEAM_UPDATE_CONFIG,
  TEAM_UPDATE_KANBAN,
  TEAM_UPDATE_KANBAN_COLUMN_ORDER,
  TEAM_UPDATE_MEMBER_ROLE,
  TEAM_UPDATE_TASK_FIELDS,
  TEAM_UPDATE_TASK_OWNER,
  TEAM_UPDATE_TASK_STATUS,
  TEAM_VALIDATE_CLI_ARGS,
] as const;

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
  let launchIoGovernor: LaunchIoGovernor;

  const service = {
    listTeams: vi.fn(() => resolved([{ teamName: 'my-team', displayName: 'My Team' }])),
    getTeamData: vi.fn(
      (): Promise<TeamViewSnapshot & { messages?: InboxMessage[] }> =>
        resolved({
          teamName: 'my-team',
          config: { name: 'My Team' },
          tasks: [],
          members: [],
          kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
          processes: [],
        })
    ),
    getMessageFeed: vi.fn(() =>
      resolved({
        teamName: 'my-team',
        feedRevision: 'rev-1',
        messages: [] as InboxMessage[],
      })
    ),
    getAllTasks: vi.fn(() => resolved([{ id: 'task-1', teamName: 'my-team', subject: 'Task 1' }])),
    getMessagesPage: vi.fn(
      (): Promise<MessagesPage> =>
        resolved({
          messages: [] as InboxMessage[],
          nextCursor: null,
          hasMore: false,
          feedRevision: 'rev-1',
        })
    ),
    getMemberActivityMeta: vi.fn(() =>
      resolved({
        teamName: 'my-team',
        computedAt: '2026-03-12T10:00:00.000Z',
        members: {},
        feedRevision: 'rev-1',
      })
    ),
    getTaskChangePresence: vi.fn(() => resolved({ 'task-1': 'has_changes' })),
    reconcileTeamArtifacts: vi.fn(() => resolvedUndefined()),
    setTaskChangePresenceTracking: vi.fn(() => undefined),
    getTeamNotificationContext: vi.fn(() =>
      resolved({
        displayName: 'My Team',
        projectPath: TEST_PROJECT_PATH,
      })
    ),
    deleteTeam: vi.fn(() => resolvedUndefined()),
    restoreTeam: vi.fn(() => resolvedUndefined()),
    permanentlyDeleteTeam: vi.fn(() => resolvedUndefined()),
    getLeadMemberName: vi.fn(() => resolved('team-lead')),
    getTeamDisplayName: vi.fn(() => resolved('My Team')),
    updateConfig: vi.fn(() => resolved({ name: 'My Team' })),
    sendMessage: vi.fn(() =>
      resolved({
        deliveredToInbox: true,
        messageId: 'm1',
      })
    ) as ReturnType<
      typeof vi.fn<
        (
          teamName: string,
          request: unknown
        ) => Promise<{ deliveredToInbox: boolean; messageId: string }>
      >
    >,
    sendRuntimeRecipientMessage: vi.fn(() =>
      resolved({
        deliveredToInbox: true,
        messageId: 'm1',
      })
    ) as ReturnType<
      typeof vi.fn<
        (
          teamName: string,
          request: unknown
        ) => Promise<{ deliveredToInbox: boolean; messageId: string }>
      >
    >,
    sendDirectToLead: vi.fn(() => resolved({ deliveredToInbox: false, messageId: 'direct-1' })),
    createTask: vi.fn(() => resolved({ id: '1', subject: 'Test', status: 'pending' })),
    requestReview: vi.fn(() => resolvedUndefined()),
    updateKanban: vi.fn(() => resolvedUndefined()),
    updateKanbanColumnOrder: vi.fn(() => resolvedUndefined()),
    updateTaskStatus: vi.fn(() => resolvedUndefined()),
    startTask: vi.fn(() => resolvedUndefined()),
    addTaskComment: vi.fn(() =>
      resolved({
        id: 'c1',
        author: 'user',
        text: 'test comment',
        createdAt: new Date().toISOString(),
      })
    ),
    addMember: vi.fn(() => resolvedUndefined()),
    removeMember: vi.fn(() => resolvedUndefined()),
    restoreMember: vi.fn(() =>
      resolved({
        name: 'alice',
        role: 'Developer',
        providerId: 'codex' as TeamProviderId,
      })
    ),
    updateMemberRole: vi.fn(() => resolved({ oldRole: undefined, changed: true })),
    softDeleteTask: vi.fn(() => resolvedUndefined()),
    getDeletedTasks: vi.fn(() => resolved([])),
    setTaskNeedsClarification: vi.fn(() => resolvedUndefined()),
    addTaskRelationship: vi.fn(() => resolvedUndefined()),
    removeTaskRelationship: vi.fn(() => resolvedUndefined()),
    replaceMembers: vi.fn(() => resolvedUndefined()),
    invalidateMessageFeed: vi.fn(() => undefined),
    invalidateTeamRuntimeAdvisories: vi.fn(() => undefined),
    createTeamConfig: vi.fn(() => resolvedUndefined()),
    getSavedRequest: vi.fn<() => Promise<TeamCreateRequest | null>>(() => resolved(null)),
  };
  const teamHandlerMocks = {
    getCliHelpOutput: vi.fn(() => resolved('Usage')),
    prepareForProvisioning: vi.fn(() =>
      resolved({
        ready: true,
        message: 'CLI прогрет и готов к запуску',
      })
    ),
    createTeam: vi.fn<CreateTeamMock>(() =>
      resolved({
        runId: 'run-1',
      })
    ),
    getProvisioningStatus: vi.fn(() =>
      resolved({
        runId: 'run-1',
        teamName: 'my-team',
        state: 'spawning' as const,
        message: 'Starting',
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
    ),
    cancelProvisioning: vi.fn(() => resolvedUndefined()),
    hasProvisioningRun: vi.fn(() => false),
    getClaudeLogs: vi.fn(() => resolved({ lines: [], total: 0, hasMore: false })),
    launchTeam: vi.fn(() => resolved({ runId: 'run-2' })),
    sendMessageToTeam: vi.fn(() => resolvedUndefined()),
    getRuntimeState: vi.fn(() =>
      resolved({
        teamName: 'my-team',
        isAlive: true,
        runId: 'run-2',
        progress: null,
      })
    ),
    isTeamAlive: vi.fn(() => true),
    getCurrentRunId: vi.fn(() => 'run-2' as string | null),
    pushLiveLeadProcessMessage: vi.fn(),
    respondToToolApproval: vi.fn(() => resolvedUndefined()),
    updateToolApprovalSettings: vi.fn(),
    relayLeadInboxMessages: vi.fn(() => resolved(0)),
    resolveRuntimeRecipientProviderId: vi.fn(
      (): Promise<TeamProviderId | undefined> => resolved(undefined)
    ) as ReturnType<
      typeof vi.fn<(teamName: string, memberName: string) => Promise<TeamProviderId | undefined>>
    >,
    relayOpenCodeMemberInboxMessages: vi.fn(() =>
      resolved({
        relayed: 0,
        attempted: 0,
        delivered: 0,
        failed: 0,
        lastDelivery: undefined as
          | {
              delivered: boolean;
              accepted?: boolean;
              responsePending?: boolean;
              acceptanceUnknown?: boolean;
              responseState?: NonNullable<SendMessageResult['runtimeDelivery']>['responseState'];
              ledgerStatus?: NonNullable<SendMessageResult['runtimeDelivery']>['ledgerStatus'];
              ledgerRecordId?: string;
              laneId?: string;
              reason?: string;
              diagnostics?: string[];
            }
          | undefined,
      })
    ),
    getOpenCodeRuntimeDeliveryStatus: vi.fn(() =>
      resolved(null as OpenCodeRuntimeDeliveryStatus | null)
    ),
    getLiveLeadProcessMessages: vi.fn(() => [] as InboxMessage[]),
    getCurrentLeadSessionId: vi.fn(() => null as string | null),
    getAliveTeams: vi.fn(() => ['my-team']),
    getLeadActivityState: vi.fn(() => ({ state: 'idle' as const, runId: 'run-2' })),
    getLeadContextUsage: vi.fn(() => ({ usage: null, runId: 'run-2' })),
    getTeamAgentRuntimeSnapshot: vi.fn(() =>
      resolved({
        teamName: 'my-team',
        runId: 'run-2',
        updatedAt: new Date().toISOString(),
        members: {},
      })
    ),
    getMemberSpawnStatuses: vi.fn(() =>
      resolved({
        statuses: {},
        runId: 'run-2',
        updatedAt: new Date().toISOString(),
      })
    ),
    restartMember: vi.fn(() => resolvedUndefined()),
    retryFailedOpenCodeSecondaryLanes: vi.fn(() =>
      resolved({
        attempted: [],
        confirmed: [],
        pending: [],
        failed: [],
        skipped: [],
      })
    ),
    skipMemberForLaunch: vi.fn(() => resolvedUndefined()),
    stopTeam: vi.fn(() => Promise.resolve()),
    repairStaleTaskActivityIntervalsBeforeSnapshot: vi.fn(() => Promise.resolve(undefined)),
    attachLiveRosterMember: vi.fn(() => resolvedUndefined()),
    detachLiveRosterMember: vi.fn(() => resolvedUndefined()),
  };
  const teamHandlerApis = {
    provisioningStart: {
      createTeam: teamHandlerMocks.createTeam,
      launchTeam: teamHandlerMocks.launchTeam,
    },
    provisioningStatus: {
      getProvisioningStatus: teamHandlerMocks.getProvisioningStatus,
    },
    preflight: {
      getCliHelpOutput: teamHandlerMocks.getCliHelpOutput,
      prepareForProvisioning: teamHandlerMocks.prepareForProvisioning,
    },
    provisioningRun: {
      cancelProvisioning: teamHandlerMocks.cancelProvisioning,
      hasProvisioningRun: teamHandlerMocks.hasProvisioningRun,
    },
    taskActivity: {
      repairStaleTaskActivityIntervalsBeforeSnapshot:
        teamHandlerMocks.repairStaleTaskActivityIntervalsBeforeSnapshot,
    },
    runtime: {
      getRuntimeState: teamHandlerMocks.getRuntimeState,
      stopTeam: teamHandlerMocks.stopTeam,
      isTeamAlive: teamHandlerMocks.isTeamAlive,
      getAliveTeams: teamHandlerMocks.getAliveTeams,
      getCurrentRunId: teamHandlerMocks.getCurrentRunId,
    },
    memberLifecycle: {
      getMemberSpawnStatuses: teamHandlerMocks.getMemberSpawnStatuses,
      attachLiveRosterMember: teamHandlerMocks.attachLiveRosterMember,
      detachLiveRosterMember: teamHandlerMocks.detachLiveRosterMember,
      restartMember: teamHandlerMocks.restartMember,
      retryFailedOpenCodeSecondaryLanes: teamHandlerMocks.retryFailedOpenCodeSecondaryLanes,
      skipMemberForLaunch: teamHandlerMocks.skipMemberForLaunch,
    },
    diagnostics: {
      getLeadActivityState: teamHandlerMocks.getLeadActivityState,
      getLeadContextUsage: teamHandlerMocks.getLeadContextUsage,
      getTeamAgentRuntimeSnapshot: teamHandlerMocks.getTeamAgentRuntimeSnapshot,
    },
    claudeLogs: {
      getClaudeLogs: teamHandlerMocks.getClaudeLogs,
    },
    messaging: {
      sendMessageToTeam: teamHandlerMocks.sendMessageToTeam,
      relayOpenCodeMemberInboxMessages: teamHandlerMocks.relayOpenCodeMemberInboxMessages,
      relayLeadInboxMessages: teamHandlerMocks.relayLeadInboxMessages,
      getOpenCodeRuntimeDeliveryStatus: teamHandlerMocks.getOpenCodeRuntimeDeliveryStatus,
      resolveRuntimeRecipientProviderId: teamHandlerMocks.resolveRuntimeRecipientProviderId,
      getLiveLeadProcessMessages: teamHandlerMocks.getLiveLeadProcessMessages,
      getCurrentLeadSessionId: teamHandlerMocks.getCurrentLeadSessionId,
      pushLiveLeadProcessMessage: teamHandlerMocks.pushLiveLeadProcessMessage,
    },
    toolApproval: {
      respondToToolApproval: teamHandlerMocks.respondToToolApproval,
      updateToolApprovalSettings: teamHandlerMocks.updateToolApprovalSettings,
    },
  } satisfies TeamIpcHandlerApis;
  const boardTaskActivityService = {
    getTaskActivity: vi.fn<() => Promise<BoardTaskActivityEntry[]>>(() => resolved([])),
  };
  const boardTaskActivityDetailService = {
    getTaskActivityDetail: vi.fn<() => Promise<BoardTaskActivityDetailResult>>(() =>
      resolved({
        status: 'missing',
      })
    ),
  };
  const boardTaskLogStreamService = {
    getTaskLogStream: vi.fn<() => Promise<BoardTaskLogStreamResponse>>(() =>
      resolved({
        participants: [],
        defaultFilter: 'all',
        segments: [],
      })
    ),
  };
  const boardTaskExactLogsService = {
    getTaskExactLogSummaries: vi.fn<() => Promise<BoardTaskExactLogSummariesResponse>>(() =>
      resolved({ items: [] })
    ),
  };
  const boardTaskExactLogDetailService = {
    getTaskExactLogDetail: vi.fn<() => Promise<BoardTaskExactLogDetailResult>>(() =>
      resolved({
        status: 'missing',
      })
    ),
  };

  beforeEach(() => {
    resetTeamWatchScopeForTests();
    handlers.clear();
    vi.clearAllMocks();
    service.listTeams.mockReset();
    service.getTeamData.mockReset();
    service.getAllTasks.mockReset();
    service.restoreMember.mockReset();
    service.listTeams.mockResolvedValue([{ teamName: 'my-team', displayName: 'My Team' }]);
    initializePhase2TeamReadHandler({
      listTeamLifecycle: vi.fn(() =>
        Promise.resolve({
          schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
          kind: 'success' as const,
          snapshotRevision: parseRevision(`revision_${'f'.repeat(64)}`),
          items: ['my-team', 'fresh-team', 'background-fresh'].map((displayName, index) => ({
            workspaceId: parseWorkspaceId(`workspace_${'e'.repeat(32)}`),
            teamId: parseTeamId(`team_${String(index + 1).repeat(32)}`),
            displayName,
            lifecycle: 'ready' as const,
            revision: parseRevision(`revision_${String(index + 1).repeat(64)}`),
          })),
          nextCursor: null,
        })
      ),
    });
    service.getTeamData.mockResolvedValue({
      teamName: 'my-team',
      config: { name: 'My Team' },
      tasks: [],
      members: [],
      kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
      processes: [],
    });
    service.getAllTasks.mockResolvedValue([
      { id: 'task-1', teamName: 'my-team', subject: 'Task 1' },
    ]);
    service.restoreMember.mockResolvedValue({
      name: 'alice',
      role: 'Developer',
      providerId: 'codex' as TeamProviderId,
    });
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
    mockTeamDataWorkerClient.invalidateTeamConfig.mockReset();
    mockTeamDataWorkerClient.invalidateTeamMessageFeed.mockReset();
    mockTeamDataWorkerClient.invalidateMemberRuntimeAdvisory.mockReset();
    teamHandlerMocks.getCliHelpOutput.mockReset();
    teamHandlerMocks.getCliHelpOutput.mockResolvedValue('Usage');
    teamHandlerMocks.sendMessageToTeam.mockReset();
    teamHandlerMocks.sendMessageToTeam.mockResolvedValue(undefined);
    teamHandlerMocks.resolveRuntimeRecipientProviderId.mockReset();
    teamHandlerMocks.resolveRuntimeRecipientProviderId.mockResolvedValue(undefined);
    teamHandlerMocks.attachLiveRosterMember.mockReset();
    teamHandlerMocks.attachLiveRosterMember.mockResolvedValue(undefined);
    teamHandlerMocks.detachLiveRosterMember.mockReset();
    teamHandlerMocks.detachLiveRosterMember.mockResolvedValue(undefined);
    teamHandlerMocks.isTeamAlive.mockReset();
    teamHandlerMocks.isTeamAlive.mockReturnValue(true);
    teamHandlerMocks.repairStaleTaskActivityIntervalsBeforeSnapshot.mockReset();
    teamHandlerMocks.repairStaleTaskActivityIntervalsBeforeSnapshot.mockResolvedValue(undefined);
    launchIoGovernor = new LaunchIoGovernor({ quietWindowMs: 100 });
    initializeTeamHandlers(
      service as never,
      teamHandlerApis,
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
      launchIoGovernor
    );
    registerTeamHandlers(ipcMain as never);
  });

  afterEach(() => {
    resetTeamWatchScopeForTests();
    launchIoGovernor.clearForTests();
    vi.useRealTimers();
    setClaudeBasePathOverride(null);
  });

  it('registers all expected handlers', () => {
    expect(ipcMain.handle).toHaveBeenCalledTimes(TEAM_HANDLER_KEYS.length);
    expect(new Set(handlers.keys())).toEqual(new Set(TEAM_HANDLER_KEYS));
  });

  it('preserves legacy TEAM_LIST and returns contained canonical Phase 2 envelopes', async () => {
    const success = {
      schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
      kind: 'success',
      snapshotRevision: parseRevision(`revision_${'a'.repeat(64)}`),
      items: [
        {
          workspaceId: parseWorkspaceId(`workspace_${'b'.repeat(32)}`),
          teamId: parseTeamId(`team_${'c'.repeat(32)}`),
          displayName: 'my-team',
          lifecycle: 'ready',
          revision: parseRevision(`revision_${'d'.repeat(64)}`),
        },
      ],
      nextCursor: null,
    } satisfies CanonicalListTeamLifecycleResult;
    const listTeamLifecycle = vi.fn(() => Promise.resolve(success));
    initializePhase2TeamReadHandler({ listTeamLifecycle });

    const legacy = await handlers.get(TEAM_LIST)!({} as never);
    expect(legacy).toMatchObject({ success: true, data: [{ teamName: 'my-team' }] });

    const phase2 = await handlers.get(TEAM_LIST)!({} as never, {
      schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
      cursor: null,
      expectedRevision: null,
    });
    expect(phase2).toEqual(success);
    expect(listTeamLifecycle).toHaveBeenCalledTimes(1);

    listTeamLifecycle.mockRejectedValueOnce(new Error('private sqlite diagnostic'));
    const failure = await handlePhase2ListTeamLifecycle({
      schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
      cursor: null,
      expectedRevision: null,
    });
    expect(failure).toEqual({
      schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
      kind: 'failure',
      error: { code: 'unavailable', reason: 'transport_unavailable' },
      retryable: true,
    });
    expect(JSON.stringify(failure)).not.toContain('private sqlite diagnostic');
  });

  it('keeps production legacy TEAM_LIST functional when canonical workspace authority is unavailable', async () => {
    initializePhase2TeamReadHandler(createUnavailablePhase2ReadHost());

    const legacy = await handlers.get(TEAM_LIST)!({} as never);
    expect(legacy).toMatchObject({ success: true, data: [{ teamName: 'my-team' }] });

    const canonical = await handlePhase2ListTeamLifecycle({
      schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
      cursor: null,
      expectedRevision: null,
    });
    expect(canonical).toEqual({
      schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
      kind: 'failure',
      error: { code: 'unavailable', reason: 'identity_storage_unavailable' },
      retryable: true,
    });
  });

  it('preserves narrow facade receivers when auto-resume invokes its IPC dependencies', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-17T12:00:00.000Z'));
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
    const runtimeCalls: string[] = [];
    const sentMessages: string[] = [];
    const runtimeFacade = {
      ...teamHandlerApis.runtime,
      getCurrentRunId(teamName: string): string | null {
        if (this !== runtimeFacade) throw new Error('runtime facade receiver lost');
        runtimeCalls.push(`run:${teamName}`);
        return 'run-receiver';
      },
      isTeamAlive(teamName: string): boolean {
        if (this !== runtimeFacade) throw new Error('runtime facade receiver lost');
        runtimeCalls.push(`alive:${teamName}`);
        return true;
      },
    };
    const messagingFacade = {
      ...teamHandlerApis.messaging,
      sendMessageToTeam(teamName: string, message: string): Promise<void> {
        if (this !== messagingFacade) throw new Error('messaging facade receiver lost');
        sentMessages.push(`${teamName}:${message}`);
        return Promise.resolve();
      },
    };

    try {
      initializeTeamHandlers(service as never, {
        ...teamHandlerApis,
        runtime: runtimeFacade,
        messaging: messagingFacade,
      });

      getAutoResumeService().handleRateLimitMessage(
        'my-team',
        "You've hit your limit. Resets in 1 minute.",
        new Date()
      );
      await vi.advanceTimersByTimeAsync(90_000);

      expect(runtimeCalls).toEqual(['run:my-team', 'alive:my-team', 'run:my-team']);
      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]).toContain('my-team:Your rate limit has reset.');
    } finally {
      getAutoResumeService().clearAllPendingAutoResume();
      getConfigSpy.mockRestore();
    }
  });

  it('forwards selected model checks with effort to prepareProvisioning', async () => {
    const handler = handlers.get(TEAM_PREPARE_PROVISIONING)!;
    const result = (await handler(
      { sender: { send: vi.fn() } } as never,
      os.tmpdir(),
      'anthropic',
      ['anthropic'],
      ['claude-opus-4-6[1m]'],
      false,
      'compatibility',
      [
        {
          providerId: 'anthropic',
          model: 'claude-opus-4-6[1m]',
          effort: 'medium',
        },
      ]
    )) as { success: boolean };

    expect(result.success).toBe(true);
    expect(teamHandlerMocks.prepareForProvisioning).toHaveBeenCalledWith(os.tmpdir(), {
      providerId: 'anthropic',
      providerIds: ['anthropic'],
      modelIds: ['claude-opus-4-6[1m]'],
      limitContext: false,
      modelVerificationMode: 'compatibility',
      modelChecks: [
        {
          providerId: 'anthropic',
          model: 'claude-opus-4-6[1m]',
          effort: 'medium',
        },
      ],
    });
  });

  it('rejects invalid selected model check effort for the provider', async () => {
    const handler = handlers.get(TEAM_PREPARE_PROVISIONING)!;
    const result = (await handler(
      { sender: { send: vi.fn() } } as never,
      os.tmpdir(),
      'anthropic',
      ['anthropic'],
      ['claude-opus-4-6[1m]'],
      false,
      'compatibility',
      [
        {
          providerId: 'anthropic',
          model: 'claude-opus-4-6[1m]',
          effort: 'xhigh',
        },
      ]
    )) as { success: boolean; error: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain('selectedModelChecks effort must be one of');
  });

  it.each([
    { kind: 'omitted', selectedModels: undefined, expectedModelIds: undefined },
    { kind: 'empty', selectedModels: [], expectedModelIds: [] },
    {
      kind: 'trimmed and deduplicated',
      selectedModels: [' model-b ', 'model-a', 'model-b'],
      expectedModelIds: ['model-b', 'model-a'],
    },
  ])('preserves $kind selected model input', async ({ selectedModels, expectedModelIds }) => {
    const handler = handlers.get(TEAM_PREPARE_PROVISIONING)!;
    const result = (await handler(
      { sender: { send: vi.fn() } } as never,
      os.tmpdir(),
      'anthropic',
      ['anthropic'],
      selectedModels
    )) as { success: boolean };

    expect(result.success).toBe(true);
    expect(teamHandlerMocks.prepareForProvisioning).toHaveBeenCalledWith(
      os.tmpdir(),
      expect.objectContaining({ modelIds: expectedModelIds })
    );
  });

  it.each([
    { kind: 'non-string', selectedModels: ['claude-opus-4-6', 42] },
    { kind: 'undefined', selectedModels: ['claude-opus-4-6', undefined] },
    { kind: 'empty', selectedModels: ['claude-opus-4-6', '   '] },
    { kind: 'fully sparse', selectedModels: new Array<string>(2) },
    {
      kind: 'mixed sparse',
      selectedModels: Object.assign(new Array<string>(2), { 0: 'claude-opus-4-6' }),
    },
  ])(
    'rejects $kind selected model entries before preflight dispatch',
    async ({ selectedModels }) => {
      const handler = handlers.get(TEAM_PREPARE_PROVISIONING)!;
      const result = (await handler(
        { sender: { send: vi.fn() } } as never,
        os.tmpdir(),
        'anthropic',
        ['anthropic'],
        selectedModels
      )) as { success: boolean; error: string };

      expect(result).toEqual({
        success: false,
        error: 'selectedModels entries must be non-empty strings',
      });
      expect(teamHandlerMocks.prepareForProvisioning).not.toHaveBeenCalled();
    }
  );

  it('rejects a sparse selected model inherited from Array.prototype before preflight dispatch', async () => {
    const handler = handlers.get(TEAM_PREPARE_PROVISIONING)!;
    const inheritedIndex = 1_000;
    const originalDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, inheritedIndex);
    const selectedModels = Array.from({ length: inheritedIndex + 1 }, () => 'own-model');
    Reflect.deleteProperty(selectedModels, inheritedIndex);

    Object.defineProperty(Array.prototype, inheritedIndex, {
      configurable: true,
      value: 'inherited-model',
      writable: true,
    });
    try {
      const result = (await handler(
        { sender: { send: vi.fn() } } as never,
        os.tmpdir(),
        'anthropic',
        ['anthropic'],
        selectedModels
      )) as { success: boolean; error: string };

      expect(result).toEqual({
        success: false,
        error: 'selectedModels entries must be non-empty strings',
      });
      expect(teamHandlerMocks.prepareForProvisioning).not.toHaveBeenCalled();
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(Array.prototype, inheritedIndex, originalDescriptor);
      } else {
        Reflect.deleteProperty(Array.prototype, inheritedIndex);
      }
    }
  });

  it('rejects a proxy-backed sparse selected model before invoking its get trap or preflight', async () => {
    const handler = handlers.get(TEAM_PREPARE_PROVISIONING)!;
    const getTrap = vi.fn((target: string[], property: string | symbol, receiver: unknown) => {
      if (property === '1') {
        return 'proxy-model';
      }
      return Reflect.get(target, property, receiver);
    });
    const sparseTarget = ['own-model', 'deleted-model', 'later-own-model'];
    Reflect.deleteProperty(sparseTarget, 1);
    const selectedModels = new Proxy(sparseTarget, { get: getTrap });

    const result = (await handler(
      { sender: { send: vi.fn() } } as never,
      os.tmpdir(),
      'anthropic',
      ['anthropic'],
      selectedModels
    )) as { success: boolean; error: string };

    expect(result).toEqual({
      success: false,
      error: 'selectedModels entries must be non-empty strings',
    });
    expect(getTrap.mock.calls.map(([, property]) => property)).not.toContain('1');
    expect(teamHandlerMocks.prepareForProvisioning).not.toHaveBeenCalled();
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

  it('returns stored task attachments with source-code MIME types', async () => {
    const handler = handlers.get(TEAM_GET_TASK_ATTACHMENT);
    expect(handler).toBeDefined();

    const taskId = 'task-js';
    const attachmentId = 'att-js';
    const attachmentDir = path.join(getAppDataPath(), 'task-attachments', 'my-team', taskId);
    await fs.promises.rm(attachmentDir, { recursive: true, force: true });
    await fs.promises.mkdir(attachmentDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(attachmentDir, `${attachmentId}--script.js`),
      'const calculator = 1;\n'
    );

    try {
      const result = (await handler!(
        {} as never,
        'my-team',
        taskId,
        attachmentId,
        'text/javascript'
      )) as { success: boolean; data?: string; error?: string };

      expect(result.success).toBe(true);
      expect(Buffer.from(result.data ?? '', 'base64').toString('utf8')).toBe(
        'const calculator = 1;\n'
      );
    } finally {
      await fs.promises.rm(attachmentDir, { recursive: true, force: true });
    }
  });

  it('returns explicit exact task-log summaries for a task', async () => {
    boardTaskExactLogsService.getTaskExactLogSummaries.mockResolvedValueOnce({
      items: [
        {
          id: TASK_LOG_BUNDLE_ID,
          timestamp: '2026-04-12T16:00:00.000Z',
          actor: {
            memberName: 'alice',
            role: 'member',
            sessionId: 'session-1',
            agentId: 'agent-1',
            isSidechain: true,
          },
          source: {
            filePath: TASK_LOG_JSONL_PATH,
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
        id: TASK_LOG_BUNDLE_ID,
        chunks: [],
      },
    });

    const handler = handlers.get(TEAM_GET_TASK_EXACT_LOG_DETAIL);
    expect(handler).toBeDefined();

    const result = (await handler!(
      {} as never,
      'my-team',
      '123e4567-e89b-12d3-a456-426614174000',
      TASK_LOG_BUNDLE_ID,
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
      TASK_LOG_BUNDLE_ID,
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
      TASK_LOG_BUNDLE_ID,
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

  it('uses Agent Teams MCP reply instructions for Codex user direct messages', async () => {
    teamHandlerMocks.resolveRuntimeRecipientProviderId.mockResolvedValueOnce('codex');
    const sendHandler = handlers.get(TEAM_SEND_MESSAGE);
    expect(sendHandler).toBeDefined();

    const result = (await sendHandler!({} as never, 'my-team', {
      member: 'jack',
      from: ' User ',
      text: 'Здесь?',
    })) as { success: boolean };

    expect(result.success).toBe(true);
    const request = service.sendMessage.mock.calls.at(-1)?.[1] as
      | { from?: string; text?: string; messageId?: string }
      | undefined;
    expect(request).toBeDefined();
    expect(request?.from).toBe('user');
    expect(request?.messageId).toEqual(expect.any(String));
    expect(request?.text).toContain('agent-teams_message_send');
    expect(request?.text).toContain('mcp__agent-teams__message_send');
    expect(request?.text).toContain('teamName="my-team"');
    expect(request?.text).toContain('to="user"');
    expect(request?.text).toContain('from="jack"');
    expect(request?.text).toContain('source="runtime_delivery"');
    expect(request?.text).toContain(`relayOfMessageId="${request?.messageId}"`);
    expect(request?.text).toContain('before any visible-message tool attempt');
    expect(request?.text).not.toContain('tool call fails before sending');
    expect(request?.text).not.toContain('Reply using the SendMessage tool');
  });

  it.each([['anthropic' as const], ['gemini' as const], [undefined]])(
    'keeps SendMessage reply instructions for %s user direct messages',
    async (providerId) => {
      teamHandlerMocks.resolveRuntimeRecipientProviderId.mockResolvedValueOnce(providerId);
      const sendHandler = handlers.get(TEAM_SEND_MESSAGE);
      expect(sendHandler).toBeDefined();

      const result = (await sendHandler!({} as never, 'my-team', {
        member: 'alice',
        text: 'Здесь?',
      })) as { success: boolean };

      expect(result.success).toBe(true);
      const request = service.sendMessage.mock.calls.at(-1)?.[1] as
        | { text?: string; messageId?: string }
        | undefined;
      expect(request).toBeDefined();
      expect(request).not.toHaveProperty('messageId');
      expect(request?.text).toContain('Reply using the SendMessage tool');
      expect(request?.text).toContain('to="user"');
      expect(request?.text).not.toContain('agent-teams_message_send');
    }
  );

  it('stores base text and returns runtimeDelivery success for OpenCode teammate sends', async () => {
    teamHandlerMocks.resolveRuntimeRecipientProviderId.mockResolvedValueOnce('opencode');
    teamHandlerMocks.relayOpenCodeMemberInboxMessages.mockResolvedValueOnce({
      relayed: 1,
      attempted: 1,
      delivered: 1,
      failed: 0,
      lastDelivery: {
        delivered: true,
        accepted: true,
        responsePending: true,
        responseState: 'not_observed',
        ledgerStatus: 'retry_scheduled',
        ledgerRecordId: 'opencode-prompt:test',
        laneId: 'secondary:opencode:bob',
        diagnostics: ['opencode_delivery_response_pending'],
      },
    });
    const sendHandler = handlers.get(TEAM_SEND_MESSAGE);
    expect(sendHandler).toBeDefined();

    const result = (await sendHandler!({} as never, 'my-team', {
      member: 'bob',
      text: 'Can you check this?',
      actionMode: 'ask',
      taskRefs: [{ teamName: 'my-team', taskId: 'task-1', displayId: 'abcd1234' }],
    })) as { success: boolean; data?: SendMessageResult };

    expect(result.success).toBe(true);
    expect(service.sendRuntimeRecipientMessage).toHaveBeenCalledWith(
      'my-team',
      expect.objectContaining({
        member: 'bob',
        text: 'Can you check this?',
      })
    );
    expect(service.sendMessage).not.toHaveBeenCalled();
    expect(service.sendRuntimeRecipientMessage).not.toHaveBeenCalledWith(
      'my-team',
      expect.objectContaining({
        text: expect.stringContaining('SendMessage'),
      })
    );
    expect(teamHandlerMocks.relayOpenCodeMemberInboxMessages).toHaveBeenCalledWith(
      'my-team',
      'bob',
      expect.objectContaining({
        onlyMessageId: 'm1',
        source: 'ui-send',
        deliveryMetadata: expect.objectContaining({
          replyRecipient: 'user',
          actionMode: 'ask',
          taskRefs: [{ teamName: 'my-team', taskId: 'task-1', displayId: 'abcd1234' }],
        }),
      })
    );
    expect(result.data?.runtimeDelivery).toMatchObject({
      providerId: 'opencode',
      attempted: true,
      delivered: true,
      accepted: true,
      responsePending: true,
      responseState: 'not_observed',
      ledgerStatus: 'retry_scheduled',
      ledgerRecordId: 'opencode-prompt:test',
      laneId: 'secondary:opencode:bob',
      diagnostics: ['opencode_delivery_response_pending'],
    });
    expect(teamHandlerMocks.getOpenCodeRuntimeDeliveryStatus).not.toHaveBeenCalled();
  });

  it('hydrates bare OpenCode read-shortcut relay success from durable delivery status', async () => {
    teamHandlerMocks.resolveRuntimeRecipientProviderId.mockResolvedValueOnce('opencode');
    teamHandlerMocks.relayOpenCodeMemberInboxMessages.mockResolvedValueOnce({
      relayed: 0,
      attempted: 1,
      delivered: 1,
      failed: 0,
      lastDelivery: { delivered: true },
    });
    teamHandlerMocks.getOpenCodeRuntimeDeliveryStatus.mockResolvedValueOnce({
      messageId: 'm1',
      providerId: 'opencode',
      attempted: true,
      delivered: true,
      accepted: true,
      responsePending: false,
      responseState: 'responded_visible_message',
      ledgerStatus: 'responded',
      visibleReplyMessageId: 'reply-1',
      visibleReplyCorrelation: 'relayOfMessageId',
      ledgerRecordId: 'opencode-prompt:responded',
      laneId: 'secondary:opencode:bob',
      diagnostics: [],
      userVisibleImpact: { state: 'none' },
    });
    const sendHandler = handlers.get(TEAM_SEND_MESSAGE);
    expect(sendHandler).toBeDefined();

    const result = (await sendHandler!({} as never, 'my-team', {
      member: 'bob',
      text: 'Ping bob',
    })) as { success: boolean; data?: SendMessageResult };

    expect(result.success).toBe(true);
    expect(teamHandlerMocks.getOpenCodeRuntimeDeliveryStatus).toHaveBeenCalledWith('my-team', 'm1');
    expect(result.data?.runtimeDelivery).toMatchObject({
      providerId: 'opencode',
      attempted: true,
      delivered: true,
      accepted: true,
      responsePending: false,
      responseState: 'responded_visible_message',
      ledgerStatus: 'responded',
      visibleReplyMessageId: 'reply-1',
      visibleReplyCorrelation: 'relayOfMessageId',
      ledgerRecordId: 'opencode-prompt:responded',
      laneId: 'secondary:opencode:bob',
      userVisibleImpact: { state: 'none' },
    });
  });

  it('returns runtimeDelivery failure without hiding the persisted OpenCode message', async () => {
    teamHandlerMocks.resolveRuntimeRecipientProviderId.mockResolvedValueOnce('opencode');
    teamHandlerMocks.relayOpenCodeMemberInboxMessages.mockResolvedValueOnce({
      relayed: 0,
      attempted: 1,
      delivered: 0,
      failed: 1,
      lastDelivery: {
        delivered: false,
        reason: 'opencode_runtime_not_active',
        diagnostics: ['opencode_runtime_not_active'],
      },
    });
    const sendHandler = handlers.get(TEAM_SEND_MESSAGE);
    expect(sendHandler).toBeDefined();

    const result = (await sendHandler!({} as never, 'my-team', {
      member: 'bob',
      text: 'Ping bob',
    })) as { success: boolean; data?: SendMessageResult };

    expect(result.success).toBe(true);
    expect(result.data?.deliveredToInbox).toBe(true);
    expect(result.data?.runtimeDelivery).toMatchObject({
      providerId: 'opencode',
      attempted: true,
      delivered: false,
      reason: 'opencode_runtime_not_active',
    });
    expect(vi.mocked(console.warn).mock.calls[0]?.join(' ')).toContain(
      'OpenCode runtime delivery after sendMessage failed for teammate "bob"'
    );
    vi.mocked(console.warn).mockClear();
  });

  it('returns runtimeDelivery acceptanceUnknown for OpenCode observe-pending timeout sends', async () => {
    teamHandlerMocks.resolveRuntimeRecipientProviderId.mockResolvedValueOnce('opencode');
    teamHandlerMocks.relayOpenCodeMemberInboxMessages.mockResolvedValueOnce({
      relayed: 0,
      attempted: 1,
      delivered: 0,
      failed: 0,
      lastDelivery: {
        delivered: true,
        accepted: false,
        responsePending: true,
        acceptanceUnknown: true,
        responseState: 'not_observed',
        ledgerStatus: 'failed_retryable',
        reason: 'opencode_prompt_acceptance_unknown_after_bridge_timeout',
        diagnostics: ['opencode_prompt_acceptance_unknown_after_bridge_timeout'],
      },
    });
    const sendHandler = handlers.get(TEAM_SEND_MESSAGE);
    expect(sendHandler).toBeDefined();

    const result = (await sendHandler!({} as never, 'my-team', {
      member: 'bob',
      text: 'Ping bob',
    })) as { success: boolean; data?: SendMessageResult };

    expect(result.success).toBe(true);
    expect(result.data?.runtimeDelivery).toMatchObject({
      providerId: 'opencode',
      attempted: true,
      delivered: true,
      responsePending: true,
      acceptanceUnknown: true,
      ledgerStatus: 'failed_retryable',
      reason: 'opencode_prompt_acceptance_unknown_after_bridge_timeout',
    });
  });

  it('maps OpenCode UI relay timeout to pending acceptance-unknown delivery', async () => {
    vi.useFakeTimers();
    try {
      teamHandlerMocks.resolveRuntimeRecipientProviderId.mockResolvedValueOnce('opencode');
      teamHandlerMocks.relayOpenCodeMemberInboxMessages.mockReturnValueOnce(
        new Promise(() => undefined)
      );
      teamHandlerMocks.getOpenCodeRuntimeDeliveryStatus.mockResolvedValueOnce(null);
      const sendHandler = handlers.get(TEAM_SEND_MESSAGE);
      expect(sendHandler).toBeDefined();

      const resultPromise = sendHandler!({} as never, 'my-team', {
        member: 'bob',
        text: 'Ping bob',
      }) as Promise<{ success: boolean; data?: SendMessageResult }>;

      await vi.advanceTimersByTimeAsync(6_000);
      const result = await resultPromise;

      expect(result.success).toBe(true);
      expect(result.data?.runtimeDelivery).toMatchObject({
        providerId: 'opencode',
        attempted: true,
        delivered: true,
        responsePending: true,
        acceptanceUnknown: true,
        responseState: 'not_observed',
        reason: 'opencode_runtime_delivery_ui_timeout_pending',
      });
      expect(teamHandlerMocks.getOpenCodeRuntimeDeliveryStatus).toHaveBeenCalledWith(
        'my-team',
        result.data?.messageId
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses durable OpenCode delivery status when UI relay timeout fires after prompt acceptance', async () => {
    vi.useFakeTimers();
    try {
      teamHandlerMocks.resolveRuntimeRecipientProviderId.mockResolvedValueOnce('opencode');
      teamHandlerMocks.relayOpenCodeMemberInboxMessages.mockReturnValueOnce(
        new Promise(() => undefined)
      );
      teamHandlerMocks.getOpenCodeRuntimeDeliveryStatus.mockResolvedValueOnce({
        messageId: 'msg-123',
        providerId: 'opencode',
        attempted: true,
        delivered: true,
        accepted: true,
        responsePending: true,
        responseState: 'not_observed',
        ledgerStatus: 'pending',
        ledgerRecordId: 'opencode-prompt:durable',
        laneId: 'secondary:opencode:bob',
        reason: 'opencode_delivery_response_pending',
        diagnostics: ['prompt accepted'],
        userVisibleImpact: { state: 'none' },
      });
      const sendHandler = handlers.get(TEAM_SEND_MESSAGE);
      expect(sendHandler).toBeDefined();

      const resultPromise = sendHandler!({} as never, 'my-team', {
        member: 'bob',
        text: 'Ping bob',
      }) as Promise<{ success: boolean; data?: SendMessageResult }>;

      await vi.advanceTimersByTimeAsync(6_000);
      const result = await resultPromise;

      expect(result.success).toBe(true);
      expect(result.data?.runtimeDelivery).toMatchObject({
        providerId: 'opencode',
        attempted: true,
        delivered: true,
        accepted: true,
        responsePending: true,
        responseState: 'not_observed',
        ledgerStatus: 'pending',
        ledgerRecordId: 'opencode-prompt:durable',
        laneId: 'secondary:opencode:bob',
        reason: 'opencode_delivery_response_pending',
        diagnostics: ['prompt accepted'],
        userVisibleImpact: { state: 'checking' },
      });
      expect(result.data?.runtimeDelivery?.acceptanceUnknown).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves terminal durable OpenCode delivery status after UI relay timeout', async () => {
    vi.useFakeTimers();
    try {
      teamHandlerMocks.resolveRuntimeRecipientProviderId.mockResolvedValueOnce('opencode');
      teamHandlerMocks.relayOpenCodeMemberInboxMessages.mockReturnValueOnce(
        new Promise(() => undefined)
      );
      teamHandlerMocks.getOpenCodeRuntimeDeliveryStatus.mockResolvedValueOnce({
        messageId: 'msg-responded',
        providerId: 'opencode',
        attempted: true,
        delivered: true,
        accepted: true,
        responsePending: false,
        responseState: 'responded_visible_message',
        ledgerStatus: 'responded',
        visibleReplyMessageId: 'reply-1',
        visibleReplyCorrelation: 'relayOfMessageId',
        ledgerRecordId: 'opencode-prompt:responded',
        laneId: 'secondary:opencode:bob',
        acceptanceUnknown: false,
        diagnostics: [],
        userVisibleImpact: { state: 'none' },
      });
      const sendHandler = handlers.get(TEAM_SEND_MESSAGE);
      expect(sendHandler).toBeDefined();

      const resultPromise = sendHandler!({} as never, 'my-team', {
        member: 'bob',
        text: 'Ping bob',
      }) as Promise<{ success: boolean; data?: SendMessageResult }>;

      await vi.advanceTimersByTimeAsync(6_000);
      const result = await resultPromise;

      expect(result.success).toBe(true);
      expect(result.data?.runtimeDelivery).toMatchObject({
        providerId: 'opencode',
        attempted: true,
        delivered: true,
        accepted: true,
        responsePending: false,
        responseState: 'responded_visible_message',
        ledgerStatus: 'responded',
        visibleReplyMessageId: 'reply-1',
        visibleReplyCorrelation: 'relayOfMessageId',
        ledgerRecordId: 'opencode-prompt:responded',
        laneId: 'secondary:opencode:bob',
        acceptanceUnknown: false,
        userVisibleImpact: { state: 'none' },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not let a slow OpenCode delivery status lookup extend the UI timeout indefinitely', async () => {
    vi.useFakeTimers();
    try {
      teamHandlerMocks.resolveRuntimeRecipientProviderId.mockResolvedValueOnce('opencode');
      teamHandlerMocks.relayOpenCodeMemberInboxMessages.mockReturnValueOnce(
        new Promise(() => undefined)
      );
      teamHandlerMocks.getOpenCodeRuntimeDeliveryStatus.mockReturnValueOnce(
        new Promise(() => undefined)
      );
      const sendHandler = handlers.get(TEAM_SEND_MESSAGE);
      expect(sendHandler).toBeDefined();

      const resultPromise = sendHandler!({} as never, 'my-team', {
        member: 'bob',
        text: 'Ping bob',
      }) as Promise<{ success: boolean; data?: SendMessageResult }>;

      await vi.advanceTimersByTimeAsync(6_000);
      await flushMicrotasks();
      let settled = false;
      void resultPromise.then(() => {
        settled = true;
      });
      await flushMicrotasks();
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1_000);
      const result = await resultPromise;

      expect(result.success).toBe(true);
      expect(result.data?.runtimeDelivery).toMatchObject({
        providerId: 'opencode',
        attempted: true,
        delivered: true,
        responsePending: true,
        acceptanceUnknown: true,
        reason: 'opencode_runtime_delivery_ui_timeout_pending',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to acceptance-unknown when OpenCode delivery status lookup rejects after UI timeout', async () => {
    vi.useFakeTimers();
    try {
      teamHandlerMocks.resolveRuntimeRecipientProviderId.mockResolvedValueOnce('opencode');
      teamHandlerMocks.relayOpenCodeMemberInboxMessages.mockReturnValueOnce(
        new Promise(() => undefined)
      );
      teamHandlerMocks.getOpenCodeRuntimeDeliveryStatus.mockRejectedValueOnce(
        new Error('status read failed')
      );
      const sendHandler = handlers.get(TEAM_SEND_MESSAGE);
      expect(sendHandler).toBeDefined();

      const resultPromise = sendHandler!({} as never, 'my-team', {
        member: 'bob',
        text: 'Ping bob',
      }) as Promise<{ success: boolean; data?: SendMessageResult }>;

      await vi.advanceTimersByTimeAsync(6_000);
      const result = await resultPromise;

      expect(result.success).toBe(true);
      expect(result.data?.runtimeDelivery).toMatchObject({
        providerId: 'opencode',
        attempted: true,
        delivered: true,
        responsePending: true,
        acceptanceUnknown: true,
        reason: 'opencode_runtime_delivery_ui_timeout_pending',
        diagnostics: [
          'opencode_runtime_delivery_ui_timeout_pending',
          'opencode_runtime_delivery_ui_timeout_pending: status lookup failed: status read failed',
        ],
      });
      expect(
        vi
          .mocked(console.warn)
          .mock.calls.some((call) => call.join(' ').includes('status after UI timeout failed'))
      ).toBe(true);
      vi.mocked(console.warn).mockClear();
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs OpenCode relay rejection that happens after the UI timeout fallback', async () => {
    vi.useFakeTimers();
    try {
      const deferredRelay =
        createDeferred<
          Awaited<ReturnType<typeof teamHandlerMocks.relayOpenCodeMemberInboxMessages>>
        >();
      teamHandlerMocks.resolveRuntimeRecipientProviderId.mockResolvedValueOnce('opencode');
      teamHandlerMocks.relayOpenCodeMemberInboxMessages.mockReturnValueOnce(deferredRelay.promise);
      teamHandlerMocks.getOpenCodeRuntimeDeliveryStatus.mockResolvedValueOnce(null);
      const sendHandler = handlers.get(TEAM_SEND_MESSAGE);
      expect(sendHandler).toBeDefined();

      const resultPromise = sendHandler!({} as never, 'my-team', {
        member: 'bob',
        text: 'Ping bob',
      }) as Promise<{ success: boolean; data?: SendMessageResult }>;

      await vi.advanceTimersByTimeAsync(6_000);
      await expect(resultPromise).resolves.toMatchObject({ success: true });

      deferredRelay.reject(new Error('late bridge failure'));
      await flushMicrotasks();

      expect(
        vi
          .mocked(console.warn)
          .mock.calls.some((call) => call.join(' ').includes('rejected after UI timeout'))
      ).toBe(true);
      vi.mocked(console.warn).mockClear();
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs OpenCode relay failure result that resolves after the UI timeout fallback', async () => {
    vi.useFakeTimers();
    try {
      const deferredRelay =
        createDeferred<
          Awaited<ReturnType<typeof teamHandlerMocks.relayOpenCodeMemberInboxMessages>>
        >();
      teamHandlerMocks.resolveRuntimeRecipientProviderId.mockResolvedValueOnce('opencode');
      teamHandlerMocks.relayOpenCodeMemberInboxMessages.mockReturnValueOnce(deferredRelay.promise);
      teamHandlerMocks.getOpenCodeRuntimeDeliveryStatus.mockResolvedValueOnce(null);
      const sendHandler = handlers.get(TEAM_SEND_MESSAGE);
      expect(sendHandler).toBeDefined();

      const resultPromise = sendHandler!({} as never, 'my-team', {
        member: 'bob',
        text: 'Ping bob',
      }) as Promise<{ success: boolean; data?: SendMessageResult }>;

      await vi.advanceTimersByTimeAsync(6_000);
      await expect(resultPromise).resolves.toMatchObject({ success: true });

      deferredRelay.resolve({
        relayed: 0,
        attempted: 1,
        delivered: 0,
        failed: 1,
        lastDelivery: {
          delivered: false,
          reason: 'late_runtime_failure',
          diagnostics: ['late_runtime_failure'],
        },
      });
      await flushMicrotasks();

      expect(
        vi
          .mocked(console.warn)
          .mock.calls.some((call) => call.join(' ').includes('completed after UI timeout'))
      ).toBe(true);
      vi.mocked(console.warn).mockClear();
    } finally {
      vi.useRealTimers();
    }
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
    expect(teamHandlerMocks.sendMessageToTeam).toHaveBeenCalledWith(
      'my-team',
      expect.stringContaining('TURN ACTION MODE: ASK'),
      undefined
    );
    expect(teamHandlerMocks.sendMessageToTeam).toHaveBeenCalledWith(
      'my-team',
      expect.stringContaining(
        'FORBIDDEN: editing files, changing code, changing task/board state, delegating work, launching Agent/subagents'
      ),
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
    expect(teamHandlerMocks.sendMessageToTeam).toHaveBeenCalledWith(
      'my-team',
      expect.stringContaining('Current durable team context:'),
      undefined
    );
    expect(teamHandlerMocks.sendMessageToTeam).toHaveBeenCalledWith(
      'my-team',
      expect.stringContaining(
        'Persistent teammates currently configured: alice (reviewer), jack (developer)'
      ),
      undefined
    );
    expect(teamHandlerMocks.sendMessageToTeam).toHaveBeenCalledWith(
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
    expect(teamHandlerMocks.sendMessageToTeam).toHaveBeenCalledWith(
      'my-team',
      expect.stringContaining('DELEGATE MODE USER ACK CONTRACT:'),
      undefined
    );
    expect(teamHandlerMocks.sendMessageToTeam).toHaveBeenCalledWith(
      'my-team',
      expect.stringContaining(
        'Make the acknowledgement at least 40 characters so it is preserved in the Messages panel.'
      ),
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
    const stdinCall = vi.mocked(teamHandlerMocks.sendMessageToTeam).mock.calls[0] as
      | unknown[]
      | undefined;
    expect(secondMockArgString(stdinCall)).not.toContain('Current durable team context:');
  });

  it('sends standalone slash commands to lead stdin without the UI routing wrapper', async () => {
    const sendHandler = handlers.get(TEAM_SEND_MESSAGE);
    expect(sendHandler).toBeDefined();

    const result = (await sendHandler!({} as never, 'my-team', {
      member: 'team-lead',
      text: '  /COMPACT keep kanban  ',
    })) as { success: boolean };

    expect(result.success).toBe(true);
    expect(teamHandlerMocks.sendMessageToTeam).toHaveBeenCalledWith(
      'my-team',
      '/COMPACT keep kanban',
      undefined
    );
    const compactCall = vi.mocked(teamHandlerMocks.sendMessageToTeam).mock.calls as unknown[][];
    const [firstCompactCall] = compactCall;
    expect(secondMockArgString(firstCompactCall)).not.toContain(
      'You received a direct message from the user'
    );
    expect(secondMockArgString(firstCompactCall)).not.toContain('Current durable team context:');
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
    expect(teamHandlerMocks.sendMessageToTeam).toHaveBeenCalledWith(
      'my-team',
      '/foo bar',
      undefined
    );
    const unknownSlashCall = vi.mocked(teamHandlerMocks.sendMessageToTeam).mock
      .calls as unknown[][];
    const [firstUnknownSlashCall] = unknownSlashCall;
    expect(secondMockArgString(firstUnknownSlashCall)).not.toContain(
      'You received a direct message from the user'
    );
    expect(secondMockArgString(firstUnknownSlashCall)).not.toContain(
      'Current durable team context:'
    );
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
      expect(teamHandlerMocks.sendMessageToTeam).toHaveBeenCalledWith(
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

  it('preserves attachment delivery errors when the lead process is still alive', async () => {
    const sendHandler = handlers.get(TEAM_SEND_MESSAGE);
    expect(sendHandler).toBeDefined();
    teamHandlerMocks.isTeamAlive.mockReturnValue(true);
    teamHandlerMocks.sendMessageToTeam.mockRejectedValueOnce(
      new Error('Claude attachment MIME unsupported: image/avif')
    );

    const result = (await sendHandler!({} as never, 'my-team', {
      member: 'team-lead',
      text: 'see this',
      attachments: [
        {
          id: 'att-1',
          filename: 'screenshot.png',
          mimeType: 'image/png',
          size: 4,
          data: Buffer.from('test').toString('base64'),
        },
      ],
    })) as { success: boolean; error?: string };

    expect(result.success).toBe(false);
    expect(result.error).toBe(
      'Failed to deliver message with attachments: Claude attachment MIME unsupported: image/avif'
    );
    expect(result.error).not.toContain('team process became unavailable');
    expect(service.sendDirectToLead).not.toHaveBeenCalled();
    vi.mocked(console.error).mockClear();
  });

  it('reports attachment delivery as unavailable only when liveness confirms it', async () => {
    const sendHandler = handlers.get(TEAM_SEND_MESSAGE);
    expect(sendHandler).toBeDefined();
    teamHandlerMocks.isTeamAlive.mockReturnValueOnce(true).mockReturnValueOnce(false);
    teamHandlerMocks.sendMessageToTeam.mockRejectedValueOnce(new Error('write EPIPE'));

    const result = (await sendHandler!({} as never, 'my-team', {
      member: 'team-lead',
      text: 'see this',
      attachments: [
        {
          id: 'att-1',
          filename: 'screenshot.png',
          mimeType: 'image/png',
          size: 4,
          data: Buffer.from('test').toString('base64'),
        },
      ],
    })) as { success: boolean; error?: string };

    expect(result.success).toBe(false);
    expect(result.error).toBe(
      'Failed to deliver message with attachments: team process became unavailable'
    );
    expect(service.sendDirectToLead).not.toHaveBeenCalled();
    vi.mocked(console.error).mockClear();
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
    expect(teamHandlerMocks.createTeam).toHaveBeenCalledTimes(1);

    const statusResult = (await handlers.get(TEAM_PROVISIONING_STATUS)!({} as never, 'run-1')) as {
      success: boolean;
    };
    expect(statusResult.success).toBe(true);
    expect(teamHandlerMocks.getProvisioningStatus).toHaveBeenCalledWith('run-1');

    const cancelResult = (await handlers.get(TEAM_CANCEL_PROVISIONING)!({} as never, 'run-1')) as {
      success: boolean;
    };
    expect(cancelResult.success).toBe(true);
    expect(teamHandlerMocks.cancelProvisioning).toHaveBeenCalledWith('run-1');

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

  it('marks created teams engaged before provisioning writes startup artifacts', async () => {
    const createTeam = 'created-watch-scope';
    teamHandlerMocks.createTeam.mockImplementationOnce(() => {
      expect(computeTeamWatchScope()?.has(createTeam)).toBe(true);
      return resolved({ runId: 'run-created-watch-scope' });
    });

    const result = (await handlers.get(TEAM_CREATE)!({ sender: { send: vi.fn() } } as never, {
      teamName: createTeam,
      members: [{ name: 'alice' }],
      cwd: os.tmpdir(),
    })) as { success: boolean };

    expect(result.success).toBe(true);
    expect(computeTeamWatchScope()?.has(createTeam)).toBe(true);
  });

  it('returns cached TEAM_LIST data under active launch pressure without starting another scan', async () => {
    const first = (await handlers.get(TEAM_LIST)!({} as never)) as {
      success: boolean;
      data: { teamName: string }[];
    };
    expect(first.success).toBe(true);
    expect(first.data).toEqual([{ teamName: 'my-team', displayName: 'My Team' }]);

    service.listTeams.mockResolvedValueOnce([{ teamName: 'fresh-team', displayName: 'Fresh' }]);
    launchIoGovernor.noteLaunchIntent('my-team', 'test');

    const second = (await handlers.get(TEAM_LIST)!({} as never)) as {
      success: boolean;
      data: { teamName: string }[];
    };

    expect(second.success).toBe(true);
    expect(second.data).toEqual([{ teamName: 'my-team', displayName: 'My Team' }]);
    expect(service.listTeams).toHaveBeenCalledTimes(1);
  });

  it('returns cached TEAM_GET_ALL_TASKS data under active launch pressure without starting another scan', async () => {
    const first = (await handlers.get(TEAM_GET_ALL_TASKS)!({} as never)) as {
      success: boolean;
      data: { id: string }[];
    };
    expect(first.success).toBe(true);
    expect(first.data).toEqual([{ id: 'task-1', teamName: 'my-team', subject: 'Task 1' }]);

    service.getAllTasks.mockResolvedValueOnce([
      { id: 'task-2', teamName: 'my-team', subject: 'Task 2' },
    ]);
    launchIoGovernor.noteLaunchIntent('my-team', 'test');

    const second = (await handlers.get(TEAM_GET_ALL_TASKS)!({} as never)) as {
      success: boolean;
      data: { id: string }[];
    };

    expect(second.success).toBe(true);
    expect(second.data).toEqual([{ id: 'task-1', teamName: 'my-team', subject: 'Task 1' }]);
    expect(service.getAllTasks).toHaveBeenCalledTimes(1);
  });

  it('keeps current fresh behavior for TEAM_LIST when launch pressure has no cached data', async () => {
    launchIoGovernor.clearForTests();
    launchIoGovernor.noteLaunchIntent('my-team', 'test');

    const result = (await handlers.get(TEAM_LIST)!({} as never)) as {
      success: boolean;
      data: { teamName: string }[];
    };

    expect(result.success).toBe(true);
    expect(result.data).toEqual([{ teamName: 'my-team', displayName: 'My Team' }]);
    expect(service.listTeams).toHaveBeenCalledTimes(1);
  });

  it('flushes TEAM_LIST once after terminal provisioning progress quiet window', async () => {
    vi.useFakeTimers();
    const first = (await handlers.get(TEAM_LIST)!({} as never)) as {
      success: boolean;
    };
    expect(first.success).toBe(true);

    service.listTeams.mockResolvedValue([{ teamName: 'fresh-team', displayName: 'Fresh' }]);
    launchIoGovernor.noteLaunchIntent('my-team', 'test');
    await handlers.get(TEAM_LIST)!({} as never);
    launchIoGovernor.noteProvisioningProgress({
      runId: 'run-1',
      teamName: 'my-team',
      state: 'ready',
      message: 'ready',
      startedAt: '2026-05-02T00:00:00.000Z',
      updatedAt: '2026-05-02T00:00:00.000Z',
    } as TeamProvisioningProgress);

    await vi.advanceTimersByTimeAsync(100);
    await flushMicrotasks();
    expect(service.listTeams).toHaveBeenCalledTimes(2);
  });

  it('does not let provisioning status polling activate launch IO stale mode', async () => {
    const first = (await handlers.get(TEAM_LIST)!({} as never)) as {
      success: boolean;
      data: { teamName: string }[];
    };
    expect(first.success).toBe(true);

    service.listTeams.mockResolvedValueOnce([{ teamName: 'fresh-team', displayName: 'Fresh' }]);
    const status = (await handlers.get(TEAM_PROVISIONING_STATUS)!({} as never, 'run-1')) as {
      success: boolean;
    };
    expect(status.success).toBe(true);

    const second = (await handlers.get(TEAM_LIST)!({} as never)) as {
      success: boolean;
      data: { teamName: string }[];
    };
    expect(second.success).toBe(true);
    expect(second.data).toEqual([{ teamName: 'fresh-team', displayName: 'Fresh' }]);
    expect(service.listTeams).toHaveBeenCalledTimes(2);
  });

  it('clears launch IO pressure when create fails before first provisioning progress', async () => {
    vi.useFakeTimers();
    const first = (await handlers.get(TEAM_LIST)!({} as never)) as {
      success: boolean;
    };
    expect(first.success).toBe(true);
    teamHandlerMocks.createTeam.mockRejectedValueOnce(new Error('bootstrap failed early'));
    service.listTeams
      .mockResolvedValueOnce([{ teamName: 'background-fresh', displayName: 'Background Fresh' }])
      .mockResolvedValueOnce([{ teamName: 'fresh-team', displayName: 'Fresh' }]);

    const createResult = (await handlers.get(TEAM_CREATE)!({ sender: { send: vi.fn() } } as never, {
      teamName: 'my-team',
      members: [{ name: 'alice' }],
      cwd: os.tmpdir(),
    })) as { success: boolean };
    expect(createResult.success).toBe(false);
    vi.mocked(console.error).mockClear();

    await vi.advanceTimersByTimeAsync(100);
    await flushMicrotasks();
    const second = (await handlers.get(TEAM_LIST)!({} as never)) as {
      success: boolean;
      data: { teamName: string }[];
    };
    expect(second.success).toBe(true);
    expect(second.data).toEqual([{ teamName: 'fresh-team', displayName: 'Fresh' }]);
    expect(service.listTeams).toHaveBeenCalledTimes(3);
  });

  it('does not route TEAM_GET_MESSAGES_PAGE through the launch IO governor', async () => {
    launchIoGovernor.noteLaunchIntent('my-team', 'test');

    const result = (await handlers.get(TEAM_GET_MESSAGES_PAGE)!({} as never, 'my-team', {
      limit: 50,
    })) as { success: boolean; data?: { feedRevision: string } };

    expect(result.success).toBe(true);
    expect(result.data?.feedRevision).toBe('rev-1');
    expect(service.getMessagesPage).toHaveBeenCalledTimes(1);
  });

  it('keeps TEAM_GET_DATA structural and does not expose message transport', async () => {
    teamHandlerMocks.getLiveLeadProcessMessages.mockReturnValueOnce([
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

  it('does not fall back TEAM_GET_DATA to main after worker OOM', async () => {
    mockTeamDataWorkerClient.isAvailable.mockReturnValue(true);
    mockTeamDataWorkerClient.getTeamData.mockRejectedValueOnce(
      new Error('Worker terminated due to reaching memory limit: JS heap out of memory')
    );

    const handler = handlers.get(TEAM_GET_DATA)!;
    const result = (await handler({} as never, 'my-team')) as {
      success: boolean;
      error?: string;
    };
    vi.mocked(console.error).mockClear();

    expect(result.success).toBe(false);
    expect(result.error).toContain('TEAM_DATA_WORKER_FAILED');
    expect(service.getTeamData).not.toHaveBeenCalled();
  });

  it('forwards thin TEAM_GET_DATA options to the worker without changing full request shape', async () => {
    mockTeamDataWorkerClient.isAvailable.mockReturnValue(true);
    mockTeamDataWorkerClient.getTeamData.mockResolvedValueOnce({
      teamName: 'my-team',
      config: { name: 'My Team' },
      tasks: [],
      members: [],
      kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
      processes: [],
    });

    const handler = handlers.get(TEAM_GET_DATA)!;
    const result = (await handler({} as never, 'my-team', {
      includeMemberBranches: false,
    })) as {
      success: boolean;
      data?: { teamName: string };
    };

    expect(result.success).toBe(true);
    expect(result.data?.teamName).toBe('my-team');
    expect(mockTeamDataWorkerClient.getTeamData).toHaveBeenCalledWith('my-team', {
      includeMemberBranches: false,
    });
    expect(service.getTeamData).not.toHaveBeenCalled();
  });

  it('repairs stale task activity before reading TEAM_GET_DATA through the worker', async () => {
    mockTeamDataWorkerClient.isAvailable.mockReturnValue(true);
    mockTeamDataWorkerClient.getTeamData.mockResolvedValueOnce({
      teamName: 'my-team',
      config: { name: 'My Team' },
      tasks: [],
      members: [],
      kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
      processes: [],
    });

    const handler = handlers.get(TEAM_GET_DATA)!;
    const result = (await handler({} as never, 'my-team')) as {
      success: boolean;
      data?: { teamName: string };
    };

    expect(result.success).toBe(true);
    expect(teamHandlerMocks.repairStaleTaskActivityIntervalsBeforeSnapshot).toHaveBeenCalledWith(
      'my-team'
    );
    expect(
      teamHandlerMocks.repairStaleTaskActivityIntervalsBeforeSnapshot.mock.invocationCallOrder[0]
    ).toBeLessThan(mockTeamDataWorkerClient.getTeamData.mock.invocationCallOrder[0]);
  });

  it('normalizes explicit full TEAM_GET_DATA options to the existing one-argument call shape', async () => {
    mockTeamDataWorkerClient.isAvailable.mockReturnValue(true);
    mockTeamDataWorkerClient.getTeamData.mockResolvedValueOnce({
      teamName: 'my-team',
      config: { name: 'My Team' },
      tasks: [],
      members: [],
      kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
      processes: [],
    });

    const handler = handlers.get(TEAM_GET_DATA)!;
    const result = (await handler({} as never, 'my-team', {
      includeMemberBranches: true,
    })) as {
      success: boolean;
      data?: { teamName: string };
    };

    expect(result.success).toBe(true);
    expect(mockTeamDataWorkerClient.getTeamData).toHaveBeenCalledWith('my-team');
  });

  it('forwards thin TEAM_GET_DATA options through packaged main-thread fallback', async () => {
    const electron = await import('electron');
    mockTeamDataWorkerClient.isAvailable.mockReturnValue(false);
    (electron.app as { isPackaged: boolean }).isPackaged = true;

    const handler = handlers.get(TEAM_GET_DATA)!;
    const result = (await handler({} as never, 'my-team', {
      includeMemberBranches: false,
    })) as {
      success: boolean;
      data?: { teamName: string };
    };

    expect(result.success).toBe(true);
    expect(service.getTeamData).toHaveBeenCalledWith('my-team', {
      includeMemberBranches: false,
    });
    vi.mocked(console.error).mockClear();

    (electron.app as { isPackaged: boolean }).isPackaged = false;
  });

  it('rejects malformed TEAM_GET_DATA options before dispatching to service or worker', async () => {
    const handler = handlers.get(TEAM_GET_DATA)!;
    const result = (await handler({} as never, 'my-team', {
      includeMemberBranches: 'false',
    })) as {
      success: boolean;
      error?: string;
    };

    expect(result.success).toBe(false);
    expect(result.error).toContain('includeMemberBranches');
    expect(mockTeamDataWorkerClient.getTeamData).not.toHaveBeenCalled();
    expect(service.getTeamData).not.toHaveBeenCalled();
  });

  it.each([
    ['null options', null, 'options must be an object'],
    ['array options', [], 'options must be an object'],
    ['unknown option key', { includeMemberBranches: false, thin: true }, 'Unknown getData option'],
  ])(
    'rejects malformed TEAM_GET_DATA %s before dispatching to service or worker',
    async (_label, rawOptions, expectedError) => {
      const handler = handlers.get(TEAM_GET_DATA)!;
      const result = (await handler({} as never, 'my-team', rawOptions)) as {
        success: boolean;
        error?: string;
      };

      expect(result.success).toBe(false);
      expect(result.error).toContain(expectedError);
      expect(mockTeamDataWorkerClient.getTeamData).not.toHaveBeenCalled();
      expect(service.getTeamData).not.toHaveBeenCalled();
    }
  );

  it('classifies draft teams before asking the team-data worker for a full snapshot', async () => {
    const claudeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-draft-get-data-'));
    setClaudeBasePathOverride(claudeRoot);
    const teamDir = path.join(claudeRoot, 'teams', 'draft-team');
    await fs.promises.mkdir(teamDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(teamDir, 'team.meta.json'),
      JSON.stringify({
        version: 1,
        cwd: DRAFT_TEAM_CWD,
        createdAt: Date.now(),
      })
    );
    mockTeamDataWorkerClient.isAvailable.mockReturnValue(true);

    try {
      const handler = handlers.get(TEAM_GET_DATA)!;
      const result = (await handler({} as never, 'draft-team')) as {
        success: boolean;
        error?: string;
      };

      expect(result).toEqual({ success: false, error: 'TEAM_DRAFT' });
      expect(mockTeamDataWorkerClient.getTeamData).not.toHaveBeenCalled();
      expect(service.getTeamData).not.toHaveBeenCalledWith('draft-team');
    } finally {
      await fs.promises.rm(claudeRoot, { recursive: true, force: true });
      setClaudeBasePathOverride(null);
    }
  });

  it('classifies draft teams before falling back to main-thread getTeamData', async () => {
    const claudeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-draft-main-get-data-'));
    setClaudeBasePathOverride(claudeRoot);
    const teamDir = path.join(claudeRoot, 'teams', 'draft-team');
    await fs.promises.mkdir(teamDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(teamDir, 'team.meta.json'),
      JSON.stringify({
        version: 1,
        cwd: DRAFT_TEAM_CWD,
        createdAt: Date.now(),
      })
    );
    mockTeamDataWorkerClient.isAvailable.mockReturnValue(false);

    try {
      const handler = handlers.get(TEAM_GET_DATA)!;
      const result = (await handler({} as never, 'draft-team')) as {
        success: boolean;
        error?: string;
      };

      expect(result).toEqual({ success: false, error: 'TEAM_DRAFT' });
      expect(mockTeamDataWorkerClient.getTeamData).not.toHaveBeenCalled();
      expect(service.getTeamData).not.toHaveBeenCalledWith('draft-team');
    } finally {
      await fs.promises.rm(claudeRoot, { recursive: true, force: true });
      setClaudeBasePathOverride(null);
    }
  });

  it('does not let slow draft metadata classification block normal getData fallback', async () => {
    const claudeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-draft-slow-meta-'));
    setClaudeBasePathOverride(claudeRoot);
    const teamDir = path.join(claudeRoot, 'teams', 'slow-meta-team');
    await fs.promises.mkdir(teamDir, { recursive: true });
    const { TeamMetaStore } = await import('../../../src/main/services/team/TeamMetaStore');
    const metaSpy = vi
      .spyOn(TeamMetaStore.prototype, 'getMeta')
      .mockImplementation(() => new Promise(() => undefined));
    mockTeamDataWorkerClient.isAvailable.mockReturnValue(true);
    mockTeamDataWorkerClient.getTeamData.mockResolvedValueOnce({
      teamName: 'slow-meta-team',
      config: { name: 'Slow Meta Team' },
      tasks: [],
      members: [],
      kanbanState: { teamName: 'slow-meta-team', reviewers: [], tasks: {} },
      processes: [],
    });

    try {
      const startedAt = Date.now();
      const handler = handlers.get(TEAM_GET_DATA)!;
      const result = (await handler({} as never, 'slow-meta-team')) as {
        success: boolean;
        data?: { teamName: string };
      };

      expect(Date.now() - startedAt).toBeLessThan(1500);
      expect(result.success).toBe(true);
      expect(result.data?.teamName).toBe('slow-meta-team');
      expect(mockTeamDataWorkerClient.getTeamData).toHaveBeenCalledWith('slow-meta-team');
    } finally {
      metaSpy.mockRestore();
      await fs.promises.rm(claudeRoot, { recursive: true, force: true });
      setClaudeBasePathOverride(null);
    }
  });

  it('does not let slow draft metadata classification block Team not found fallback', async () => {
    const claudeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-draft-slow-missing-meta-'));
    setClaudeBasePathOverride(claudeRoot);
    const teamDir = path.join(claudeRoot, 'teams', 'slow-missing-team');
    await fs.promises.mkdir(teamDir, { recursive: true });
    const { TeamMetaStore } = await import('../../../src/main/services/team/TeamMetaStore');
    const metaSpy = vi
      .spyOn(TeamMetaStore.prototype, 'getMeta')
      .mockImplementation(() => new Promise(() => undefined));
    mockTeamDataWorkerClient.isAvailable.mockReturnValue(false);
    service.getTeamData.mockRejectedValueOnce(new Error('Team not found: slow-missing-team'));

    try {
      const startedAt = Date.now();
      const handler = handlers.get(TEAM_GET_DATA)!;
      const result = (await handler({} as never, 'slow-missing-team')) as {
        success: boolean;
        error?: string;
      };

      expect(Date.now() - startedAt).toBeLessThan(1500);
      expect(result).toEqual({ success: false, error: 'Team not found: slow-missing-team' });
      expect(service.getTeamData).toHaveBeenCalledWith('slow-missing-team');
      vi.mocked(console.error).mockClear();
    } finally {
      metaSpy.mockRestore();
      await fs.promises.rm(claudeRoot, { recursive: true, force: true });
      setClaudeBasePathOverride(null);
    }
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
      teamHandlerMocks.isTeamAlive.mockReturnValue(true);
      teamHandlerMocks.getCurrentLeadSessionId.mockReturnValue('sess-123');
      teamHandlerMocks.sendMessageToTeam.mockResolvedValue(undefined);
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
      teamHandlerMocks.getLiveLeadProcessMessages.mockReturnValueOnce([
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
      expect(teamHandlerMocks.sendMessageToTeam).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1100);
      expect(teamHandlerMocks.sendMessageToTeam).toHaveBeenCalledTimes(1);
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

  it('keeps live message overlay on TEAM_GET_MESSAGES_PAGE in worker path', async () => {
    mockTeamDataWorkerClient.isAvailable.mockReturnValue(true);
    const liveMessage: InboxMessage = {
      from: 'team-lead',
      text: 'Команда поднята, приступаю к раздаче задач.',
      timestamp: '2026-02-23T10:00:01.000Z',
      read: true,
      source: 'lead_process' as const,
      messageId: 'live-1',
    };
    mockTeamDataWorkerClient.getMessagesPage.mockResolvedValueOnce({
      messages: [
        {
          from: 'user',
          text: 'Ping',
          timestamp: '2026-02-23T10:00:00.000Z',
          read: true,
          source: 'user_sent' as const,
          messageId: 'durable-1',
        },
      ],
      nextCursor: null,
      hasMore: false,
      feedRevision: 'rev-worker',
    });
    teamHandlerMocks.getLiveLeadProcessMessages.mockReturnValueOnce([liveMessage]);

    const handler = handlers.get(TEAM_GET_MESSAGES_PAGE)!;
    const result = (await handler({} as never, 'my-team', {
      limit: 20,
    })) as { success: boolean; data: MessagesPage };

    expect(result.success).toBe(true);
    expect(result.data.messages.map((message) => message.messageId)).toEqual([
      'live-1',
      'durable-1',
    ]);
    expect(result.data.feedRevision).toBe('rev-worker');
    expect(mockTeamDataWorkerClient.getMessagesPage).toHaveBeenCalledWith('my-team', {
      cursor: undefined,
      limit: 121,
    });
    expect(service.getMessagesPage).not.toHaveBeenCalled();
  });

  it('caps live message overlay before merging newest page results from the worker', async () => {
    mockTeamDataWorkerClient.isAvailable.mockReturnValue(true);
    const liveMessages: InboxMessage[] = Array.from({ length: 205 }, (_, index) => ({
      from: 'team-lead',
      text: `Live thought ${index}`,
      timestamp: new Date(Date.UTC(2026, 1, 23, 10, 0, index)).toISOString(),
      read: true,
      source: 'lead_process' as const,
      messageId: `live-${index}`,
    }));
    mockTeamDataWorkerClient.getMessagesPage.mockResolvedValueOnce({
      messages: [],
      nextCursor: null,
      hasMore: false,
      feedRevision: 'rev-worker',
    });
    teamHandlerMocks.getLiveLeadProcessMessages.mockReturnValueOnce(liveMessages);

    const handler = handlers.get(TEAM_GET_MESSAGES_PAGE)!;
    const result = (await handler({} as never, 'my-team', {
      limit: 20,
    })) as { success: boolean; data: MessagesPage };

    expect(result.success).toBe(true);
    const workerOptions = mockTeamDataWorkerClient.getMessagesPage.mock.calls[0]?.[1] as {
      liveMessages?: InboxMessage[];
      limit: number;
    };
    expect(workerOptions.limit).toBe(221);
    expect(workerOptions.liveMessages).toBeUndefined();
    expect(result.data.messages.map((message) => message.messageId)).toContain('live-204');
    expect(result.data.messages.map((message) => message.messageId)).toContain('live-185');
    expect(result.data.messages.map((message) => message.messageId)).not.toContain('live-184');
    expect(result.data.messages.map((message) => message.messageId)).not.toContain('live-4');
    expect(service.getMessagesPage).not.toHaveBeenCalled();
  });

  it('does not fall back live TEAM_GET_MESSAGES_PAGE overlay to main after worker OOM', async () => {
    mockTeamDataWorkerClient.isAvailable.mockReturnValue(true);
    const liveMessage: InboxMessage = {
      from: 'team-lead',
      text: 'Команда поднята, приступаю к раздаче задач.',
      timestamp: '2026-02-23T10:00:01.000Z',
      read: true,
      source: 'lead_process' as const,
      messageId: 'live-1',
    };
    mockTeamDataWorkerClient.getMessagesPage.mockRejectedValueOnce(
      new Error('Worker terminated due to reaching memory limit: JS heap out of memory')
    );
    teamHandlerMocks.getLiveLeadProcessMessages.mockReturnValueOnce([liveMessage]);

    const handler = handlers.get(TEAM_GET_MESSAGES_PAGE)!;
    const result = (await handler({} as never, 'my-team', {
      limit: 20,
    })) as { success: boolean; error?: string };
    vi.mocked(console.error).mockClear();

    expect(result.success).toBe(false);
    expect(result.error).toContain('TEAM_DATA_WORKER_FAILED');
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
    await flushMicrotasks();
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

  it('does not block TEAM_GET_MESSAGES_PAGE on notification context reads', async () => {
    mockTeamDataWorkerClient.isAvailable.mockReturnValue(true);
    mockTeamDataWorkerClient.getMessagesPage.mockResolvedValueOnce({
      messages: [
        {
          from: 'team-lead',
          text: "You've hit your limit. Please wait a bit before retrying.",
          timestamp: '2026-02-23T10:00:01.000Z',
          read: true,
          source: 'lead_session' as const,
          messageId: 'msg-rate-limit-nonblocking',
        },
      ],
      nextCursor: null,
      hasMore: false,
      feedRevision: 'rev-worker',
    });
    const context = createDeferred<{ displayName: string; projectPath: string }>();
    service.getTeamNotificationContext.mockReturnValueOnce(context.promise);

    const handler = handlers.get(TEAM_GET_MESSAGES_PAGE)!;
    const result = (await handler({} as never, 'my-team', {
      limit: 50,
    })) as { success: boolean; data: { feedRevision: string } };

    expect(result.success).toBe(true);
    expect(result.data.feedRevision).toBe('rev-worker');
    expect(mockAddTeamNotification).not.toHaveBeenCalled();

    context.resolve({ displayName: 'My Team', projectPath: TEST_PROJECT_PATH });
    await flushMicrotasks();
    expect(mockAddTeamNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        teamEventType: 'rate_limit',
        teamName: 'my-team',
        teamDisplayName: 'My Team',
        dedupeKey: 'rate-limit:my-team:msg-rate-limit-nonblocking',
      })
    );
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

  it('does not fall back TEAM_GET_MESSAGES_PAGE to main after worker OOM', async () => {
    mockTeamDataWorkerClient.isAvailable.mockReturnValue(true);
    mockTeamDataWorkerClient.getMessagesPage.mockRejectedValueOnce(
      new Error('Worker terminated due to reaching memory limit: JS heap out of memory')
    );

    const handler = handlers.get(TEAM_GET_MESSAGES_PAGE)!;
    const result = (await handler({} as never, 'my-team', {
      limit: 50,
    })) as { success: boolean; error?: string };
    vi.mocked(console.error).mockClear();

    expect(result.success).toBe(false);
    expect(result.error).toContain('TEAM_DATA_WORKER_FAILED');
    expect(service.getMessagesPage).not.toHaveBeenCalled();
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

  it('does not fall back TEAM_GET_MEMBER_ACTIVITY_META to main after worker OOM', async () => {
    mockTeamDataWorkerClient.isAvailable.mockReturnValue(true);
    mockTeamDataWorkerClient.getMemberActivityMeta.mockRejectedValueOnce(
      new Error('Worker terminated due to reaching memory limit: JS heap out of memory')
    );

    const handler = handlers.get(TEAM_GET_MEMBER_ACTIVITY_META)!;
    const result = (await handler({} as never, 'my-team')) as {
      success: boolean;
      error?: string;
    };
    vi.mocked(console.error).mockClear();

    expect(result.success).toBe(false);
    expect(result.error).toContain('TEAM_DATA_WORKER_FAILED');
    expect(service.getMemberActivityMeta).not.toHaveBeenCalled();
  });

  it('does not fall back TEAM_GET_LOGS_FOR_TASK to main after worker OOM', async () => {
    mockTeamDataWorkerClient.isAvailable.mockReturnValue(true);
    mockTeamDataWorkerClient.findLogsForTask.mockRejectedValueOnce(
      new Error('Worker terminated due to reaching memory limit: JS heap out of memory')
    );

    const handler = handlers.get(TEAM_GET_LOGS_FOR_TASK)!;
    const result = (await handler({} as never, 'my-team', 'task-1')) as {
      success: boolean;
      error?: string;
    };
    vi.mocked(console.error).mockClear();

    expect(result.success).toBe(false);
    expect(result.error).toContain('TEAM_DATA_WORKER_FAILED');
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
      teamHandlerMocks.isTeamAlive.mockReturnValue(true);
      teamHandlerMocks.getCurrentLeadSessionId.mockReturnValue('sess-live');
      teamHandlerMocks.sendMessageToTeam.mockResolvedValue(undefined);
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
      expect(teamHandlerMocks.sendMessageToTeam).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1100);
      expect(teamHandlerMocks.sendMessageToTeam).toHaveBeenCalledTimes(1);
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
      teamHandlerMocks.isTeamAlive.mockReturnValue(true);
      teamHandlerMocks.getCurrentLeadSessionId.mockReturnValue('sess-live');
      teamHandlerMocks.sendMessageToTeam.mockResolvedValue(undefined);
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
      expect(teamHandlerMocks.sendMessageToTeam).not.toHaveBeenCalled();

      autoResumeEnabled = true;

      const secondResult = (await getDataHandler({} as never, 'my-team')) as {
        success: boolean;
      };
      expect(secondResult.success).toBe(true);

      await vi.advanceTimersByTimeAsync(3 * 60 * 1000 + 29 * 1000);
      expect(teamHandlerMocks.sendMessageToTeam).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1100);
      expect(teamHandlerMocks.sendMessageToTeam).toHaveBeenCalledTimes(1);
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
      teamHandlerMocks.isTeamAlive.mockReturnValue(true);
      teamHandlerMocks.getCurrentLeadSessionId.mockReturnValue('sess-live');
      teamHandlerMocks.sendMessageToTeam.mockResolvedValue(undefined);
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
      expect(teamHandlerMocks.sendMessageToTeam).not.toHaveBeenCalled();

      vi.setSystemTime(new Date('2026-04-17T12:20:00.000Z'));

      const secondResult = (await getDataHandler({} as never, 'my-team')) as {
        success: boolean;
      };
      expect(secondResult.success).toBe(true);

      await vi.advanceTimersByTimeAsync(29 * 1000);
      expect(teamHandlerMocks.sendMessageToTeam).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1500);
      expect(teamHandlerMocks.sendMessageToTeam).toHaveBeenCalledTimes(1);
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
      teamHandlerMocks.isTeamAlive.mockReturnValue(false);
      teamHandlerMocks.sendMessageToTeam.mockResolvedValue(undefined);
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
      teamHandlerMocks.isTeamAlive.mockReturnValue(true);

      await vi.advanceTimersByTimeAsync(3 * 60 * 1000 + 31 * 1000);
      expect(teamHandlerMocks.sendMessageToTeam).not.toHaveBeenCalled();
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
      teamHandlerMocks.isTeamAlive.mockReturnValue(true);
      teamHandlerMocks.getCurrentLeadSessionId.mockReturnValue('sess-new');
      teamHandlerMocks.sendMessageToTeam.mockResolvedValue(undefined);
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
      expect(teamHandlerMocks.sendMessageToTeam).not.toHaveBeenCalled();
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
      teamHandlerMocks.isTeamAlive.mockReturnValue(true);
      teamHandlerMocks.getCurrentLeadSessionId.mockReturnValue('sess-live');
      teamHandlerMocks.sendMessageToTeam.mockResolvedValue(undefined);
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
      expect(teamHandlerMocks.sendMessageToTeam).not.toHaveBeenCalled();
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
    teamHandlerMocks.getLiveLeadProcessMessages.mockReturnValueOnce([
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
      limit: 151,
    });
    expect(result.data.messages).toHaveLength(50);
  });

  it('rebuilds capped TEAM_GET_DATA live overlay through worker when available', async () => {
    mockTeamDataWorkerClient.isAvailable.mockReturnValue(true);
    const liveMessage: InboxMessage = {
      from: 'team-lead',
      text: 'Live thought',
      timestamp: '2026-02-23T11:00:00.000Z',
      read: true,
      source: 'lead_process' as const,
      messageId: 'live-1',
    };
    mockTeamDataWorkerClient.getTeamData.mockResolvedValueOnce({
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
    mockTeamDataWorkerClient.getMessagesPage.mockResolvedValueOnce({
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
      feedRevision: 'rev-worker',
    });
    teamHandlerMocks.getLiveLeadProcessMessages.mockReturnValueOnce([liveMessage]);

    const getDataHandler = handlers.get(TEAM_GET_DATA)!;
    const result = (await getDataHandler({} as never, 'my-team')) as {
      success: boolean;
      data: { messages?: InboxMessage[] };
    };

    expect(result.success).toBe(true);
    expect(mockTeamDataWorkerClient.getMessagesPage).toHaveBeenCalledWith('my-team', {
      limit: 151,
    });
    expect(service.getMessagesPage).not.toHaveBeenCalled();
    expect(result.data.messages).toHaveLength(50);
  });

  it('does not fall back capped TEAM_GET_DATA live overlay rebuild to main after worker OOM', async () => {
    mockTeamDataWorkerClient.isAvailable.mockReturnValue(true);
    const liveMessage: InboxMessage = {
      from: 'team-lead',
      text: 'Live thought',
      timestamp: '2026-02-23T11:00:00.000Z',
      read: true,
      source: 'lead_process' as const,
      messageId: 'live-1',
    };
    mockTeamDataWorkerClient.getTeamData.mockResolvedValueOnce({
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
    mockTeamDataWorkerClient.getMessagesPage.mockRejectedValueOnce(
      new Error('Worker terminated due to reaching memory limit: JS heap out of memory')
    );
    teamHandlerMocks.getLiveLeadProcessMessages.mockReturnValueOnce([liveMessage]);

    const getDataHandler = handlers.get(TEAM_GET_DATA)!;
    const result = (await getDataHandler({} as never, 'my-team')) as {
      success: boolean;
      data: { messages?: InboxMessage[] };
    };
    expect(vi.mocked(console.warn).mock.calls[0]?.join(' ')).toContain('TEAM_DATA_WORKER_FAILED');
    vi.mocked(console.warn).mockClear();
    vi.mocked(console.error).mockClear();

    expect(result.success).toBe(true);
    expect(mockTeamDataWorkerClient.getMessagesPage).toHaveBeenCalledWith('my-team', {
      limit: 151,
    });
    expect(service.getMessagesPage).not.toHaveBeenCalled();
    expect(result.data.messages).toHaveLength(50);
  });

  it('overlays live lead_process messages onto the newest messages page', async () => {
    service.getMessagesPage.mockResolvedValueOnce({
      messages: [
        {
          from: 'user',
          text: 'Ping',
          timestamp: '2026-02-23T10:00:00.000Z',
          read: true,
          source: 'user_sent' as const,
          messageId: 'durable-1',
        },
      ],
      nextCursor: '2026-02-23T10:00:00.000Z|durable-1',
      hasMore: true,
      feedRevision: 'rev-1',
    });
    teamHandlerMocks.getLiveLeadProcessMessages.mockReturnValueOnce([
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
      cursor: undefined,
      limit: 121,
    });
  });

  it('dedups live lead thoughts on the newest messages page when durable lead_session already exists', async () => {
    service.getMessagesPage.mockResolvedValueOnce({
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
    });
    teamHandlerMocks.getLiveLeadProcessMessages.mockReturnValueOnce([
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
    expect(teamHandlerMocks.getLiveLeadProcessMessages).not.toHaveBeenCalled();
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
    it('passes a valid durable command identity to the service', async () => {
      const handler = handlers.get(TEAM_CREATE_TASK)!;
      const result = (await handler({} as never, 'my-team', {
        subject: 'Do something once',
        command: {
          commandId: '11111111-1111-4111-8111-111111111111',
          idempotencyKey: ' create-task-intent-1 ',
        },
      })) as { success: boolean };

      expect(result.success).toBe(true);
      expect(service.createTask).toHaveBeenCalledWith(
        'my-team',
        expect.objectContaining({
          command: {
            commandId: '11111111-1111-4111-8111-111111111111',
            idempotencyKey: 'create-task-intent-1',
          },
          subject: 'Do something once',
        })
      );
    });

    it('rejects a non-UUID task command id before calling the service', async () => {
      const handler = handlers.get(TEAM_CREATE_TASK)!;
      service.createTask.mockClear();

      const result = (await handler({} as never, 'my-team', {
        subject: 'Unsafe identity',
        command: { commandId: '../task', idempotencyKey: 'intent-1' },
      })) as { success: boolean; error: string };

      expect(result.success).toBe(false);
      expect(result.error).toContain('command.commandId must be a UUID');
      expect(service.createTask).not.toHaveBeenCalled();
    });

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
      expect(service.addMember).toHaveBeenCalledWith(
        'my-team',
        expect.objectContaining({
          name: 'alice',
          role: 'developer',
        })
      );
    });

    it('attaches a live teammate through the lifecycle service', async () => {
      const handler = handlers.get(TEAM_ADD_MEMBER)!;
      const result = (await handler({} as never, 'my-team', {
        name: 'alice',
        role: 'developer',
        workflow: 'Focus on frontend polish',
      })) as { success: boolean };

      expect(result.success).toBe(true);
      expect(teamHandlerMocks.attachLiveRosterMember).toHaveBeenCalledWith('my-team', 'alice', {
        reason: 'member_added',
      });
      expect(teamHandlerMocks.sendMessageToTeam).not.toHaveBeenCalled();
    });

    it('preserves runtime backend and fast mode when adding a live teammate', async () => {
      const handler = handlers.get(TEAM_ADD_MEMBER)!;
      const result = (await handler({} as never, 'my-team', {
        name: 'alice',
        role: 'developer',
        providerId: 'codex',
        providerBackendId: 'codex-native',
        fastMode: 'on',
      })) as { success: boolean };

      expect(result.success).toBe(true);
      expect(service.addMember).toHaveBeenCalledWith(
        'my-team',
        expect.objectContaining({
          name: 'alice',
          providerId: 'codex',
          providerBackendId: 'codex-native',
          fastMode: 'on',
        })
      );
      expect(teamHandlerMocks.attachLiveRosterMember).toHaveBeenCalledWith('my-team', 'alice', {
        reason: 'member_added',
      });
    });

    it('lets lifecycle own MCP launch config for live add-member', async () => {
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
        ],
        kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
        processes: [],
      });

      const handler = handlers.get(TEAM_ADD_MEMBER)!;
      const result = (await handler({} as never, 'my-team', {
        name: 'alice',
        role: 'developer',
        providerId: 'codex',
        mcpPolicy: { mode: 'appOnly' },
      })) as { success: boolean };

      expect(result.success).toBe(true);
      expect(teamHandlerMocks.attachLiveRosterMember).toHaveBeenCalledWith('my-team', 'alice', {
        reason: 'member_added',
      });
      expect(teamHandlerMocks.sendMessageToTeam).not.toHaveBeenCalled();
    });

    it('rolls back live addMember metadata when lifecycle attach fails', async () => {
      mockGetMembersMetaFile.mockResolvedValueOnce({
        version: 1,
        providerBackendId: 'codex-native',
        members: [],
      });
      teamHandlerMocks.attachLiveRosterMember.mockRejectedValueOnce(new Error('attach failed'));

      const handler = handlers.get(TEAM_ADD_MEMBER)!;
      const result = (await handler({} as never, 'my-team', {
        name: 'alice',
        role: 'developer',
        providerId: 'codex',
        mcpPolicy: { mode: 'appOnly' },
      })) as { success: boolean; error?: string };

      expect(result.success).toBe(false);
      expect(result.error).toContain('attach failed');
      expect(mockWriteMembersMeta).toHaveBeenCalledWith('my-team', [], {
        providerBackendId: 'codex-native',
      });
      expect(teamHandlerMocks.detachLiveRosterMember).toHaveBeenCalledWith('my-team', 'alice');
      const detachOrder = teamHandlerMocks.detachLiveRosterMember.mock.invocationCallOrder[0];
      const metadataRestoreOrder = mockWriteMembersMeta.mock.invocationCallOrder[0];
      expect(detachOrder).toBeDefined();
      expect(metadataRestoreOrder).toBeDefined();
      expect(detachOrder).toBeLessThan(metadataRestoreOrder);
      vi.mocked(console.error).mockClear();
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
      expect(teamHandlerMocks.attachLiveRosterMember).not.toHaveBeenCalled();
      vi.mocked(console.error).mockClear();
    });

    it('rolls back live OpenCode addMember metadata when lifecycle attach fails', async () => {
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
      teamHandlerMocks.attachLiveRosterMember.mockRejectedValueOnce(new Error('reattach failed'));

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
        mcpPolicy: undefined,
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
      expect(teamHandlerMocks.detachLiveRosterMember).toHaveBeenCalledWith('my-team', 'alice');
      vi.mocked(console.error).mockClear();
    });
  });

  describe('updateConfig', () => {
    it('notifies a live lead only when the team name actually changes', async () => {
      const handler = handlers.get(TEAM_UPDATE_CONFIG)!;
      service.getTeamDisplayName.mockResolvedValueOnce('My Team');
      teamHandlerMocks.isTeamAlive.mockReturnValue(true);

      const result = (await handler({} as never, 'my-team', {
        name: 'Renamed Team',
      })) as { success: boolean };

      expect(result.success).toBe(true);
      expect(service.updateConfig).toHaveBeenCalledWith('my-team', {
        name: 'Renamed Team',
        description: undefined,
        color: undefined,
      });
      expect(mockTeamDataWorkerClient.invalidateTeamConfig).toHaveBeenCalledWith('my-team');
      expect(teamHandlerMocks.sendMessageToTeam).toHaveBeenCalledWith(
        'my-team',
        'The team has been renamed to "Renamed Team". Please use this name when referring to the team going forward.'
      );
    });

    it('does not notify the lead when the submitted team name is unchanged', async () => {
      const handler = handlers.get(TEAM_UPDATE_CONFIG)!;
      service.getTeamDisplayName.mockResolvedValueOnce('My Team');
      teamHandlerMocks.isTeamAlive.mockReturnValue(true);

      const result = (await handler({} as never, 'my-team', {
        name: 'My Team',
      })) as { success: boolean };

      expect(result.success).toBe(true);
      expect(service.updateConfig).toHaveBeenCalledWith('my-team', {
        name: 'My Team',
        description: undefined,
        color: undefined,
      });
      expect(teamHandlerMocks.sendMessageToTeam).not.toHaveBeenCalled();
    });
  });

  describe('team mutation cache invalidation', () => {
    it('invalidates worker config cache after delete, restore, and permanent delete', async () => {
      const deleteHandler = handlers.get(TEAM_DELETE_TEAM)!;
      const restoreHandler = handlers.get(TEAM_RESTORE)!;
      const permanentlyDeleteHandler = handlers.get(TEAM_PERMANENTLY_DELETE)!;

      let result = (await deleteHandler({} as never, 'my-team')) as { success: boolean };
      expect(result.success).toBe(true);
      expect(service.deleteTeam).toHaveBeenCalledWith('my-team');
      expect(mockTeamDataWorkerClient.invalidateTeamConfig).toHaveBeenCalledWith('my-team');

      mockTeamDataWorkerClient.invalidateTeamConfig.mockClear();

      result = (await restoreHandler({} as never, 'my-team')) as { success: boolean };
      expect(result.success).toBe(true);
      expect(service.restoreTeam).toHaveBeenCalledWith('my-team');
      expect(mockTeamDataWorkerClient.invalidateTeamConfig).toHaveBeenCalledWith('my-team');

      mockTeamDataWorkerClient.invalidateTeamConfig.mockClear();

      result = (await permanentlyDeleteHandler({} as never, 'my-team')) as { success: boolean };
      expect(result.success).toBe(true);
      expect(service.permanentlyDeleteTeam).toHaveBeenCalledWith('my-team');
      expect(mockTeamDataWorkerClient.invalidateTeamConfig).toHaveBeenCalledWith('my-team');
    });

    it('invalidates worker config cache after roster metadata mutations', async () => {
      const addHandler = handlers.get(TEAM_ADD_MEMBER)!;
      const removeHandler = handlers.get(TEAM_REMOVE_MEMBER)!;
      const restoreMemberHandler = handlers.get(TEAM_RESTORE_MEMBER)!;
      const replaceHandler = handlers.get(TEAM_REPLACE_MEMBERS)!;
      const updateRoleHandler = handlers.get(TEAM_UPDATE_MEMBER_ROLE)!;

      let result = (await addHandler({} as never, 'my-team', {
        name: 'alice',
        role: 'developer',
      })) as { success: boolean };
      expect(result.success).toBe(true);
      expect(service.addMember).toHaveBeenCalledWith(
        'my-team',
        expect.objectContaining({
          name: 'alice',
          role: 'developer',
        })
      );
      expect(mockTeamDataWorkerClient.invalidateTeamConfig).toHaveBeenCalledWith('my-team');
      expect(mockTeamDataWorkerClient.invalidateMemberRuntimeAdvisory).toHaveBeenCalledWith(
        'my-team'
      );

      mockTeamDataWorkerClient.invalidateTeamConfig.mockClear();
      mockTeamDataWorkerClient.invalidateMemberRuntimeAdvisory.mockClear();

      result = (await removeHandler({} as never, 'my-team', 'alice')) as { success: boolean };
      expect(result.success).toBe(true);
      expect(service.removeMember).toHaveBeenCalledWith('my-team', 'alice');
      expect(mockTeamDataWorkerClient.invalidateTeamConfig).toHaveBeenCalledWith('my-team');
      expect(mockTeamDataWorkerClient.invalidateMemberRuntimeAdvisory).toHaveBeenCalledWith(
        'my-team'
      );

      mockTeamDataWorkerClient.invalidateTeamConfig.mockClear();
      mockTeamDataWorkerClient.invalidateMemberRuntimeAdvisory.mockClear();

      result = (await restoreMemberHandler({} as never, 'my-team', 'alice')) as {
        success: boolean;
      };
      expect(result.success).toBe(true);
      expect(service.restoreMember).toHaveBeenCalledWith('my-team', 'alice');
      expect(mockTeamDataWorkerClient.invalidateTeamConfig).toHaveBeenCalledWith('my-team');
      expect(mockTeamDataWorkerClient.invalidateMemberRuntimeAdvisory).toHaveBeenCalledWith(
        'my-team'
      );

      mockTeamDataWorkerClient.invalidateTeamConfig.mockClear();
      mockTeamDataWorkerClient.invalidateMemberRuntimeAdvisory.mockClear();

      result = (await replaceHandler({} as never, 'my-team', {
        members: [{ name: 'bob', role: 'developer' }],
      })) as { success: boolean };
      expect(result.success).toBe(true);
      expect(service.replaceMembers).toHaveBeenCalledWith('my-team', {
        members: [
          {
            name: 'bob',
            role: 'developer',
            workflow: undefined,
            isolation: undefined,
            providerId: undefined,
            providerBackendId: undefined,
            model: undefined,
            effort: undefined,
            fastMode: undefined,
          },
        ],
      });
      expect(mockTeamDataWorkerClient.invalidateTeamConfig).toHaveBeenCalledWith('my-team');
      expect(mockTeamDataWorkerClient.invalidateMemberRuntimeAdvisory).toHaveBeenCalledWith(
        'my-team'
      );

      mockTeamDataWorkerClient.invalidateTeamConfig.mockClear();
      mockTeamDataWorkerClient.invalidateMemberRuntimeAdvisory.mockClear();

      result = (await updateRoleHandler({} as never, 'my-team', 'bob', 'reviewer')) as {
        success: boolean;
      };
      expect(result.success).toBe(true);
      expect(service.updateMemberRole).toHaveBeenCalledWith('my-team', 'bob', 'reviewer');
      expect(mockTeamDataWorkerClient.invalidateTeamConfig).toHaveBeenCalledWith('my-team');
      expect(mockTeamDataWorkerClient.invalidateMemberRuntimeAdvisory).toHaveBeenCalledWith(
        'my-team'
      );
    });
  });

  describe('removeMember', () => {
    it('calls service on valid input', async () => {
      const handler = handlers.get(TEAM_REMOVE_MEMBER)!;
      const result = (await handler({} as never, 'my-team', 'alice')) as { success: boolean };
      expect(result.success).toBe(true);
      expect(service.removeMember).toHaveBeenCalledWith('my-team', 'alice');
    });

    it('requests persisted runtime detach even when mutable team-alive tracking is absent', async () => {
      teamHandlerMocks.isTeamAlive.mockReturnValueOnce(false);
      const handler = handlers.get(TEAM_REMOVE_MEMBER)!;

      const result = (await handler({} as never, 'my-team', 'alice')) as { success: boolean };

      expect(result.success).toBe(true);
      expect(teamHandlerMocks.detachLiveRosterMember).toHaveBeenCalledWith('my-team', 'alice');
      expect(teamHandlerMocks.sendMessageToTeam).not.toHaveBeenCalled();
    });

    it('treats repeated removal of a persisted tombstone as a successful no-op', async () => {
      mockGetMembersMetaFile.mockImplementation(() =>
        Promise.resolve(
          service.removeMember.mock.calls.length > 0
            ? {
                version: 1,
                providerBackendId: undefined,
                members: [{ name: 'alice', role: 'Developer', removedAt: 1_752_000_000_000 }],
              }
            : {
                version: 1,
                providerBackendId: undefined,
                members: [{ name: 'alice', role: 'Developer' }],
              }
        )
      );
      const handler = handlers.get(TEAM_REMOVE_MEMBER)!;

      const firstResult = (await handler({} as never, 'my-team', 'alice')) as {
        success: boolean;
      };
      const secondResult = (await handler({} as never, 'my-team', 'alice')) as {
        success: boolean;
      };

      expect(firstResult.success).toBe(true);
      expect(secondResult.success).toBe(true);
      expect(service.getTeamData).toHaveBeenCalledTimes(2);
      expect(service.removeMember).toHaveBeenCalledTimes(1);
      expect(teamHandlerMocks.detachLiveRosterMember).toHaveBeenCalledTimes(1);
      expect(teamHandlerMocks.sendMessageToTeam).toHaveBeenCalledTimes(1);
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
      expect(teamHandlerMocks.detachLiveRosterMember).not.toHaveBeenCalled();
      vi.mocked(console.error).mockClear();
    });

    it('rolls back live removeMember metadata when lifecycle detach fails', async () => {
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
      teamHandlerMocks.detachLiveRosterMember.mockRejectedValueOnce(new Error('detach failed'));

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
      expect(teamHandlerMocks.attachLiveRosterMember).toHaveBeenCalledWith('my-team', 'alice', {
        reason: 'member_updated',
      });
      vi.mocked(console.error).mockClear();
    });
  });

  describe('restoreMember', () => {
    it('calls service on valid input', async () => {
      const handler = handlers.get(TEAM_RESTORE_MEMBER)!;
      const result = (await handler({} as never, 'my-team', 'alice')) as { success: boolean };
      expect(result.success).toBe(true);
      expect(service.restoreMember).toHaveBeenCalledWith('my-team', 'alice');
    });

    it('rejects invalid team name', async () => {
      const handler = handlers.get(TEAM_RESTORE_MEMBER)!;
      const result = (await handler({} as never, '../bad', 'alice')) as { success: boolean };
      expect(result.success).toBe(false);
    });

    it('rejects invalid member name', async () => {
      const handler = handlers.get(TEAM_RESTORE_MEMBER)!;
      const result = (await handler({} as never, 'my-team', '../bad')) as { success: boolean };
      expect(result.success).toBe(false);
    });

    it('lets lifecycle own MCP launch config for live restore-member', async () => {
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
            removedAt: Date.now(),
            currentTaskId: null,
            taskCount: 0,
          },
        ],
        kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
        processes: [],
      });
      service.restoreMember.mockResolvedValueOnce({
        name: 'alice',
        role: 'Developer',
        providerId: 'codex',
        mcpPolicy: { mode: 'appOnly' },
      } as never);

      const handler = handlers.get(TEAM_RESTORE_MEMBER)!;
      const result = (await handler({} as never, 'my-team', 'alice')) as { success: boolean };

      expect(result.success).toBe(true);
      expect(teamHandlerMocks.attachLiveRosterMember).toHaveBeenCalledWith('my-team', 'alice', {
        reason: 'member_restored',
      });
      expect(teamHandlerMocks.sendMessageToTeam).not.toHaveBeenCalled();
    });

    it('attaches a restored OpenCode teammate through the lifecycle service', async () => {
      const handler = handlers.get(TEAM_RESTORE_MEMBER)!;
      service.restoreMember.mockResolvedValueOnce({
        name: 'alice',
        providerId: 'opencode',
        role: 'Developer',
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
            role: 'Developer',
            removedAt: Date.now(),
            currentTaskId: null,
            taskCount: 0,
          },
        ],
        kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
        processes: [],
      });

      const result = (await handler({} as never, 'my-team', 'alice')) as { success: boolean };

      expect(result.success).toBe(true);
      expect(teamHandlerMocks.attachLiveRosterMember).toHaveBeenCalledWith('my-team', 'alice', {
        reason: 'member_restored',
      });
      expect(teamHandlerMocks.sendMessageToTeam).not.toHaveBeenCalled();
    });

    it('blocks live restoreMember for a running OpenCode-led team before metadata is changed', async () => {
      const handler = handlers.get(TEAM_RESTORE_MEMBER)!;
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
            removedAt: Date.now(),
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
      expect(service.restoreMember).not.toHaveBeenCalled();
      expect(teamHandlerMocks.attachLiveRosterMember).not.toHaveBeenCalled();
      vi.mocked(console.error).mockClear();
    });
  });

  describe('replaceMembers', () => {
    it('updates non-live draft members without requiring a full team snapshot', async () => {
      teamHandlerMocks.isTeamAlive.mockReturnValue(false);
      service.getTeamData.mockRejectedValueOnce(new Error('Team not found: draft-team'));

      const handler = handlers.get(TEAM_REPLACE_MEMBERS)!;
      const result = (await handler({} as never, 'draft-team', {
        members: [
          {
            name: 'alice',
            role: 'Developer',
            providerId: 'codex',
          },
        ],
      })) as { success: boolean; error?: string };

      expect(result.success).toBe(true);
      expect(service.getTeamData).not.toHaveBeenCalled();
      expect(service.replaceMembers).toHaveBeenCalledWith('draft-team', {
        members: [
          {
            name: 'alice',
            role: 'Developer',
            workflow: undefined,
            isolation: undefined,
            providerId: 'codex',
            providerBackendId: undefined,
            model: undefined,
            effort: undefined,
            fastMode: undefined,
            mcpPolicy: undefined,
          },
        ],
      });
      expect(teamHandlerMocks.attachLiveRosterMember).not.toHaveBeenCalled();
      expect(teamHandlerMocks.detachLiveRosterMember).not.toHaveBeenCalled();
      expect(mockTeamDataWorkerClient.invalidateTeamConfig).toHaveBeenCalledWith('draft-team');
      expect(mockTeamDataWorkerClient.invalidateMemberRuntimeAdvisory).toHaveBeenCalledWith(
        'draft-team'
      );
    });

    it('attaches added teammates through lifecycle during live replaceMembers', async () => {
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
        ],
        kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
        processes: [],
      });

      const handler = handlers.get(TEAM_REPLACE_MEMBERS)!;
      const result = (await handler({} as never, 'my-team', {
        members: [
          {
            name: 'alice',
            role: 'Developer',
            providerId: 'codex',
            mcpPolicy: { mode: 'appOnly' },
          },
        ],
      })) as { success: boolean };

      expect(result.success).toBe(true);
      expect(teamHandlerMocks.attachLiveRosterMember).toHaveBeenCalledWith('my-team', 'alice', {
        reason: 'member_added',
      });
      expect(teamHandlerMocks.sendMessageToTeam).not.toHaveBeenCalled();
    });

    it('reattaches updated primary-owned teammates through lifecycle during live replaceMembers', async () => {
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

      const handler = handlers.get(TEAM_REPLACE_MEMBERS)!;
      const result = (await handler({} as never, 'my-team', {
        members: [
          {
            name: 'alice',
            role: 'Developer',
            providerId: 'codex',
            mcpPolicy: { mode: 'appOnly' },
          },
        ],
      })) as { success: boolean };

      expect(result.success).toBe(true);
      expect(teamHandlerMocks.attachLiveRosterMember).toHaveBeenCalledWith('my-team', 'alice', {
        reason: 'member_updated',
      });
      expect(teamHandlerMocks.sendMessageToTeam).not.toHaveBeenCalled();
    });

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
      expect(teamHandlerMocks.attachLiveRosterMember).not.toHaveBeenCalled();
      expect(teamHandlerMocks.detachLiveRosterMember).not.toHaveBeenCalled();
      vi.mocked(console.error).mockClear();
    });

    it('rolls back live OpenCode replaceMembers metadata when lifecycle attach fails', async () => {
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
      teamHandlerMocks.attachLiveRosterMember.mockRejectedValueOnce(new Error('reattach failed'));

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
      expect(teamHandlerMocks.attachLiveRosterMember).toHaveBeenNthCalledWith(
        1,
        'my-team',
        'alice',
        { reason: 'member_updated' }
      );
      expect(teamHandlerMocks.attachLiveRosterMember).toHaveBeenNthCalledWith(
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
      expect(result.error).toContain(
        'Live member migration between OpenCode and the primary runtime owner'
      );
      expect(result.error).toContain('alice');
      expect(service.replaceMembers).not.toHaveBeenCalled();
      expect(teamHandlerMocks.attachLiveRosterMember).not.toHaveBeenCalled();
      expect(teamHandlerMocks.detachLiveRosterMember).not.toHaveBeenCalled();
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
      expect(result.error).toContain(
        'Live member migration between OpenCode and the primary runtime owner'
      );
      expect(result.error).toContain('alice');
      expect(service.replaceMembers).not.toHaveBeenCalled();
      expect(teamHandlerMocks.attachLiveRosterMember).not.toHaveBeenCalled();
      expect(teamHandlerMocks.detachLiveRosterMember).not.toHaveBeenCalled();
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
      const callArg = teamHandlerMocks.createTeam.mock.calls[0][0];
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

  it('removes all expected handlers', () => {
    removeTeamHandlers(ipcMain as never);
    expect(ipcMain.removeHandler).toHaveBeenCalledTimes(TEAM_HANDLER_KEYS.length);
    expect(new Set(ipcMain.removeHandler.mock.calls.map(([channel]) => channel))).toEqual(
      new Set(TEAM_HANDLER_KEYS)
    );
    expect(handlers.size).toBe(0);
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
          filePath: TRANSCRIPT_JSONL_PATH,
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
      expect(teamHandlerMocks.createTeam).toHaveBeenCalledTimes(1);
      const callArg = teamHandlerMocks.createTeam.mock.calls[0][0];
      expect(callArg.members).toEqual([]);
    });

    it('createTeam preserves teammate backend and fast mode metadata', async () => {
      const handler = handlers.get(TEAM_CREATE)!;
      const result = (await handler({ sender: { send: vi.fn() } } as never, {
        teamName: 'runtime-team',
        members: [
          {
            name: 'builder',
            role: 'Engineer',
            providerId: 'codex',
            providerBackendId: 'codex-native',
            model: 'gpt-5.4',
            effort: 'high',
            fastMode: 'on',
            mcpPolicy: { mode: 'appOnly' },
          },
        ],
        cwd: os.tmpdir(),
        providerId: 'codex',
        providerBackendId: 'codex-native',
        limitContext: true,
      })) as { success: boolean };

      expect(result.success).toBe(true);
      const createRequest = teamHandlerMocks.createTeam.mock.calls[0][0];
      expect(createRequest.limitContext).toBe(true);
      expect(createRequest.members).toEqual([
        {
          name: 'builder',
          role: 'Engineer',
          workflow: undefined,
          isolation: undefined,
          providerId: 'codex',
          providerBackendId: 'codex-native',
          model: 'gpt-5.4',
          effort: 'high',
          fastMode: 'on',
          mcpPolicy: { mode: 'appOnly' },
        },
      ]);
    });

    it('createTeam validates teammate runtime fields against inherited team provider metadata', async () => {
      const handler = handlers.get(TEAM_CREATE)!;
      const result = (await handler({ sender: { send: vi.fn() } } as never, {
        teamName: 'inherited-backend-team',
        members: [
          {
            name: 'builder',
            providerBackendId: 'codex-native',
            effort: 'xhigh',
          },
        ],
        cwd: os.tmpdir(),
        providerId: 'codex',
        providerBackendId: 'codex-native',
      })) as { success: boolean };

      expect(result.success).toBe(true);
      expect(teamHandlerMocks.createTeam.mock.calls[0][0].members).toEqual([
        {
          name: 'builder',
          role: undefined,
          workflow: undefined,
          isolation: undefined,
          providerId: undefined,
          providerBackendId: 'codex-native',
          model: undefined,
          effort: 'xhigh',
          fastMode: undefined,
        },
      ]);
    });

    it('createTeam preserves top-level OpenCode provider and inherited teammate backend', async () => {
      const handler = handlers.get(TEAM_CREATE)!;
      const result = (await handler({ sender: { send: vi.fn() } } as never, {
        teamName: 'opencode-runtime-team',
        members: [
          {
            name: 'builder',
            providerBackendId: 'opencode-cli',
          },
        ],
        cwd: os.tmpdir(),
        providerId: 'opencode',
        providerBackendId: 'opencode-cli',
      })) as { success: boolean };

      expect(result.success).toBe(true);
      expect(teamHandlerMocks.createTeam).toHaveBeenCalledWith(
        expect.objectContaining({
          teamName: 'opencode-runtime-team',
          providerId: 'opencode',
          providerBackendId: 'opencode-cli',
          members: [
            expect.objectContaining({
              name: 'builder',
              providerId: undefined,
              providerBackendId: 'opencode-cli',
            }),
          ],
        }),
        expect.any(Function)
      );
    });

    it('handleCreateConfig accepts members: []', async () => {
      const handler = handlers.get(TEAM_CREATE_CONFIG)!;
      const result = (await handler({} as never, {
        teamName: 'solo-team',
        members: [],
        cwd: os.tmpdir(),
      })) as { success: boolean };
      expect(result.success).toBe(true);
      expect(mockTeamDataWorkerClient.invalidateTeamConfig).toHaveBeenCalledWith('solo-team');
    });

    it('handleCreateConfig preserves draft launch metadata', async () => {
      const handler = handlers.get(TEAM_CREATE_CONFIG)!;
      const result = (await handler({} as never, {
        teamName: 'draft-team',
        displayName: ' Draft Team ',
        description: ' Saved draft ',
        color: '#3366ff',
        members: [
          {
            name: 'builder',
            role: ' Engineer ',
            workflow: ' Ship focused patches ',
            providerId: 'codex',
            providerBackendId: 'codex-native',
            model: ' gpt-5.2 ',
            effort: 'high',
            fastMode: 'on',
            mcpPolicy: {
              mode: 'strictAllowlist',
              scopes: { project: true, user: false },
              serverNames: ['agent-teams'],
            },
          },
        ],
        cwd: '/Users/test/project',
        prompt: ' Saved prompt ',
        providerId: 'codex',
        providerBackendId: 'codex-native',
        model: ' gpt-5.2 ',
        effort: 'high',
        fastMode: 'on',
        limitContext: true,
        skipPermissions: false,
        worktree: 'feature-x',
        extraCliArgs: '--max-turns 5',
      })) as { success: boolean };

      expect(result.success).toBe(true);
      expect(service.createTeamConfig).toHaveBeenCalledWith({
        teamName: 'draft-team',
        displayName: 'Draft Team',
        description: 'Saved draft',
        color: '#3366ff',
        members: [
          {
            name: 'builder',
            role: 'Engineer',
            workflow: 'Ship focused patches',
            providerId: 'codex',
            providerBackendId: 'codex-native',
            model: 'gpt-5.2',
            effort: 'high',
            fastMode: 'on',
            mcpPolicy: {
              mode: 'strictAllowlist',
              scopes: { project: true, user: false },
              serverNames: ['agent-teams'],
            },
          },
        ],
        cwd: '/Users/test/project',
        prompt: 'Saved prompt',
        providerId: 'codex',
        providerBackendId: 'codex-native',
        model: 'gpt-5.2',
        effort: 'high',
        fastMode: 'on',
        limitContext: true,
        skipPermissions: false,
        worktree: 'feature-x',
        extraCliArgs: '--max-turns 5',
      });
    });

    it('handleCreateConfig validates teammate runtime fields against inherited team provider metadata', async () => {
      const handler = handlers.get(TEAM_CREATE_CONFIG)!;
      const result = (await handler({} as never, {
        teamName: 'draft-inherited-runtime',
        members: [
          {
            name: 'builder',
            providerBackendId: 'codex-native',
            effort: 'xhigh',
          },
        ],
        cwd: os.tmpdir(),
        providerId: 'codex',
        providerBackendId: 'codex-native',
      })) as { success: boolean };

      expect(result.success).toBe(true);
      expect(service.createTeamConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          teamName: 'draft-inherited-runtime',
          providerId: 'codex',
          providerBackendId: 'codex-native',
          members: [
            expect.objectContaining({
              name: 'builder',
              providerId: undefined,
              providerBackendId: 'codex-native',
              effort: 'xhigh',
            }),
          ],
        })
      );
    });

    it('handleCreateConfig rejects stale inherited teammate backends for the selected team provider', async () => {
      const handler = handlers.get(TEAM_CREATE_CONFIG)!;
      const result = (await handler({} as never, {
        teamName: 'draft-stale-runtime',
        members: [
          {
            name: 'builder',
            providerBackendId: 'codex-native',
          },
        ],
        cwd: os.tmpdir(),
        providerId: 'anthropic',
      })) as { success: boolean; error?: string };

      expect(result.success).toBe(false);
      expect(result.error).toContain('providerBackendId must be valid');
      expect(service.createTeamConfig).not.toHaveBeenCalled();
    });

    it('handleCreateConfig drops known stale top-level backend when provider is omitted', async () => {
      const handler = handlers.get(TEAM_CREATE_CONFIG)!;
      const result = (await handler({} as never, {
        teamName: 'draft-stale-top-level-runtime',
        members: [{ name: 'builder' }],
        cwd: os.tmpdir(),
        providerBackendId: 'codex-native',
      })) as { success: boolean };

      expect(result.success).toBe(true);
      expect(service.createTeamConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          teamName: 'draft-stale-top-level-runtime',
          providerId: undefined,
          providerBackendId: undefined,
        })
      );
    });

    it('handleCreateConfig validates teammate effort against default Anthropic provider metadata', async () => {
      const handler = handlers.get(TEAM_CREATE_CONFIG)!;
      const result = (await handler({} as never, {
        teamName: 'draft-default-anthropic-runtime',
        members: [
          {
            name: 'builder',
            effort: 'max',
          },
        ],
        cwd: os.tmpdir(),
      })) as { success: boolean };

      expect(result.success).toBe(true);
      expect(service.createTeamConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          teamName: 'draft-default-anthropic-runtime',
          members: [
            expect.objectContaining({
              name: 'builder',
              effort: 'max',
            }),
          ],
        })
      );
    });

    it('handleCreateConfig validates top-level effort against default Anthropic provider metadata', async () => {
      const handler = handlers.get(TEAM_CREATE_CONFIG)!;
      const result = (await handler({} as never, {
        teamName: 'draft-default-anthropic-effort',
        members: [{ name: 'builder' }],
        cwd: os.tmpdir(),
        effort: 'max',
      })) as { success: boolean };

      expect(result.success).toBe(true);
      expect(service.createTeamConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          teamName: 'draft-default-anthropic-effort',
          providerId: undefined,
          effort: 'max',
        })
      );
    });

    it('launches draft team through saved request without dropping Electron draft metadata', async () => {
      const claudeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-draft-launch-'));
      setClaudeBasePathOverride(claudeRoot);
      try {
        const teamDir = path.join(claudeRoot, 'teams', 'draft-team');
        fs.mkdirSync(teamDir, { recursive: true });
        fs.writeFileSync(
          path.join(teamDir, 'team.meta.json'),
          JSON.stringify({
            version: 1,
            displayName: 'Draft Team',
            cwd: '/Users/test/project',
            createdAt: Date.now(),
          })
        );
        service.getSavedRequest.mockResolvedValueOnce({
          teamName: 'draft-team',
          displayName: 'Draft Team',
          description: 'Saved draft',
          color: '#3366ff',
          cwd: '/Users/test/project',
          prompt: 'Saved prompt',
          providerId: 'codex',
          providerBackendId: 'codex-native',
          model: 'gpt-5.2',
          effort: 'medium',
          fastMode: 'on',
          limitContext: true,
          skipPermissions: false,
          worktree: 'feature-x',
          extraCliArgs: '--max-turns 5',
          members: [
            {
              name: 'builder',
              role: 'Engineer',
              workflow: 'Ship focused patches',
              providerId: 'codex',
              providerBackendId: 'codex-native',
              model: 'gpt-5.2',
              effort: 'high',
              fastMode: 'on',
            },
          ],
        });

        const handler = handlers.get(TEAM_LAUNCH)!;
        const result = (await handler({ sender: { send: vi.fn() } } as never, {
          teamName: 'draft-team',
          cwd: os.tmpdir(),
          effort: 'high',
        })) as { success: boolean };

        expect(result.success).toBe(true);
        expect(computeTeamWatchScope()?.has('draft-team')).toBe(true);
        expect(teamHandlerMocks.launchTeam).not.toHaveBeenCalled();
        expect(teamHandlerMocks.createTeam).toHaveBeenCalledWith(
          {
            teamName: 'draft-team',
            displayName: 'Draft Team',
            description: 'Saved draft',
            color: '#3366ff',
            members: [
              {
                name: 'builder',
                role: 'Engineer',
                workflow: 'Ship focused patches',
                providerId: 'codex',
                providerBackendId: 'codex-native',
                model: 'gpt-5.2',
                effort: 'high',
                fastMode: 'on',
              },
            ],
            cwd: os.tmpdir(),
            prompt: 'Saved prompt',
            providerId: 'codex',
            providerBackendId: 'codex-native',
            model: 'gpt-5.2',
            effort: 'high',
            fastMode: 'on',
            limitContext: true,
            skipPermissions: false,
            worktree: 'feature-x',
            extraCliArgs: '--max-turns 5',
          },
          expect.any(Function)
        );
      } finally {
        fs.rmSync(claudeRoot, { recursive: true, force: true });
      }
    });

    it('treats explicit default effort in launch payload as clearing persisted lead effort', async () => {
      const claudeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-launch-default-effort-'));
      setClaudeBasePathOverride(claudeRoot);
      try {
        const teamDir = path.join(claudeRoot, 'teams', 'anthropic-team');
        fs.mkdirSync(teamDir, { recursive: true });
        fs.writeFileSync(
          path.join(teamDir, 'config.json'),
          JSON.stringify({ teamName: 'anthropic-team' })
        );
        fs.writeFileSync(
          path.join(teamDir, 'team.meta.json'),
          JSON.stringify({
            version: 1,
            displayName: 'Anthropic Team',
            cwd: '/Users/test/project',
            providerId: 'anthropic',
            model: 'claude-opus-4-6[1m]',
            effort: 'low',
            fastMode: 'on',
            launchIdentity: {
              selectedModel: 'claude-opus-4-6[1m]',
              selectedEffort: 'low',
              selectedFastMode: 'on',
            },
            createdAt: Date.now(),
          })
        );

        const handler = handlers.get(TEAM_LAUNCH)!;
        const result = (await handler({ sender: { send: vi.fn() } } as never, {
          teamName: 'anthropic-team',
          cwd: os.tmpdir(),
          providerId: 'anthropic',
          model: 'claude-opus-4-6[1m]',
          effort: undefined,
          fastMode: 'inherit',
        })) as { success: boolean };

        expect(result.success).toBe(true);
        expect(teamHandlerMocks.launchTeam).toHaveBeenCalledWith(
          expect.objectContaining({
            teamName: 'anthropic-team',
            providerId: 'anthropic',
            model: 'claude-opus-4-6[1m]',
            effort: undefined,
            fastMode: 'inherit',
          }),
          expect.any(Function)
        );
      } finally {
        fs.rmSync(claudeRoot, { recursive: true, force: true });
      }
    });

    it('prefers Anthropic launch identity over stale root Codex backend during launch', async () => {
      const claudeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-launch-provider-identity-'));
      setClaudeBasePathOverride(claudeRoot);
      try {
        const teamDir = path.join(claudeRoot, 'teams', 'anthropic-team');
        fs.mkdirSync(teamDir, { recursive: true });
        fs.writeFileSync(
          path.join(teamDir, 'config.json'),
          JSON.stringify({ teamName: 'anthropic-team' })
        );
        fs.writeFileSync(
          path.join(teamDir, 'team.meta.json'),
          JSON.stringify({
            version: 1,
            displayName: 'Anthropic Team',
            cwd: '/Users/test/project',
            providerId: 'codex',
            providerBackendId: 'codex-native',
            model: 'gpt-5.4',
            effort: 'medium',
            launchIdentity: {
              providerId: 'anthropic',
              providerBackendId: null,
              selectedModel: 'opus[1m]',
              selectedModelKind: 'explicit',
              resolvedLaunchModel: 'opus[1m]',
              catalogId: 'opus',
              catalogSource: 'runtime',
              catalogFetchedAt: null,
              selectedEffort: 'low',
              resolvedEffort: 'low',
              selectedFastMode: 'inherit',
              resolvedFastMode: null,
              fastResolutionReason: null,
            },
            createdAt: Date.now(),
          })
        );

        const handler = handlers.get(TEAM_LAUNCH)!;
        const result = (await handler({ sender: { send: vi.fn() } } as never, {
          teamName: 'anthropic-team',
          cwd: os.tmpdir(),
        })) as { success: boolean };

        expect(result).toMatchObject({ success: true });
        expect(teamHandlerMocks.launchTeam).toHaveBeenCalledWith(
          expect.objectContaining({
            teamName: 'anthropic-team',
            providerId: 'anthropic',
            providerBackendId: undefined,
            model: 'opus[1m]',
            effort: 'low',
            fastMode: 'inherit',
          }),
          expect.any(Function)
        );
      } finally {
        fs.rmSync(claudeRoot, { recursive: true, force: true });
      }
    });

    it('lets an explicit relaunch payload override stale persisted provider and model metadata', async () => {
      const claudeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-relaunch-provider-change-'));
      setClaudeBasePathOverride(claudeRoot);
      try {
        const teamDir = path.join(claudeRoot, 'teams', 'runtime-change-team');
        fs.mkdirSync(teamDir, { recursive: true });
        fs.writeFileSync(
          path.join(teamDir, 'config.json'),
          JSON.stringify({ teamName: 'runtime-change-team' })
        );
        fs.writeFileSync(
          path.join(teamDir, 'team.meta.json'),
          JSON.stringify({
            version: 1,
            displayName: 'Runtime Change Team',
            cwd: '/Users/test/project',
            providerId: 'codex',
            providerBackendId: 'codex-native',
            model: 'gpt-5.5',
            effort: 'medium',
            launchIdentity: {
              providerId: 'codex',
              providerBackendId: 'codex-native',
              selectedModel: 'gpt-5.5',
              selectedModelKind: 'explicit',
              resolvedLaunchModel: 'gpt-5.5',
              catalogId: 'gpt-5.5',
              catalogSource: 'runtime',
              catalogFetchedAt: null,
              selectedEffort: 'medium',
              resolvedEffort: 'medium',
              selectedFastMode: 'inherit',
              resolvedFastMode: null,
              fastResolutionReason: null,
            },
            createdAt: Date.now(),
          })
        );

        const handler = handlers.get(TEAM_LAUNCH)!;
        const result = (await handler({ sender: { send: vi.fn() } } as never, {
          teamName: 'runtime-change-team',
          cwd: os.tmpdir(),
          providerId: 'anthropic',
          model: 'sonnet',
          effort: 'low',
          fastMode: 'inherit',
        })) as { success: boolean };

        expect(result).toMatchObject({ success: true });
        expect(teamHandlerMocks.launchTeam).toHaveBeenCalledWith(
          expect.objectContaining({
            teamName: 'runtime-change-team',
            providerId: 'anthropic',
            providerBackendId: undefined,
            model: 'sonnet',
            effort: 'low',
            fastMode: 'inherit',
          }),
          expect.any(Function)
        );
      } finally {
        fs.rmSync(claudeRoot, { recursive: true, force: true });
      }
    });

    it('does not reuse a persisted model when an explicit relaunch changes provider without a model', async () => {
      const claudeRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), 'ipc-relaunch-provider-change-default-model-')
      );
      setClaudeBasePathOverride(claudeRoot);
      try {
        const teamDir = path.join(claudeRoot, 'teams', 'runtime-default-change-team');
        fs.mkdirSync(teamDir, { recursive: true });
        fs.writeFileSync(
          path.join(teamDir, 'config.json'),
          JSON.stringify({ teamName: 'runtime-default-change-team' })
        );
        fs.writeFileSync(
          path.join(teamDir, 'team.meta.json'),
          JSON.stringify({
            version: 1,
            displayName: 'Runtime Default Change Team',
            cwd: '/Users/test/project',
            providerId: 'codex',
            providerBackendId: 'codex-native',
            model: 'gpt-5.5',
            effort: 'medium',
            fastMode: 'on',
            limitContext: true,
            launchIdentity: {
              providerId: 'codex',
              providerBackendId: 'codex-native',
              selectedModel: 'gpt-5.5',
              selectedModelKind: 'explicit',
              resolvedLaunchModel: 'gpt-5.5',
              catalogId: 'gpt-5.5',
              catalogSource: 'runtime',
              catalogFetchedAt: null,
              selectedEffort: 'medium',
              resolvedEffort: 'medium',
              selectedFastMode: 'on',
              resolvedFastMode: true,
              fastResolutionReason: null,
            },
            createdAt: Date.now(),
          })
        );

        const handler = handlers.get(TEAM_LAUNCH)!;
        const result = (await handler({ sender: { send: vi.fn() } } as never, {
          teamName: 'runtime-default-change-team',
          cwd: os.tmpdir(),
          providerId: 'anthropic',
        })) as { success: boolean };

        expect(result).toMatchObject({ success: true });
        const [request] = teamHandlerMocks.launchTeam.mock.calls.at(-1) as unknown as [
          TeamLaunchRequest,
          (progress: TeamProvisioningProgress) => void,
        ];
        expect(request).toMatchObject({
          teamName: 'runtime-default-change-team',
          providerId: 'anthropic',
          providerBackendId: undefined,
        });
        expect(request.model).toBeUndefined();
        expect(request.effort).toBeUndefined();
        expect(request.fastMode).toBeUndefined();
        expect(request.limitContext).toBeUndefined();
      } finally {
        fs.rmSync(claudeRoot, { recursive: true, force: true });
      }
    });

    it('keeps persisted backend when an explicit relaunch repeats the same provider without backend', async () => {
      const claudeRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), 'ipc-relaunch-same-provider-backend-')
      );
      setClaudeBasePathOverride(claudeRoot);
      try {
        const teamDir = path.join(claudeRoot, 'teams', 'gemini-backend-team');
        fs.mkdirSync(teamDir, { recursive: true });
        fs.writeFileSync(
          path.join(teamDir, 'config.json'),
          JSON.stringify({ teamName: 'gemini-backend-team' })
        );
        fs.writeFileSync(
          path.join(teamDir, 'team.meta.json'),
          JSON.stringify({
            version: 1,
            displayName: 'Gemini Backend Team',
            cwd: '/Users/test/project',
            providerId: 'gemini',
            providerBackendId: 'api',
            model: 'gemini-3-pro',
            createdAt: Date.now(),
          })
        );

        const handler = handlers.get(TEAM_LAUNCH)!;
        const result = (await handler({ sender: { send: vi.fn() } } as never, {
          teamName: 'gemini-backend-team',
          cwd: os.tmpdir(),
          providerId: 'gemini',
        })) as { success: boolean };

        expect(result).toMatchObject({ success: true });
        expect(teamHandlerMocks.launchTeam).toHaveBeenCalledWith(
          expect.objectContaining({
            teamName: 'gemini-backend-team',
            providerId: 'gemini',
            providerBackendId: 'api',
            model: 'gemini-3-pro',
          }),
          expect.any(Function)
        );
      } finally {
        fs.rmSync(claudeRoot, { recursive: true, force: true });
      }
    });

    it('clears a persisted model when an explicit relaunch repeats the provider with default model', async () => {
      const claudeRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), 'ipc-relaunch-same-provider-default-model-')
      );
      setClaudeBasePathOverride(claudeRoot);
      try {
        const teamDir = path.join(claudeRoot, 'teams', 'codex-default-model-team');
        fs.mkdirSync(teamDir, { recursive: true });
        fs.writeFileSync(
          path.join(teamDir, 'config.json'),
          JSON.stringify({ teamName: 'codex-default-model-team' })
        );
        fs.writeFileSync(
          path.join(teamDir, 'team.meta.json'),
          JSON.stringify({
            version: 1,
            displayName: 'Codex Default Model Team',
            cwd: '/Users/test/project',
            providerId: 'codex',
            providerBackendId: 'codex-native',
            model: 'gpt-5.5',
            effort: 'medium',
            launchIdentity: {
              providerId: 'codex',
              providerBackendId: 'codex-native',
              selectedModel: 'gpt-5.5',
              selectedModelKind: 'explicit',
              resolvedLaunchModel: 'gpt-5.5',
              catalogId: 'gpt-5.5',
              catalogSource: 'runtime',
              catalogFetchedAt: null,
              selectedEffort: 'medium',
              resolvedEffort: 'medium',
              selectedFastMode: 'inherit',
              resolvedFastMode: null,
              fastResolutionReason: null,
            },
            createdAt: Date.now(),
          })
        );

        const handler = handlers.get(TEAM_LAUNCH)!;
        const result = (await handler({ sender: { send: vi.fn() } } as never, {
          teamName: 'codex-default-model-team',
          cwd: os.tmpdir(),
          providerId: 'codex',
          providerBackendId: 'codex-native',
          model: undefined,
          effort: 'low',
        })) as { success: boolean };

        expect(result).toMatchObject({ success: true });
        expect(teamHandlerMocks.launchTeam).toHaveBeenCalledWith(
          expect.objectContaining({
            teamName: 'codex-default-model-team',
            providerId: 'codex',
            providerBackendId: 'codex-native',
            model: undefined,
            effort: 'low',
          }),
          expect.any(Function)
        );
      } finally {
        fs.rmSync(claudeRoot, { recursive: true, force: true });
      }
    });

    it('drops a known stale providerBackendId from explicit Anthropic relaunch payloads', async () => {
      const claudeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-relaunch-stale-backend-'));
      setClaudeBasePathOverride(claudeRoot);
      try {
        const teamDir = path.join(claudeRoot, 'teams', 'runtime-backend-change-team');
        fs.mkdirSync(teamDir, { recursive: true });
        fs.writeFileSync(
          path.join(teamDir, 'config.json'),
          JSON.stringify({ teamName: 'runtime-backend-change-team' })
        );
        fs.writeFileSync(
          path.join(teamDir, 'team.meta.json'),
          JSON.stringify({
            version: 1,
            displayName: 'Runtime Backend Change Team',
            cwd: '/Users/test/project',
            providerId: 'codex',
            providerBackendId: 'codex-native',
            model: 'gpt-5.5',
            effort: 'medium',
            createdAt: Date.now(),
          })
        );

        const handler = handlers.get(TEAM_LAUNCH)!;
        const result = (await handler({ sender: { send: vi.fn() } } as never, {
          teamName: 'runtime-backend-change-team',
          cwd: os.tmpdir(),
          providerId: 'anthropic',
          providerBackendId: 'codex-native',
          model: 'sonnet',
          effort: 'low',
          fastMode: 'inherit',
        })) as { success: boolean };

        expect(result).toMatchObject({ success: true });
        expect(teamHandlerMocks.launchTeam).toHaveBeenCalledWith(
          expect.objectContaining({
            teamName: 'runtime-backend-change-team',
            providerId: 'anthropic',
            providerBackendId: undefined,
            model: 'sonnet',
            effort: 'low',
            fastMode: 'inherit',
          }),
          expect.any(Function)
        );
      } finally {
        fs.rmSync(claudeRoot, { recursive: true, force: true });
      }
    });

    it('still rejects unknown providerBackendId values during launch', async () => {
      const handler = handlers.get(TEAM_LAUNCH)!;
      const result = (await handler({ sender: { send: vi.fn() } } as never, {
        teamName: 'my-team',
        cwd: os.tmpdir(),
        providerId: 'anthropic',
        providerBackendId: 'not-a-backend',
        model: 'sonnet',
      })) as { success: boolean; error?: string };

      expect(result.success).toBe(false);
      expect(result.error).toContain('providerBackendId must be valid');
      expect(teamHandlerMocks.launchTeam).not.toHaveBeenCalled();
    });

    it('rejects invalid launch limitContext before dispatching', async () => {
      const handler = handlers.get(TEAM_LAUNCH)!;
      const result = (await handler({ sender: { send: vi.fn() } } as never, {
        teamName: 'my-team',
        cwd: os.tmpdir(),
        limitContext: 'true',
      })) as { success: boolean; error?: string };

      expect(result.success).toBe(false);
      expect(result.error).toBe('limitContext must be a boolean');
      expect(teamHandlerMocks.launchTeam).not.toHaveBeenCalled();
      expect(teamHandlerMocks.createTeam).not.toHaveBeenCalled();
    });

    it('launchTeam preserves top-level OpenCode provider and backend', async () => {
      const handler = handlers.get(TEAM_LAUNCH)!;
      const result = (await handler({ sender: { send: vi.fn() } } as never, {
        teamName: 'opencode-runtime-team',
        cwd: os.tmpdir(),
        providerId: 'opencode',
        providerBackendId: 'opencode-cli',
        model: 'opencode/minimax-m2.5-free',
        effort: 'medium',
      })) as { success: boolean };

      expect(result.success).toBe(true);
      expect(teamHandlerMocks.launchTeam).toHaveBeenCalledWith(
        expect.objectContaining({
          teamName: 'opencode-runtime-team',
          providerId: 'opencode',
          providerBackendId: 'opencode-cli',
          model: 'opencode/minimax-m2.5-free',
          effort: 'medium',
        }),
        expect.any(Function)
      );
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
