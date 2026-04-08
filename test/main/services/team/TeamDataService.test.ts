import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { setClaudeBasePathOverride } from '../../../../src/main/utils/pathDecoder';
import { buildTaskChangePresenceDescriptor } from '../../../../src/main/services/team/taskChangePresenceUtils';
import { TeamDataService } from '../../../../src/main/services/team/TeamDataService';

import type {
  InboxMessage,
  KanbanState,
  TeamConfig,
  TeamData,
  TeamTask,
  TeamTaskWithKanban,
} from '../../../../src/shared/types/team';

const TASK_COMMENT_FORWARDING_ENV = 'CLAUDE_TEAM_TASK_COMMENT_FORWARDING';
const tempPaths: string[] = [];

function createLeadAssistantEntry(
  uuid: string,
  timestamp: string,
  text: string
): Record<string, unknown> {
  return {
    uuid,
    parentUuid: null,
    type: 'assistant',
    timestamp,
    isSidechain: false,
    userType: 'external',
    cwd: '/repo',
    sessionId: 'lead-1',
    version: '1.0.0',
    gitBranch: 'main',
    requestId: `req-${uuid}`,
    message: {
      role: 'assistant',
      model: 'claude-sonnet',
      id: `msg-${uuid}`,
      type: 'message',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: 1,
        output_tokens: 1,
      },
      content: [{ type: 'text', text }],
    },
  };
}

async function createTempJsonl(entries: Record<string, unknown>[]): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'team-data-lead-session-'));
  tempPaths.push(dir);
  const jsonlPath = path.join(dir, 'lead-1.jsonl');
  await fs.writeFile(
    jsonlPath,
    `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
    'utf8'
  );
  return jsonlPath;
}

async function createTempJsonlInNamedDir(
  dirName: string,
  entries: Record<string, unknown>[]
): Promise<string> {
  const dir = path.join(os.tmpdir(), dirName);
  await fs.mkdir(dir, { recursive: true });
  tempPaths.push(dir);
  const jsonlPath = path.join(dir, 'lead-1.jsonl');
  await fs.writeFile(
    jsonlPath,
    `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
    'utf8'
  );
  return jsonlPath;
}

function createLeadSessionCachingService(): TeamDataService {
  return new TeamDataService(
    {
      listTeams: vi.fn(),
      getConfig: vi.fn(async () => ({
        name: 'My team',
        members: [{ name: 'team-lead', role: 'Lead' }],
        leadSessionId: 'lead-1',
      })),
    } as never,
    {
      getTasks: vi.fn(async () => []),
    } as never,
    {
      listInboxNames: vi.fn(async () => []),
      getMessages: vi.fn(async () => []),
    } as never,
    {} as never,
    {} as never,
    {
      resolveMembers: vi.fn(() => []),
    } as never,
    {
      getState: vi.fn(async () => ({ teamName: 'my-team', reviewers: [], tasks: {} })),
    } as never,
    {} as never,
    {
      getMembers: vi.fn(async () => []),
    } as never,
    {
      readMessages: vi.fn(async () => []),
    } as never,
    (() =>
      ({
        processes: {
          listProcesses: vi.fn(() => []),
        },
      }) as never) as never,
    {} as never,
    {} as never,
    {
      getMemberAdvisories: vi.fn(async () => new Map()),
    } as never
  );
}

afterEach(async () => {
  setClaudeBasePathOverride(null);
  vi.restoreAllMocks();
  await Promise.all(
    tempPaths.splice(0).map(async (tempPath) => {
      await fs.rm(tempPath, { recursive: true, force: true });
    })
  );
});

function createForwardingJournalStore(initialEntries: Array<Record<string, unknown>> = []) {
  const journalEntries = initialEntries;
  const journal = {
    exists: vi.fn(async () => true),
    ensureFile: vi.fn(async () => undefined),
    withEntries: vi.fn(async (_teamName: string, fn: (entries: unknown[]) => Promise<{ result: unknown }>) => {
      const outcome = await fn(journalEntries);
      return outcome.result;
    }),
  };

  return { journalEntries, journal };
}

function createTaskCommentForwardingService(options: {
  tasks: TeamTask[];
  inboxWriter?: { sendMessage: ReturnType<typeof vi.fn> };
  inboxMessagesForLead?: Array<Record<string, unknown>>;
  journal?: {
    exists: ReturnType<typeof vi.fn>;
    ensureFile: ReturnType<typeof vi.fn>;
    withEntries: ReturnType<typeof vi.fn>;
  };
  members?: Array<{ name: string; role?: string }>;
}) {
  const inboxWriter = options.inboxWriter ?? { sendMessage: vi.fn(async () => ({ deliveredToInbox: true, messageId: 'msg-1' })) };
  const journal = options.journal ?? createForwardingJournalStore().journal;

  const service = new TeamDataService(
    {
      listTeams: vi.fn(),
      getConfig: vi.fn(async () => ({
        name: 'My team',
        members: options.members ?? [{ name: 'team-lead', role: 'Lead' }],
        leadSessionId: 'lead-1',
      })),
    } as never,
    {
      getTasks: vi.fn(async () => options.tasks),
    } as never,
    {
      listInboxNames: vi.fn(async () => []),
      getMessages: vi.fn(async () => []),
      getMessagesFor: vi.fn(async () => options.inboxMessagesForLead ?? []),
    } as never,
    inboxWriter as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    (() => ({}) as never) as never,
    journal as never
  );

  return { service, inboxWriter, journal };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function buildDefaultTeamConfig(overrides: Partial<TeamConfig> = {}): TeamConfig {
  return {
    name: 'My team',
    members: [{ name: 'team-lead', role: 'Lead' }],
    leadSessionId: 'lead-1',
    ...overrides,
  };
}

function createGetTeamDataHarness(options: {
  config?: TeamConfig | null;
  getTasks?: () => Promise<TeamTask[]>;
  listInboxNames?: () => Promise<string[]>;
  getMessages?: () => Promise<InboxMessage[]>;
  getMembers?: () => Promise<TeamConfig['members']>;
  getState?: () => Promise<KanbanState>;
  readMessages?: () => Promise<InboxMessage[]>;
  resolveMembers?: (
    config: TeamConfig,
    metaMembers: TeamConfig['members'],
    inboxNames: string[],
    tasks: TeamTaskWithKanban[],
    messages: InboxMessage[]
  ) => TeamData['members'];
  listProcesses?: () => TeamData['processes'];
  getMemberAdvisories?: () => Promise<Map<string, unknown>>;
} = {}) {
  const getConfig = vi.fn(async () =>
    options.config === undefined ? buildDefaultTeamConfig() : options.config
  );
  const getTasks =
    options.getTasks ??
    (async () => {
      return [] as TeamTask[];
    });
  const listInboxNames =
    options.listInboxNames ??
    (async () => {
      return [] as string[];
    });
  const getMessages =
    options.getMessages ??
    (async () => {
      return [] as InboxMessage[];
    });
  const getMembers =
    options.getMembers ??
    (async () => {
      return [] as TeamConfig['members'];
    });
  const getState =
    options.getState ??
    (async () => {
      return { teamName: 'my-team', reviewers: [], tasks: {} } as KanbanState;
    });
  const readMessages =
    options.readMessages ??
    (async () => {
      return [] as InboxMessage[];
    });
  const resolveMembers = options.resolveMembers ?? (() => []);
  const listProcesses = options.listProcesses ?? (() => []);
  const getMemberAdvisories =
    options.getMemberAdvisories ??
    (async () => {
      return new Map<string, unknown>();
    });

  const taskReader = {
    getTasks: vi.fn(getTasks),
  };
  const inboxReader = {
    listInboxNames: vi.fn(listInboxNames),
    getMessages: vi.fn(getMessages),
  };
  const membersMetaStore = {
    getMembers: vi.fn(getMembers),
  };
  const sentMessagesStore = {
    readMessages: vi.fn(readMessages),
  };
  const resolveMembersSpy = vi.fn(resolveMembers);
  const kanbanManager = {
    getState: vi.fn(getState),
    garbageCollect: vi.fn(async () => undefined),
  };
  const listProcessesSpy = vi.fn(listProcesses);
  const advisoryService = {
    getMemberAdvisories: vi.fn(getMemberAdvisories),
  };

  const service = new TeamDataService(
    {
      listTeams: vi.fn(),
      getConfig,
    } as never,
    taskReader as never,
    inboxReader as never,
    {} as never,
    {} as never,
    {
      resolveMembers: resolveMembersSpy,
    } as never,
    kanbanManager as never,
    {} as never,
    membersMetaStore as never,
    sentMessagesStore as never,
    (() =>
      ({
        processes: {
          listProcesses: listProcessesSpy,
        },
      }) as never) as never,
    {} as never,
    {} as never,
    advisoryService as never
  );

  return {
    service,
    getConfig,
    taskReader,
    inboxReader,
    membersMetaStore,
    sentMessagesStore,
    resolveMembersSpy,
    kanbanManager,
    listProcessesSpy,
    advisoryService,
  };
}

describe('TeamDataService', () => {
  it('keeps getTeamData read-only and skips kanban garbage-collect', async () => {
    const order: string[] = [];
    const tasks: TeamTask[] = [
      {
        id: '12',
        subject: 'Task',
        status: 'pending',
      },
    ];

    const service = new TeamDataService(
      {
        listTeams: vi.fn(),
        getConfig: vi.fn(async () => ({ name: 'My team', members: [] })),
      } as never,
      {
        getTasks: vi.fn(async () => {
          order.push('tasks');
          return tasks;
        }),
      } as never,
      {
        listInboxNames: vi.fn(async () => []),
        getMessages: vi.fn(async () => []),
      } as never,
      {} as never,
      {} as never,
      {
        resolveMembers: vi.fn(() => []),
      } as never,
      {
        getState: vi.fn(async () => ({ teamName: 'my-team', reviewers: [], tasks: {} })),
        garbageCollect: vi.fn(async () => {
          order.push('gc');
        }),
      } as never
    );

    await service.getTeamData('my-team');
    expect(order).toEqual(['tasks']);
  });

  it('delegates explicit reconcile to controller maintenance API', async () => {
    const reconcileArtifacts = vi.fn();
    const service = new TeamDataService(
      {
        listTeams: vi.fn(),
        getConfig: vi.fn(async () => ({ name: 'My team', members: [{ name: 'team-lead', role: 'Lead' }] })),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {
        resolveMembers: vi.fn(() => []),
      } as never,
      {
        getState: vi.fn(async () => ({ teamName: 'my-team', reviewers: [], tasks: {} })),
        garbageCollect: vi.fn(async () => undefined),
      } as never,
      {} as never,
      {
        readMembers: vi.fn(async () => []),
      } as never,
      {
        readMessages: vi.fn(async () => []),
      } as never,
      () =>
        ({
          maintenance: {
            reconcileArtifacts,
          },
        }) as never
    );

    await service.reconcileTeamArtifacts('my-team');
    expect(reconcileArtifacts).toHaveBeenCalledWith({ reason: 'file-watch' });
  });

  it('starts and stops task change presence tracking outside getTeamData', async () => {
    const enableTracking = vi.fn(async () => undefined);
    const disableTracking = vi.fn(async () => undefined);

    const service = new TeamDataService(
      {
        listTeams: vi.fn(),
        getConfig: vi.fn(async () => ({ name: 'My team', members: [] })),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {
        resolveMembers: vi.fn(() => []),
      } as never,
      {
        getState: vi.fn(async () => ({ teamName: 'my-team', reviewers: [], tasks: {} })),
        garbageCollect: vi.fn(async () => undefined),
      } as never
    );

    service.setTaskChangePresenceServices(
      {
        load: vi.fn(async () => null),
        save: vi.fn(async () => undefined),
        deleteTasks: vi.fn(async () => undefined),
      } as never,
      {
        enableTracking,
        disableTracking,
      } as never
    );

    service.setTaskChangePresenceTracking('my-team', true);
    service.setTaskChangePresenceTracking('my-team', false);
    await Promise.resolve();

    expect(enableTracking).toHaveBeenNthCalledWith(1, 'my-team', 'change_presence');
    expect(disableTracking).toHaveBeenNthCalledWith(1, 'my-team', 'change_presence');
  });

  it('surfaces controller reconcile failures', async () => {
    const reconcileArtifacts = vi.fn(() => {
      throw new Error('reconcile failed');
    });
    const service = new TeamDataService(
      {
        listTeams: vi.fn(),
        getConfig: vi.fn(async () => ({ name: 'My team', members: [] })),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {
        resolveMembers: vi.fn(() => []),
      } as never,
      {
        getState: vi.fn(async () => ({ teamName: 'my-team', reviewers: [], tasks: {} })),
        garbageCollect: vi.fn(async () => undefined),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      () =>
        ({
          maintenance: {
            reconcileArtifacts,
          },
        }) as never
    );

    await expect(service.reconcileTeamArtifacts('my-team')).rejects.toThrow('reconcile failed');
  });

  it('writes UI task comments with author user', async () => {
    const addTaskComment = vi.fn(() => ({
      comment: {
        id: 'comment-1',
        author: 'user',
        text: 'Need clarification',
        createdAt: '2026-03-07T20:00:00.000Z',
        type: 'regular',
      },
      task: {
        id: 'task-1',
        subject: 'Investigate',
        status: 'pending',
        owner: 'team-lead',
      },
    }));

    const service = new TeamDataService(
      {
        listTeams: vi.fn(),
        getConfig: vi.fn(async () => ({ name: 'My team', members: [{ name: 'team-lead', role: 'Lead' }] })),
      } as never,
      {
        getTasks: vi.fn(async () => []),
      } as never,
      {
        listInboxNames: vi.fn(async () => []),
        getMessages: vi.fn(async () => []),
      } as never,
      {} as never,
      {} as never,
      {
        resolveMembers: vi.fn(() => []),
      } as never,
      {
        getState: vi.fn(async () => ({ teamName: 'my-team', reviewers: [], tasks: {} })),
        garbageCollect: vi.fn(async () => undefined),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      () =>
        ({
          tasks: {
            addTaskComment,
            setNeedsClarification: vi.fn(),
          },
        }) as never
    );

    await service.addTaskComment('my-team', 'task-1', 'Need clarification');

    expect(addTaskComment).toHaveBeenCalledWith('task-1', {
      from: 'user',
      text: 'Need clarification',
      attachments: undefined,
    });
  });

  it('includes projectPath from config when creating a task', async () => {
    const createTaskMock = vi.fn((task) => task);

    const service = new TeamDataService(
      {
        listTeams: vi.fn(),
        getConfig: vi.fn(async () => ({
          name: 'My team',
          members: [],
          projectPath: '/Users/dev/my-project',
        })),
      } as never,
      {
        getNextTaskId: vi.fn(async () => '1'),
        getTasks: vi.fn(async () => []),
      } as never,
      {
        listInboxNames: vi.fn(async () => []),
        getMessages: vi.fn(async () => []),
      } as never,
      {} as never,
      {
        createTask: createTaskMock,
        addBlocksEntry: vi.fn(async () => undefined),
      } as never,
      {
        resolveMembers: vi.fn(() => []),
      } as never,
      {
        getState: vi.fn(async () => ({ teamName: 'my-team', reviewers: [], tasks: {} })),
        garbageCollect: vi.fn(async () => undefined),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      (teamName: string) =>
        ({
          tasks: {
            createTask: createTaskMock,
          },
        }) as never
    );

    const result = await service.createTask('my-team', { subject: 'Test' });

    expect(result.projectPath).toBe('/Users/dev/my-project');
    expect(createTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({ projectPath: '/Users/dev/my-project' })
    );
  });

  it('creates task with status pending when startImmediately is false', async () => {
    const createTaskMock = vi.fn((task) => ({ ...task, status: 'pending' }));
    const service = new TeamDataService(
      {
        listTeams: vi.fn(),
        getConfig: vi.fn(async () => ({ name: 'My team', members: [] })),
      } as never,
      {
        getNextTaskId: vi.fn(async () => '2'),
        getTasks: vi.fn(async () => []),
      } as never,
      {
        listInboxNames: vi.fn(async () => []),
        getMessages: vi.fn(async () => []),
      } as never,
      {} as never,
      {
        createTask: createTaskMock,
        addBlocksEntry: vi.fn(async () => undefined),
      } as never,
      {
        resolveMembers: vi.fn(() => []),
      } as never,
      {
        getState: vi.fn(async () => ({ teamName: 'my-team', reviewers: [], tasks: {} })),
        garbageCollect: vi.fn(async () => undefined),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      (teamName: string) =>
        ({
          tasks: {
            createTask: createTaskMock,
          },
        }) as never
    );

    const result = await service.createTask('my-team', {
      subject: 'Review main file',
      owner: 'alice',
      startImmediately: false,
    });

    expect(result.status).toBe('pending');
    expect(createTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'alice', createdBy: 'user' })
    );
    expect(createTaskMock).not.toHaveBeenCalledWith(expect.objectContaining({ startImmediately: true }));
  });

  it('creates task with explicit immediate start only when startImmediately is true', async () => {
    const createTaskMock = vi.fn((task) => ({ ...task, status: 'in_progress' }));
    const service = new TeamDataService(
      {
        listTeams: vi.fn(),
        getConfig: vi.fn(async () => ({ name: 'My team', members: [] })),
      } as never,
      {
        getNextTaskId: vi.fn(async () => '2'),
        getTasks: vi.fn(async () => []),
      } as never,
      {
        listInboxNames: vi.fn(async () => []),
        getMessages: vi.fn(async () => []),
      } as never,
      {} as never,
      {
        createTask: createTaskMock,
        addBlocksEntry: vi.fn(async () => undefined),
      } as never,
      {
        resolveMembers: vi.fn(() => []),
      } as never,
      {
        getState: vi.fn(async () => ({ teamName: 'my-team', reviewers: [], tasks: {} })),
        garbageCollect: vi.fn(async () => undefined),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      (_teamName: string) =>
        ({
          tasks: {
            createTask: createTaskMock,
          },
        }) as never
    );

    const result = await service.createTask('my-team', {
      subject: 'Start now',
      owner: 'alice',
      startImmediately: true,
      prompt: 'Begin immediately.',
    });

    expect(result.status).toBe('in_progress');
    expect(createTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'alice',
        createdBy: 'user',
        startImmediately: true,
        prompt: 'Begin immediately.',
      })
    );
    expect(createTaskMock).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'in_progress' }));
  });

  it('persists explicit related task links when creating a task', async () => {
    const createTaskMock = vi.fn((task) => task);
    const service = new TeamDataService(
      {
        listTeams: vi.fn(),
        getConfig: vi.fn(async () => ({ name: 'My team', members: [] })),
      } as never,
      {
        getNextTaskId: vi.fn(async () => '3'),
        getTasks: vi.fn(async () => []),
      } as never,
      {
        listInboxNames: vi.fn(async () => []),
        getMessages: vi.fn(async () => []),
      } as never,
      {} as never,
      {
        createTask: createTaskMock,
        addBlocksEntry: vi.fn(async () => undefined),
      } as never,
      {
        resolveMembers: vi.fn(() => []),
      } as never,
      {
        getState: vi.fn(async () => ({ teamName: 'my-team', reviewers: [], tasks: {} })),
        garbageCollect: vi.fn(async () => undefined),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      (teamName: string) =>
        ({
          tasks: {
            createTask: createTaskMock,
          },
        }) as never
    );

    const result = await service.createTask('my-team', {
      subject: 'Review work task',
      related: ['1', '2'],
    });

    expect(result.related).toEqual(['1', '2']);
    expect(createTaskMock).toHaveBeenCalledWith(expect.objectContaining({ related: ['1', '2'] }));
  });

  it('routes durable inbox writes through controller message API', async () => {
    const sendMessageMock = vi.fn(() => ({ deliveredToInbox: true, messageId: 'm-1' }));

    const service = new TeamDataService(
      {
        listTeams: vi.fn(),
        getConfig: vi.fn(async () => ({ name: 'My team', members: [], leadSessionId: 'lead-1' })),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      () =>
        ({
          messages: {
            sendMessage: sendMessageMock,
          },
        }) as never
    );

    const result = await service.sendMessage('my-team', {
      member: 'alice',
      text: 'hello',
      summary: 'ping',
    });

    expect(result).toEqual({ deliveredToInbox: true, messageId: 'm-1' });
    expect(sendMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        member: 'alice',
        text: 'hello',
        summary: 'ping',
        leadSessionId: 'lead-1',
      })
    );
  });

  it('delegates review entry to controller review API', async () => {
    const requestReviewMock = vi.fn();

    const service = new TeamDataService(
      {
        listTeams: vi.fn(),
        getConfig: vi.fn(async () => ({
          name: 'My team',
          members: [{ name: 'lead', role: 'team lead' }],
          leadSessionId: 'lead-1',
        })),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      () =>
        ({
          review: {
            requestReview: requestReviewMock,
          },
        }) as never
    );

    await service.requestReview('my-team', 'task-1');

    expect(requestReviewMock).toHaveBeenCalledWith('task-1', {
      from: 'user',
      leadSessionId: 'lead-1',
    });
  });

  it('propagates leadSessionId for kanban-driven review transitions', async () => {
    const requestReviewMock = vi.fn();
    const approveReviewMock = vi.fn();
    const requestChangesMock = vi.fn();

    const service = new TeamDataService(
      {
        listTeams: vi.fn(),
        getConfig: vi.fn(async () => ({
          name: 'My team',
          members: [{ name: 'lead', role: 'team lead' }],
          leadSessionId: 'lead-2',
        })),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      () =>
        ({
          review: {
            requestReview: requestReviewMock,
            approveReview: approveReviewMock,
            requestChanges: requestChangesMock,
          },
        }) as never
    );

    await service.updateKanban('my-team', 'task-1', { op: 'set_column', column: 'review' });
    await service.updateKanban('my-team', 'task-1', { op: 'set_column', column: 'approved' });
    await service.updateKanban('my-team', 'task-1', { op: 'request_changes', comment: 'Needs fixes' });

    expect(requestReviewMock).toHaveBeenCalledWith('task-1', {
      from: 'user',
      leadSessionId: 'lead-2',
    });
    expect(approveReviewMock).toHaveBeenCalledWith('task-1', {
      from: 'user',
      suppressTaskComment: true,
      'notify-owner': true,
      leadSessionId: 'lead-2',
    });
    expect(requestChangesMock).toHaveBeenCalledWith('task-1', {
      from: 'user',
      comment: 'Needs fixes',
      leadSessionId: 'lead-2',
    });
  });

  it('seeds historical eligible task comments without sending when the journal is missing', async () => {
    const previous = process.env[TASK_COMMENT_FORWARDING_ENV];
    process.env[TASK_COMMENT_FORWARDING_ENV] = 'on';
    const journalEntries: Array<Record<string, unknown>> = [];
    let journalExists = false;
    const inboxWriter = { sendMessage: vi.fn() };
    const journal = {
      exists: vi.fn(async () => journalExists),
      ensureFile: vi.fn(async () => {
        journalExists = true;
      }),
      withEntries: vi.fn(async (_teamName: string, fn: (entries: unknown[]) => Promise<{ result: unknown }>) => {
        const outcome = await fn(journalEntries);
        return outcome.result;
      }),
    };

    try {
      const service = new TeamDataService(
        {
          listTeams: vi.fn(async () => [
            {
              teamName: 'my-team',
              displayName: 'My team',
              description: '',
              memberCount: 1,
              taskCount: 1,
              lastActivity: null,
            },
          ]),
          getConfig: vi.fn(async () => ({
            name: 'My team',
            members: [{ name: 'team-lead', role: 'Lead' }],
            leadSessionId: 'lead-1',
          })),
        } as never,
        {
          getTasks: vi.fn(async () => [
            {
              id: 'task-1',
              displayId: 'abcd1234',
              subject: 'Investigate',
              status: 'pending',
              owner: 'alice',
              comments: [
                {
                  id: 'comment-1',
                  author: 'alice',
                  text: 'Found the root cause.',
                  createdAt: '2026-03-14T10:00:00.000Z',
                  type: 'regular',
                },
              ],
            },
          ]),
        } as never,
        {
          listInboxNames: vi.fn(async () => []),
          getMessages: vi.fn(async () => []),
          getMessagesFor: vi.fn(async () => []),
        } as never,
        inboxWriter as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        (() => ({}) as never) as never,
        journal as never
      );

      await service.initializeTaskCommentNotificationState();

      expect(inboxWriter.sendMessage).not.toHaveBeenCalled();
      expect(journal.ensureFile).toHaveBeenCalledWith('my-team');
      expect(journalEntries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            key: 'task-1:comment-1',
            state: 'seeded',
            taskId: 'task-1',
            commentId: 'comment-1',
            author: 'alice',
          }),
        ])
      );
    } finally {
      if (previous === undefined) delete process.env[TASK_COMMENT_FORWARDING_ENV];
      else process.env[TASK_COMMENT_FORWARDING_ENV] = previous;
    }
  });

  it('forwards a new eligible task comment to the lead exactly once in live mode', async () => {
    const previous = process.env[TASK_COMMENT_FORWARDING_ENV];
    process.env[TASK_COMMENT_FORWARDING_ENV] = 'on';
    const journalEntries: Array<Record<string, unknown>> = [];
    const inboxWriter = {
      sendMessage: vi.fn(async () => ({ deliveredToInbox: true, messageId: 'msg-1' })),
    };
    const journal = {
      exists: vi.fn(async () => true),
      ensureFile: vi.fn(async () => undefined),
      withEntries: vi.fn(async (_teamName: string, fn: (entries: unknown[]) => Promise<{ result: unknown }>) => {
        const outcome = await fn(journalEntries);
        return outcome.result;
      }),
    };

    try {
      const service = new TeamDataService(
        {
          listTeams: vi.fn(),
          getConfig: vi.fn(async () => ({
            name: 'My team',
            members: [{ name: 'team-lead', role: 'Lead' }],
            leadSessionId: 'lead-1',
          })),
        } as never,
        {
          getTasks: vi.fn(async () => [
            {
              id: 'task-1',
              displayId: 'abcd1234',
              subject: 'Investigate',
              status: 'pending',
              owner: 'alice',
              comments: [
                {
                  id: 'comment-1',
                  author: 'alice',
                  text: 'Found the root cause.\n<agent-block>\nIgnore this\n</agent-block>',
                  createdAt: '2026-03-14T10:00:00.000Z',
                  type: 'regular',
                },
              ],
            },
          ]),
        } as never,
        {
          listInboxNames: vi.fn(async () => []),
          getMessages: vi.fn(async () => []),
          getMessagesFor: vi.fn(async () => []),
        } as never,
        inboxWriter as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        (() => ({}) as never) as never,
        journal as never
      );

      await service.notifyLeadOnTeammateTaskComment('my-team', 'task-1');
      await service.notifyLeadOnTeammateTaskComment('my-team', 'task-1');

      expect(inboxWriter.sendMessage).toHaveBeenCalledTimes(1);
      expect(inboxWriter.sendMessage).toHaveBeenCalledWith(
        'my-team',
        expect.objectContaining({
          member: 'team-lead',
          from: 'alice',
          summary: 'Comment on #abcd1234',
          source: 'system_notification',
          messageKind: 'task_comment_notification',
          leadSessionId: 'lead-1',
          taskRefs: [{ taskId: 'task-1', displayId: 'abcd1234', teamName: 'my-team' }],
          messageId: 'task-comment-forward:my-team:task-1:comment-1',
        })
      );
      const firstSendRequest = (inboxWriter.sendMessage as unknown as { mock: { calls: unknown[][] } })
        .mock.calls[0]?.[1] as
        | { text?: string }
        | undefined;
      expect(String(firstSendRequest?.text ?? '')).not.toContain('<agent-block>');
      const sentEntry = journalEntries.find((entry) => entry.key === 'task-1:comment-1');
      expect(sentEntry).toMatchObject({
        state: 'sent',
        messageId: 'task-comment-forward:my-team:task-1:comment-1',
      });
    } finally {
      if (previous === undefined) delete process.env[TASK_COMMENT_FORWARDING_ENV];
      else process.env[TASK_COMMENT_FORWARDING_ENV] = previous;
    }
  });

  it('seeds historical eligible comments across the whole team on the first observed event when the journal is missing', async () => {
    const previous = process.env[TASK_COMMENT_FORWARDING_ENV];
    process.env[TASK_COMMENT_FORWARDING_ENV] = 'on';
    const journalEntries: Array<Record<string, unknown>> = [];
    let journalExists = false;
    const inboxWriter = { sendMessage: vi.fn() };
    const journal = {
      exists: vi.fn(async () => journalExists),
      ensureFile: vi.fn(async () => {
        journalExists = true;
      }),
      withEntries: vi.fn(async (_teamName: string, fn: (entries: unknown[]) => Promise<{ result: unknown }>) => {
        const outcome = await fn(journalEntries);
        return outcome.result;
      }),
    };

    try {
      const service = new TeamDataService(
        {
          listTeams: vi.fn(),
          getConfig: vi.fn(async () => ({
            name: 'My team',
            members: [{ name: 'team-lead', role: 'Lead' }],
          })),
        } as never,
        {
          getTasks: vi.fn(async () => [
            {
              id: 'task-1',
              displayId: 'abcd1234',
              subject: 'Investigate',
              status: 'pending',
              owner: 'alice',
              comments: [
                {
                  id: 'comment-1',
                  author: 'alice',
                  text: 'Still pending from prior attempt.',
                  createdAt: '2026-03-14T10:00:00.000Z',
                  type: 'regular',
                },
              ],
            },
            {
              id: 'task-2',
              displayId: 'efgh5678',
              subject: 'Second historical task',
              status: 'pending',
              owner: 'bob',
              comments: [
                {
                  id: 'comment-2',
                  author: 'bob',
                  text: 'Historical comment on another task.',
                  createdAt: '2026-03-14T10:01:00.000Z',
                  type: 'regular',
                },
              ],
            },
          ]),
        } as never,
        {
          listInboxNames: vi.fn(async () => []),
          getMessages: vi.fn(async () => []),
          getMessagesFor: vi.fn(async () => []),
        } as never,
        inboxWriter as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        (() => ({}) as never) as never,
        journal as never
      );

      await service.notifyLeadOnTeammateTaskComment('my-team', 'task-1');

      expect(inboxWriter.sendMessage).not.toHaveBeenCalled();
      expect(journal.ensureFile).toHaveBeenCalledWith('my-team');
      expect(journalEntries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            key: 'task-1:comment-1',
            state: 'seeded',
            messageId: 'task-comment-forward:my-team:task-1:comment-1',
          }),
          expect.objectContaining({
            key: 'task-2:comment-2',
            state: 'seeded',
            messageId: 'task-comment-forward:my-team:task-2:comment-2',
          }),
        ])
      );
    } finally {
      if (previous === undefined) delete process.env[TASK_COMMENT_FORWARDING_ENV];
      else process.env[TASK_COMMENT_FORWARDING_ENV] = previous;
    }
  });

  it('does not notify for deleted teams', async () => {
    const previous = process.env[TASK_COMMENT_FORWARDING_ENV];
    process.env[TASK_COMMENT_FORWARDING_ENV] = 'on';
    const journalEntries: Array<Record<string, unknown>> = [];
    const inboxWriter = { sendMessage: vi.fn() };
    const journal = {
      exists: vi.fn(async () => true),
      ensureFile: vi.fn(async () => undefined),
      withEntries: vi.fn(async (_teamName: string, fn: (entries: unknown[]) => Promise<{ result: unknown }>) => {
        const outcome = await fn(journalEntries);
        return outcome.result;
      }),
    };

    try {
      const service = new TeamDataService(
        {
          listTeams: vi.fn(),
          getConfig: vi.fn(async () => ({
            name: 'My team',
            deletedAt: '2026-03-14T10:00:00.000Z',
            members: [{ name: 'team-lead', role: 'Lead' }],
          })),
        } as never,
        {
          getTasks: vi.fn(async () => [
            {
              id: 'task-1',
              displayId: 'abcd1234',
              subject: 'Investigate',
              status: 'pending',
              owner: 'alice',
              comments: [
                {
                  id: 'comment-1',
                  author: 'alice',
                  text: 'Deleted teams should not notify.',
                  createdAt: '2026-03-14T10:00:00.000Z',
                  type: 'regular',
                },
              ],
            },
          ]),
        } as never,
        {
          listInboxNames: vi.fn(async () => []),
          getMessages: vi.fn(async () => []),
          getMessagesFor: vi.fn(async () => []),
        } as never,
        inboxWriter as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        (() => ({}) as never) as never,
        journal as never
      );

      await service.notifyLeadOnTeammateTaskComment('my-team', 'task-1');

      expect(inboxWriter.sendMessage).not.toHaveBeenCalled();
      expect(journal.withEntries).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env[TASK_COMMENT_FORWARDING_ENV];
      else process.env[TASK_COMMENT_FORWARDING_ENV] = previous;
    }
  });

  it('reconciles pending_send journal rows without resending when the inbox already contains the message', async () => {
    const previous = process.env[TASK_COMMENT_FORWARDING_ENV];
    process.env[TASK_COMMENT_FORWARDING_ENV] = 'on';
    const journalEntries: Array<Record<string, unknown>> = [
      {
        key: 'task-1:comment-1',
        taskId: 'task-1',
        commentId: 'comment-1',
        author: 'alice',
        messageId: 'task-comment-forward:my-team:task-1:comment-1',
        state: 'pending_send',
        createdAt: '2026-03-14T10:00:00.000Z',
        updatedAt: '2026-03-14T10:00:00.000Z',
      },
    ];
    const inboxWriter = { sendMessage: vi.fn() };
    const journal = {
      exists: vi.fn(async () => true),
      ensureFile: vi.fn(async () => undefined),
      withEntries: vi.fn(async (_teamName: string, fn: (entries: unknown[]) => Promise<{ result: unknown }>) => {
        const outcome = await fn(journalEntries);
        return outcome.result;
      }),
    };

    try {
      const service = new TeamDataService(
        {
          listTeams: vi.fn(async () => [
            {
              teamName: 'my-team',
              displayName: 'My team',
              description: '',
              memberCount: 1,
              taskCount: 1,
              lastActivity: null,
            },
          ]),
          getConfig: vi.fn(async () => ({
            name: 'My team',
            members: [{ name: 'team-lead', role: 'Lead' }],
          })),
        } as never,
        {
          getTasks: vi.fn(async () => [
            {
              id: 'task-1',
              displayId: 'abcd1234',
              subject: 'Investigate',
              status: 'pending',
              owner: 'alice',
              comments: [
                {
                  id: 'comment-1',
                  author: 'alice',
                  text: 'Recovered after restart.',
                  createdAt: '2026-03-14T10:00:00.000Z',
                  type: 'regular',
                },
              ],
            },
          ]),
        } as never,
        {
          listInboxNames: vi.fn(async () => []),
          getMessages: vi.fn(async () => []),
          getMessagesFor: vi.fn(async () => [
            {
              from: 'alice',
              to: 'team-lead',
              text: 'Existing notification',
              timestamp: '2026-03-14T10:00:01.000Z',
              read: false,
              messageId: 'task-comment-forward:my-team:task-1:comment-1',
            },
          ]),
        } as never,
        inboxWriter as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        (() => ({}) as never) as never,
        journal as never
      );

      await service.initializeTaskCommentNotificationState();

      expect(inboxWriter.sendMessage).not.toHaveBeenCalled();
      expect(journalEntries[0]).toMatchObject({
        state: 'sent',
        messageId: 'task-comment-forward:my-team:task-1:comment-1',
      });
    } finally {
      if (previous === undefined) delete process.env[TASK_COMMENT_FORWARDING_ENV];
      else process.env[TASK_COMMENT_FORWARDING_ENV] = previous;
    }
  });

  it('retries pending_send journal rows during startup recovery when inbox does not contain the message', async () => {
    const previous = process.env[TASK_COMMENT_FORWARDING_ENV];
    process.env[TASK_COMMENT_FORWARDING_ENV] = 'on';
    const journalEntries: Array<Record<string, unknown>> = [
      {
        key: 'task-1:comment-1',
        taskId: 'task-1',
        commentId: 'comment-1',
        author: 'alice',
        messageId: 'task-comment-forward:my-team:task-1:comment-1',
        state: 'pending_send',
        createdAt: '2026-03-14T10:00:00.000Z',
        updatedAt: '2026-03-14T10:00:00.000Z',
      },
    ];
    const inboxWriter = {
      sendMessage: vi.fn(async () => ({ deliveredToInbox: true, messageId: 'task-comment-forward:my-team:task-1:comment-1' })),
    };
    const journal = {
      exists: vi.fn(async () => true),
      ensureFile: vi.fn(async () => undefined),
      withEntries: vi.fn(async (_teamName: string, fn: (entries: unknown[]) => Promise<{ result: unknown }>) => {
        const outcome = await fn(journalEntries);
        return outcome.result;
      }),
    };

    try {
      const service = new TeamDataService(
        {
          listTeams: vi.fn(async () => [
            {
              teamName: 'my-team',
              displayName: 'My team',
              description: '',
              memberCount: 1,
              taskCount: 1,
              lastActivity: null,
            },
          ]),
          getConfig: vi.fn(async () => ({
            name: 'My team',
            members: [{ name: 'team-lead', role: 'Lead' }],
          })),
        } as never,
        {
          getTasks: vi.fn(async () => [
            {
              id: 'task-1',
              displayId: 'abcd1234',
              subject: 'Investigate',
              status: 'pending',
              owner: 'alice',
              comments: [
                {
                  id: 'comment-1',
                  author: 'alice',
                  text: 'Recovered after restart and resend.',
                  createdAt: '2026-03-14T10:00:00.000Z',
                  type: 'regular',
                },
              ],
            },
          ]),
        } as never,
        {
          listInboxNames: vi.fn(async () => []),
          getMessages: vi.fn(async () => []),
          getMessagesFor: vi.fn(async () => []),
        } as never,
        inboxWriter as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        (() => ({}) as never) as never,
        journal as never
      );

      await service.initializeTaskCommentNotificationState();

      expect(inboxWriter.sendMessage).toHaveBeenCalledTimes(1);
      expect(journalEntries[0]).toMatchObject({
        state: 'sent',
        messageId: 'task-comment-forward:my-team:task-1:comment-1',
      });
    } finally {
      if (previous === undefined) delete process.env[TASK_COMMENT_FORWARDING_ENV];
      else process.env[TASK_COMMENT_FORWARDING_ENV] = previous;
    }
  });

  it('retries pending_send rows on later task changes when the inbox does not contain the message', async () => {
    const previous = process.env[TASK_COMMENT_FORWARDING_ENV];
    process.env[TASK_COMMENT_FORWARDING_ENV] = 'on';
    const journalEntries: Array<Record<string, unknown>> = [
      {
        key: 'task-1:comment-1',
        taskId: 'task-1',
        commentId: 'comment-1',
        author: 'alice',
        messageId: 'task-comment-forward:my-team:task-1:comment-1',
        state: 'pending_send',
        createdAt: '2026-03-14T10:00:00.000Z',
        updatedAt: '2026-03-14T10:00:00.000Z',
      },
    ];
    const inboxWriter = {
      sendMessage: vi.fn(async () => ({
        deliveredToInbox: true,
        messageId: 'task-comment-forward:my-team:task-1:comment-1',
      })),
    };
    const journal = {
      exists: vi.fn(async () => true),
      ensureFile: vi.fn(async () => undefined),
      withEntries: vi.fn(async (_teamName: string, fn: (entries: unknown[]) => Promise<{ result: unknown }>) => {
        const outcome = await fn(journalEntries);
        return outcome.result;
      }),
    };

    try {
      const service = new TeamDataService(
        {
          listTeams: vi.fn(),
          getConfig: vi.fn(async () => ({
            name: 'My team',
            members: [{ name: 'team-lead', role: 'Lead' }],
          })),
        } as never,
        {
          getTasks: vi.fn(async () => [
            {
              id: 'task-1',
              displayId: 'abcd1234',
              subject: 'Investigate',
              status: 'pending',
              owner: 'alice',
              comments: [
                {
                  id: 'comment-1',
                  author: 'alice',
                  text: 'Retry on later task change.',
                  createdAt: '2026-03-14T10:00:00.000Z',
                  type: 'regular',
                },
              ],
            },
          ]),
        } as never,
        {
          listInboxNames: vi.fn(async () => []),
          getMessages: vi.fn(async () => []),
          getMessagesFor: vi.fn(async () => []),
        } as never,
        inboxWriter as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        (() => ({}) as never) as never,
        journal as never
      );

      await service.notifyLeadOnTeammateTaskComment('my-team', 'task-1');

      expect(inboxWriter.sendMessage).toHaveBeenCalledTimes(1);
      expect(journalEntries[0]).toMatchObject({
        state: 'sent',
        messageId: 'task-comment-forward:my-team:task-1:comment-1',
      });
    } finally {
      if (previous === undefined) delete process.env[TASK_COMMENT_FORWARDING_ENV];
      else process.env[TASK_COMMENT_FORWARDING_ENV] = previous;
    }
  });

  it('does not duplicate later-task-change recovery while a send is already in flight', async () => {
    const previous = process.env[TASK_COMMENT_FORWARDING_ENV];
    process.env[TASK_COMMENT_FORWARDING_ENV] = 'on';
    const journalEntries: Array<Record<string, unknown>> = [
      {
        key: 'task-1:comment-1',
        taskId: 'task-1',
        commentId: 'comment-1',
        author: 'alice',
        messageId: 'task-comment-forward:my-team:task-1:comment-1',
        state: 'pending_send',
        createdAt: '2026-03-14T10:00:00.000Z',
        updatedAt: '2026-03-14T10:00:00.000Z',
      },
    ];
    let releaseSend: (() => void) | undefined;
    let resolveSendStarted: (() => void) | undefined;
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const sendStarted = new Promise<void>((resolve) => {
      resolveSendStarted = resolve;
    });
    const inboxWriter = {
      sendMessage: vi.fn(async () => {
        resolveSendStarted?.();
        await sendGate;
        return {
          deliveredToInbox: true,
          messageId: 'task-comment-forward:my-team:task-1:comment-1',
        };
      }),
    };
    const journal = {
      exists: vi.fn(async () => true),
      ensureFile: vi.fn(async () => undefined),
      withEntries: vi.fn(async (_teamName: string, fn: (entries: unknown[]) => Promise<{ result: unknown }>) => {
        const outcome = await fn(journalEntries);
        return outcome.result;
      }),
    };

    try {
      const service = new TeamDataService(
        {
          listTeams: vi.fn(),
          getConfig: vi.fn(async () => ({
            name: 'My team',
            members: [{ name: 'team-lead', role: 'Lead' }],
          })),
        } as never,
        {
          getTasks: vi.fn(async () => [
            {
              id: 'task-1',
              displayId: 'abcd1234',
              subject: 'Investigate',
              status: 'pending',
              owner: 'alice',
              comments: [
                {
                  id: 'comment-1',
                  author: 'alice',
                  text: 'Concurrent retry protection.',
                  createdAt: '2026-03-14T10:00:00.000Z',
                  type: 'regular',
                },
              ],
            },
          ]),
        } as never,
        {
          listInboxNames: vi.fn(async () => []),
          getMessages: vi.fn(async () => []),
          getMessagesFor: vi.fn(async () => []),
        } as never,
        inboxWriter as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        (() => ({}) as never) as never,
        journal as never
      );

      const first = service.notifyLeadOnTeammateTaskComment('my-team', 'task-1');
      const second = service.notifyLeadOnTeammateTaskComment('my-team', 'task-1');

      await sendStarted;
      expect(inboxWriter.sendMessage).toHaveBeenCalledTimes(1);

      if (!releaseSend) {
        throw new Error('Expected send release');
      }
      releaseSend();

      await first;
      await second;

      expect(inboxWriter.sendMessage).toHaveBeenCalledTimes(1);
      expect(journalEntries[0]).toMatchObject({
        state: 'sent',
      });
    } finally {
      if (previous === undefined) delete process.env[TASK_COMMENT_FORWARDING_ENV];
      else process.env[TASK_COMMENT_FORWARDING_ENV] = previous;
    }
  });

  it('forwards eligible teammate comments even when the commenter is not the current task owner', async () => {
    const previous = process.env[TASK_COMMENT_FORWARDING_ENV];
    process.env[TASK_COMMENT_FORWARDING_ENV] = 'on';
    const journalEntries: Array<Record<string, unknown>> = [];
    const inboxWriter = {
      sendMessage: vi.fn(async () => ({ deliveredToInbox: true, messageId: 'msg-1' })),
    };
    const journal = {
      exists: vi.fn(async () => true),
      ensureFile: vi.fn(async () => undefined),
      withEntries: vi.fn(async (_teamName: string, fn: (entries: unknown[]) => Promise<{ result: unknown }>) => {
        const outcome = await fn(journalEntries);
        return outcome.result;
      }),
    };

    try {
      const service = new TeamDataService(
        {
          listTeams: vi.fn(),
          getConfig: vi.fn(async () => ({
            name: 'My team',
            members: [{ name: 'team-lead', role: 'Lead' }],
            leadSessionId: 'lead-1',
          })),
        } as never,
        {
          getTasks: vi.fn(async () => [
            {
              id: 'task-1',
              displayId: 'abcd1234',
              subject: 'Investigate',
              status: 'pending',
              owner: 'alice',
              comments: [
                {
                  id: 'comment-2',
                  author: 'bob',
                  text: 'Independent research result from another teammate.',
                  createdAt: '2026-03-14T10:05:00.000Z',
                  type: 'regular',
                },
              ],
            },
          ]),
        } as never,
        {
          listInboxNames: vi.fn(async () => []),
          getMessages: vi.fn(async () => []),
          getMessagesFor: vi.fn(async () => []),
        } as never,
        inboxWriter as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        (() => ({}) as never) as never,
        journal as never
      );

      await service.notifyLeadOnTeammateTaskComment('my-team', 'task-1');

      expect(inboxWriter.sendMessage).toHaveBeenCalledTimes(1);
      expect(inboxWriter.sendMessage).toHaveBeenCalledWith(
        'my-team',
        expect.objectContaining({
          from: 'bob',
          summary: 'Comment on #abcd1234',
          messageKind: 'task_comment_notification',
          messageId: 'task-comment-forward:my-team:task-1:comment-2',
        })
      );
    } finally {
      if (previous === undefined) delete process.env[TASK_COMMENT_FORWARDING_ENV];
      else process.env[TASK_COMMENT_FORWARDING_ENV] = previous;
    }
  });

  it('does not forward user-authored, lead-authored, mirrored, or non-regular comments', async () => {
    const previous = process.env[TASK_COMMENT_FORWARDING_ENV];
    process.env[TASK_COMMENT_FORWARDING_ENV] = 'on';

    try {
      const { journalEntries, journal } = createForwardingJournalStore();
      const { service, inboxWriter } = createTaskCommentForwardingService({
        journal,
        tasks: [
          {
            id: 'task-1',
            displayId: 'abcd1234',
            subject: 'Investigate',
            status: 'pending',
            owner: 'alice',
            comments: [
              {
                id: 'comment-user',
                author: 'user',
                text: 'User comment should not notify.',
                createdAt: '2026-03-14T10:00:00.000Z',
                type: 'regular',
              },
              {
                id: 'comment-lead',
                author: 'team-lead',
                text: 'Lead already knows this.',
                createdAt: '2026-03-14T10:01:00.000Z',
                type: 'regular',
              },
              {
                id: 'msg-legacy',
                author: 'alice',
                text: 'Mirrored inbox artifact.',
                createdAt: '2026-03-14T10:02:00.000Z',
                type: 'regular',
              },
              {
                id: 'comment-review-request',
                author: 'alice',
                text: 'Please review.',
                createdAt: '2026-03-14T10:03:00.000Z',
                type: 'review_request',
              },
              {
                id: 'comment-review-approved',
                author: 'alice',
                text: 'Approved.',
                createdAt: '2026-03-14T10:04:00.000Z',
                type: 'review_approved',
              },
              {
                id: 'comment-ack',
                author: 'alice',
                text: 'Принято, остаюсь на связи.',
                createdAt: '2026-03-14T10:05:00.000Z',
                type: 'regular',
              },
            ],
          },
        ],
      });

      await service.notifyLeadOnTeammateTaskComment('my-team', 'task-1');

      expect(inboxWriter.sendMessage).not.toHaveBeenCalled();
      expect(journalEntries).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env[TASK_COMMENT_FORWARDING_ENV];
      else process.env[TASK_COMMENT_FORWARDING_ENV] = previous;
    }
  });

  it('does not forward comments for lead-owned tasks', async () => {
    const previous = process.env[TASK_COMMENT_FORWARDING_ENV];
    process.env[TASK_COMMENT_FORWARDING_ENV] = 'on';

    try {
      const { journalEntries, journal } = createForwardingJournalStore();
      const { service, inboxWriter } = createTaskCommentForwardingService({
        journal,
        tasks: [
          {
            id: 'task-1',
            displayId: 'abcd1234',
            subject: 'Lead-owned task',
            status: 'pending',
            owner: 'team-lead',
            comments: [
              {
                id: 'comment-1',
                author: 'alice',
                text: 'Should not create a second lead notification.',
                createdAt: '2026-03-14T10:00:00.000Z',
                type: 'regular',
              },
            ],
          },
        ],
      });

      await service.notifyLeadOnTeammateTaskComment('my-team', 'task-1');

      expect(inboxWriter.sendMessage).not.toHaveBeenCalled();
      expect(journalEntries).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env[TASK_COMMENT_FORWARDING_ENV];
      else process.env[TASK_COMMENT_FORWARDING_ENV] = previous;
    }
  });

  it('does not replay historical comment notifications after lead rename because the journal key is team-level', async () => {
    const previous = process.env[TASK_COMMENT_FORWARDING_ENV];
    process.env[TASK_COMMENT_FORWARDING_ENV] = 'on';

    try {
      const { journalEntries, journal } = createForwardingJournalStore([
        {
          key: 'task-1:comment-1',
          taskId: 'task-1',
          commentId: 'comment-1',
          author: 'alice',
          messageId: 'task-comment-forward:my-team:task-1:comment-1',
          state: 'sent',
          createdAt: '2026-03-14T10:00:00.000Z',
          updatedAt: '2026-03-14T10:00:00.000Z',
          sentAt: '2026-03-14T10:00:00.000Z',
        },
      ]);
      const { service, inboxWriter } = createTaskCommentForwardingService({
        journal,
        members: [{ name: 'new-lead', role: 'Lead' }],
        tasks: [
          {
            id: 'task-1',
            displayId: 'abcd1234',
            subject: 'Investigate',
            status: 'pending',
            owner: 'alice',
            comments: [
              {
                id: 'comment-1',
                author: 'alice',
                text: 'Already forwarded before lead rename.',
                createdAt: '2026-03-14T10:00:00.000Z',
                type: 'regular',
              },
            ],
          },
        ],
      });

      await service.notifyLeadOnTeammateTaskComment('my-team', 'task-1');

      expect(inboxWriter.sendMessage).not.toHaveBeenCalled();
      expect(journalEntries).toHaveLength(1);
      expect(journalEntries[0]).toMatchObject({
        key: 'task-1:comment-1',
        state: 'sent',
      });
    } finally {
      if (previous === undefined) delete process.env[TASK_COMMENT_FORWARDING_ENV];
      else process.env[TASK_COMMENT_FORWARDING_ENV] = previous;
    }
  });

  it('waits for startup initialization before processing watcher-driven comment notifications', async () => {
    const previous = process.env[TASK_COMMENT_FORWARDING_ENV];
    process.env[TASK_COMMENT_FORWARDING_ENV] = 'on';
    let releaseInit: (() => void) | undefined;
    const initGate = new Promise<void>((resolve) => {
      releaseInit = () => resolve();
    });
    const inboxWriter = { sendMessage: vi.fn(async () => ({ deliveredToInbox: true, messageId: 'msg-1' })) };
    const journalEntries: Array<Record<string, unknown>> = [];
    const journal = {
      exists: vi.fn(async () => true),
      ensureFile: vi.fn(async () => undefined),
      withEntries: vi.fn(async (_teamName: string, fn: (entries: unknown[]) => Promise<{ result: unknown }>) => {
        const outcome = await fn(journalEntries);
        return outcome.result;
      }),
    };

    try {
      const service = new TeamDataService(
        {
          listTeams: vi.fn(async () => {
            await initGate;
            return [
              {
                teamName: 'my-team',
                displayName: 'My team',
                description: '',
                memberCount: 1,
                taskCount: 1,
                lastActivity: null,
              },
            ];
          }),
          getConfig: vi.fn(async () => ({
            name: 'My team',
            members: [{ name: 'team-lead', role: 'Lead' }],
          })),
        } as never,
        {
          getTasks: vi.fn(async () => [
            {
              id: 'task-1',
              displayId: 'abcd1234',
              subject: 'Investigate',
              status: 'pending',
              owner: 'alice',
              comments: [
                {
                  id: 'comment-1',
                  author: 'alice',
                  text: 'New comment after startup barrier.',
                  createdAt: '2026-03-14T10:00:00.000Z',
                  type: 'regular',
                },
              ],
            },
          ]),
        } as never,
        {
          listInboxNames: vi.fn(async () => []),
          getMessages: vi.fn(async () => []),
          getMessagesFor: vi.fn(async () => []),
        } as never,
        inboxWriter as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        (() => ({}) as never) as never,
        journal as never
      );

      const initPromise = service.initializeTaskCommentNotificationState();
      const notifyPromise = service.notifyLeadOnTeammateTaskComment('my-team', 'task-1');

      await Promise.resolve();
      expect(inboxWriter.sendMessage).not.toHaveBeenCalled();

      if (!releaseInit) {
        throw new Error('Expected initialization gate release');
      }
      releaseInit();
      await initPromise;
      await notifyPromise;

      expect(inboxWriter.sendMessage).toHaveBeenCalledTimes(1);
    } finally {
      if (previous === undefined) delete process.env[TASK_COMMENT_FORWARDING_ENV];
      else process.env[TASK_COMMENT_FORWARDING_ENV] = previous;
    }
  });

  it('returns unknown changePresence when no cached presence entry exists', async () => {
    const task: TeamTask = {
      id: 'task-1',
      subject: 'Review API',
      status: 'completed',
      owner: 'alice',
      workIntervals: [{ startedAt: '2026-03-01T10:05:00.000Z' }],
      historyEvents: [],
    };

    const service = new TeamDataService(
      {
        listTeams: vi.fn(),
        getConfig: vi.fn(async () => ({ name: 'My team', members: [], projectPath: '/repo' })),
      } as never,
      {
        getTasks: vi.fn(async () => [task]),
      } as never,
      {
        listInboxNames: vi.fn(async () => []),
        getMessages: vi.fn(async () => []),
      } as never,
      {} as never,
      {} as never,
      {
        resolveMembers: vi.fn(() => []),
      } as never,
      {
        getState: vi.fn(async () => ({ teamName: 'my-team', reviewers: [], tasks: {} })),
      } as never
    );

    const load = vi.fn(async () => null);

    service.setTaskChangePresenceServices(
      {
        load,
        upsertEntry: vi.fn(async () => undefined),
      } as never,
      {
        ensureTracking: vi.fn(async () => ({
          projectFingerprint: 'project-fingerprint',
          logSourceGeneration: 'log-generation',
        })),
      } as never
    );

    const data = await service.getTeamData('my-team');

    expect(data.tasks[0]?.changePresence).toBe('unknown');
    expect(load).not.toHaveBeenCalled();
  });

  it('returns cached changePresence only when signature and generation still match', async () => {
    const task: TeamTask = {
      id: 'task-1',
      subject: 'Review API',
      status: 'completed',
      owner: 'alice',
      workIntervals: [{ startedAt: '2026-03-01T10:05:00.000Z' }],
      historyEvents: [],
    };
    const descriptor = buildTaskChangePresenceDescriptor({
      owner: task.owner,
      status: task.status,
      intervals: task.workIntervals,
      historyEvents: task.historyEvents,
      reviewState: 'none',
    });

    const createServiceWithPresence = (
      load: ReturnType<typeof vi.fn>,
      trackerSnapshot: { projectFingerprint: string; logSourceGeneration: string } | null
    ) => {
      const service = new TeamDataService(
        {
          listTeams: vi.fn(),
          getConfig: vi.fn(async () => ({ name: 'My team', members: [], projectPath: '/repo' })),
        } as never,
        {
          getTasks: vi.fn(async () => [task]),
        } as never,
        {
          listInboxNames: vi.fn(async () => []),
          getMessages: vi.fn(async () => []),
        } as never,
        {} as never,
        {} as never,
        {
          resolveMembers: vi.fn(() => []),
        } as never,
        {
          getState: vi.fn(async () => ({ teamName: 'my-team', reviewers: [], tasks: {} })),
        } as never
      );

      service.setTaskChangePresenceServices(
        {
          load,
          upsertEntry: vi.fn(async () => undefined),
        } as never,
        {
          getSnapshot: vi.fn(() => trackerSnapshot),
          ensureTracking: vi.fn(async () => trackerSnapshot),
        } as never
      );

      return service;
    };

    const matched = await createServiceWithPresence(
      vi.fn(async () => ({
        version: 1,
        teamName: 'my-team',
        projectFingerprint: 'project-fingerprint',
        logSourceGeneration: 'log-generation',
        writtenAt: '2026-03-01T12:00:00.000Z',
        entries: {
          'task-1': {
            taskId: 'task-1',
            taskSignature: descriptor.taskSignature,
            presence: 'has_changes',
            writtenAt: '2026-03-01T12:00:00.000Z',
            logSourceGeneration: 'log-generation',
          },
        },
      })),
      {
        projectFingerprint: 'project-fingerprint',
        logSourceGeneration: 'log-generation',
      }
    ).getTeamData('my-team');
    expect(matched.tasks[0]?.changePresence).toBe('has_changes');

    const mismatched = await createServiceWithPresence(
      vi.fn(async () => ({
        version: 1,
        teamName: 'my-team',
        projectFingerprint: 'project-fingerprint',
        logSourceGeneration: 'stale-generation',
        writtenAt: '2026-03-01T12:00:00.000Z',
        entries: {
          'task-1': {
            taskId: 'task-1',
            taskSignature: descriptor.taskSignature,
            presence: 'has_changes',
            writtenAt: '2026-03-01T12:00:00.000Z',
            logSourceGeneration: 'stale-generation',
          },
        },
      })),
      {
        projectFingerprint: 'project-fingerprint',
        logSourceGeneration: 'log-generation',
      }
    ).getTeamData('my-team');
    expect(mismatched.tasks[0]?.changePresence).toBe('unknown');
  });

  it('preserves cached changePresence when persisted entry was recorded with derived since', async () => {
    const task: TeamTask = {
      id: 'task-1',
      subject: 'Review API',
      status: 'completed',
      owner: 'alice',
      createdAt: '2026-03-01T10:05:00.000Z',
      workIntervals: [{ startedAt: '2026-03-01T10:10:00.000Z' }],
      historyEvents: [
        {
          id: 'evt-1',
          type: 'status_changed',
          from: 'pending',
          to: 'in_progress',
          timestamp: '2026-03-01T10:00:00.000Z',
        },
      ],
    };

    const persistedDescriptor = buildTaskChangePresenceDescriptor({
      createdAt: task.createdAt,
      owner: task.owner,
      status: task.status,
      intervals: task.workIntervals,
      since: '2026-03-01T09:58:00.000Z',
      historyEvents: task.historyEvents,
      reviewState: 'none',
    });

    const service = new TeamDataService(
      {
        listTeams: vi.fn(),
        getConfig: vi.fn(async () => ({ name: 'My team', members: [], projectPath: '/repo' })),
      } as never,
      {
        getTasks: vi.fn(async () => [task]),
      } as never,
      {
        listInboxNames: vi.fn(async () => []),
        getMessages: vi.fn(async () => []),
      } as never,
      {} as never,
      {} as never,
      {
        resolveMembers: vi.fn(() => []),
      } as never,
      {
        getState: vi.fn(async () => ({ teamName: 'my-team', reviewers: [], tasks: {} })),
      } as never
    );

    service.setTaskChangePresenceServices(
      {
        load: vi.fn(async () => ({
          version: 1,
          teamName: 'my-team',
          projectFingerprint: 'project-fingerprint',
          logSourceGeneration: 'log-generation',
          writtenAt: '2026-03-01T12:00:00.000Z',
          entries: {
            'task-1': {
              taskId: 'task-1',
              taskSignature: persistedDescriptor.taskSignature,
              presence: 'has_changes',
              writtenAt: '2026-03-01T12:00:00.000Z',
              logSourceGeneration: 'log-generation',
            },
          },
        })),
        upsertEntry: vi.fn(async () => undefined),
      } as never,
      {
        getSnapshot: vi.fn(() => ({
          projectFingerprint: 'project-fingerprint',
          logSourceGeneration: 'log-generation',
        })),
        ensureTracking: vi.fn(async () => ({
          projectFingerprint: 'project-fingerprint',
          logSourceGeneration: 'log-generation',
        })),
      } as never
    );

    const data = await service.getTeamData('my-team');

    expect(data.tasks[0]?.changePresence).toBe('has_changes');
  });

  it('returns lightweight task change presence without loading full team data', async () => {
    const task: TeamTask = {
      id: 'task-1',
      subject: 'Review API',
      status: 'completed',
      owner: 'alice',
      workIntervals: [{ startedAt: '2026-03-01T10:05:00.000Z' }],
      historyEvents: [],
    };
    const descriptor = buildTaskChangePresenceDescriptor({
      owner: task.owner,
      status: task.status,
      intervals: task.workIntervals,
      historyEvents: task.historyEvents,
      reviewState: 'none',
    });
    const getMessages = vi.fn(async () => []);

    const service = new TeamDataService(
      {
        listTeams: vi.fn(),
        getConfig: vi.fn(async () => ({ name: 'My team', members: [], projectPath: '/repo' })),
      } as never,
      {
        getTasks: vi.fn(async () => [task]),
      } as never,
      {
        listInboxNames: vi.fn(async () => []),
        getMessages,
      } as never,
      {} as never,
      {} as never,
      {
        resolveMembers: vi.fn(() => []),
      } as never,
      {
        getState: vi.fn(async () => ({ teamName: 'my-team', reviewers: [], tasks: {} })),
      } as never
    );

    service.setTaskChangePresenceServices(
      {
        load: vi.fn(async () => ({
          version: 1,
          teamName: 'my-team',
          projectFingerprint: 'project-fingerprint',
          logSourceGeneration: 'log-generation',
          writtenAt: '2026-03-01T12:00:00.000Z',
          entries: {
            'task-1': {
              taskId: 'task-1',
              taskSignature: descriptor.taskSignature,
              presence: 'has_changes',
              writtenAt: '2026-03-01T12:00:00.000Z',
              logSourceGeneration: 'log-generation',
            },
          },
        })),
        upsertEntry: vi.fn(async () => undefined),
      } as never,
      {
        getSnapshot: vi.fn(() => ({
          projectFingerprint: 'project-fingerprint',
          logSourceGeneration: 'log-generation',
        })),
        ensureTracking: vi.fn(async () => ({
          projectFingerprint: 'project-fingerprint',
          logSourceGeneration: 'log-generation',
        })),
      } as never
    );

    const data = await service.getTaskChangePresence('my-team');

    expect(data).toEqual({ 'task-1': 'has_changes' });
    expect(getMessages).not.toHaveBeenCalled();
  });

  it('persists standalone slash metadata when sending directly to the live lead', async () => {
    const appendSentMessage = vi.fn((payload) => payload);
    const service = new TeamDataService(
      {
        listTeams: vi.fn(),
        getConfig: vi.fn(async () => ({
          name: 'My team',
          members: [{ name: 'team-lead', role: 'Lead' }],
          leadSessionId: 'lead-1',
        })),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      () =>
        ({
          messages: {
            appendSentMessage,
          },
        }) as never
    );

    const result = await service.sendDirectToLead(
      'my-team',
      'team-lead',
      '/compact keep only kanban context'
    );

    expect(result.deliveredViaStdin).toBe(true);
    expect(appendSentMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: '/compact keep only kanban context',
        messageKind: 'slash_command',
        slashCommand: expect.objectContaining({
          name: 'compact',
          command: '/compact',
          args: 'keep only kanban context',
        }),
      })
    );
  });

  it('annotates immediate lead replies after slash commands as command results', async () => {
    const service = new TeamDataService(
      {
        listTeams: vi.fn(),
        getConfig: vi.fn(async () => ({
          name: 'My team',
          members: [{ name: 'team-lead', role: 'Lead' }],
          leadSessionId: 'lead-1',
        })),
      } as never,
      {
        getTasks: vi.fn(async () => []),
      } as never,
      {
        listInboxNames: vi.fn(async () => []),
        getMessages: vi.fn(async () => [
          {
            from: 'team-lead',
            text: 'Total cost: $1.05',
            timestamp: '2026-03-27T22:17:01.000Z',
            read: true,
            source: 'lead_process',
            leadSessionId: 'lead-1',
            messageId: 'lead-thought-1',
          },
        ]),
      } as never,
      {} as never,
      {} as never,
      {
        resolveMembers: vi.fn(() => []),
      } as never,
      {
        getState: vi.fn(async () => ({ teamName: 'my-team', reviewers: [], tasks: {} })),
      } as never,
      {} as never,
      {} as never,
      {
        readMessages: vi.fn(async () => [
          {
            from: 'user',
            to: 'team-lead',
            text: '/cost',
            timestamp: '2026-03-27T22:17:00.000Z',
            read: true,
            source: 'user_sent',
            leadSessionId: 'lead-1',
            messageId: 'user-cost-1',
          },
        ]),
      } as never
    );

    const data = await service.getTeamData('my-team');
    const costResult = data.messages.find((message) => message.messageId === 'lead-thought-1');

    expect(costResult).toMatchObject({
      messageKind: 'slash_command_result',
      commandOutput: {
        stream: 'stdout',
        commandLabel: '/cost',
      },
    });
  });

  it('keeps the inbox passive-summary row preferred over a read-state-changed lead_process duplicate', async () => {
    const service = new TeamDataService(
      {
        listTeams: vi.fn(),
        getConfig: vi.fn(async () => ({
          name: 'My team',
          members: [{ name: 'team-lead', role: 'Lead' }],
          leadSessionId: 'lead-1',
        })),
      } as never,
      {
        getTasks: vi.fn(async () => []),
      } as never,
      {
        listInboxNames: vi.fn(async () => []),
        getMessages: vi.fn(async () => [
          {
            from: 'alice',
            text: JSON.stringify({
              type: 'idle_notification',
              idleReason: 'available',
              summary: '[to bob] aligned on rollout order',
            }),
            timestamp: '2026-04-08T10:00:00.000Z',
            read: true,
            summary: 'Peer summary',
            messageId: 'passive-idle-dup-1',
          },
          {
            from: 'alice',
            text: JSON.stringify({
              type: 'idle_notification',
              idleReason: 'available',
              summary: '[to bob] aligned on rollout order',
            }),
            timestamp: '2026-04-08T10:00:01.000Z',
            read: false,
            source: 'lead_process',
            relayOfMessageId: 'passive-idle-dup-1',
            messageId: 'passive-idle-dup-1',
          },
        ]),
      } as never,
      {} as never,
      {} as never,
      {
        resolveMembers: vi.fn(() => []),
      } as never,
      {
        getState: vi.fn(async () => ({ teamName: 'my-team', reviewers: [], tasks: {} })),
      } as never,
      {} as never,
      {} as never,
      {
        readMessages: vi.fn(async () => []),
      } as never
    );

    const data = await service.getTeamData('my-team');
    const result = data.messages.find((message) => message.messageId === 'passive-idle-dup-1');

    expect(result).toBeDefined();
    expect(result?.source).not.toBe('lead_process');
    expect(result).toMatchObject({
      summary: 'Peer summary',
      read: true,
    });
  });

  it('caches unchanged lead-session extraction results and returns defensive clones', async () => {
    const service = createLeadSessionCachingService();
    const jsonlPath = await createTempJsonl([
      createLeadAssistantEntry(
        'assistant-1',
        '2026-03-27T22:17:01.000Z',
        'This is a sufficiently long assistant thought for cache validation.'
      ),
    ]);

    const assistantSpy = vi.spyOn(service as never, 'extractLeadAssistantTextsFromJsonl' as never);
    const extract = (
      service as unknown as {
        extractLeadSessionTextsFromJsonl: (
          jsonlPath: string,
          leadName: string,
          leadSessionId: string,
          maxTexts: number
        ) => Promise<Array<{ text: string }>>;
      }
    ).extractLeadSessionTextsFromJsonl.bind(service);

    const first = await extract(jsonlPath, 'team-lead', 'lead-1', 150);
    first[0]!.text = 'mutated locally';

    const second = await extract(jsonlPath, 'team-lead', 'lead-1', 150);

    expect(assistantSpy).toHaveBeenCalledTimes(1);
    expect(second[0]?.text).toBe(
      'This is a sufficiently long assistant thought for cache validation.'
    );
  });

  it('coalesces concurrent lead-session parses for the same file signature', async () => {
    const service = createLeadSessionCachingService();
    const jsonlPath = await createTempJsonl([
      createLeadAssistantEntry(
        'assistant-1',
        '2026-03-27T22:17:01.000Z',
        'This is a sufficiently long assistant thought for in-flight coalescing.'
      ),
    ]);

    const originalExtract = (
      service as unknown as {
        extractLeadAssistantTextsFromJsonl: (
          jsonlPath: string,
          leadName: string,
          leadSessionId: string,
          maxTexts: number
        ) => Promise<Array<{ text: string }>>;
      }
    ).extractLeadAssistantTextsFromJsonl.bind(service);
    const assistantSpy = vi
      .spyOn(service as never, 'extractLeadAssistantTextsFromJsonl' as never)
      .mockImplementation(async (...args: unknown[]) => {
        const [targetPath, leadName, leadSessionId, maxTexts] = args as [
          string,
          string,
          string,
          number,
        ];
        await new Promise((resolve) => setTimeout(resolve, 25));
        return originalExtract(targetPath, leadName, leadSessionId, maxTexts);
      });
    const extract = (
      service as unknown as {
        extractLeadSessionTextsFromJsonl: (
          jsonlPath: string,
          leadName: string,
          leadSessionId: string,
          maxTexts: number
        ) => Promise<Array<{ text: string }>>;
      }
    ).extractLeadSessionTextsFromJsonl.bind(service);

    const [first, second] = await Promise.all([
      extract(jsonlPath, 'team-lead', 'lead-1', 150),
      extract(jsonlPath, 'team-lead', 'lead-1', 150),
    ]);

    expect(assistantSpy).toHaveBeenCalledTimes(1);
    expect(first[0]?.text).toBe(second[0]?.text);
  });

  it('does not populate the fulfilled cache when the file changes during parse', async () => {
    const service = createLeadSessionCachingService();
    const jsonlPath = await createTempJsonl([
      createLeadAssistantEntry(
        'assistant-1',
        '2026-03-27T22:17:01.000Z',
        'This is a sufficiently long assistant thought before mutation.'
      ),
    ]);

    const originalExtract = (
      service as unknown as {
        extractLeadAssistantTextsFromJsonl: (
          jsonlPath: string,
          leadName: string,
          leadSessionId: string,
          maxTexts: number
        ) => Promise<Array<{ text: string }>>;
      }
    ).extractLeadAssistantTextsFromJsonl.bind(service);
    let appended = false;
    const assistantSpy = vi
      .spyOn(service as never, 'extractLeadAssistantTextsFromJsonl' as never)
      .mockImplementation(async (...args: unknown[]) => {
        const [targetPath, leadName, leadSessionId, maxTexts] = args as [
          string,
          string,
          string,
          number,
        ];
        if (!appended) {
          appended = true;
          await fs.appendFile(
            targetPath,
            `${JSON.stringify(
              createLeadAssistantEntry(
                'assistant-2',
                '2026-03-27T22:17:02.000Z',
                'This is a sufficiently long assistant thought appended during parse.'
              )
            )}\n`,
            'utf8'
          );
        }
        return originalExtract(targetPath, leadName, leadSessionId, maxTexts);
      });
    const extract = (
      service as unknown as {
        extractLeadSessionTextsFromJsonl: (
          jsonlPath: string,
          leadName: string,
          leadSessionId: string,
          maxTexts: number
        ) => Promise<Array<{ text: string }>>;
      }
    ).extractLeadSessionTextsFromJsonl.bind(service);

    const first = await extract(jsonlPath, 'team-lead', 'lead-1', 150);
    const second = await extract(jsonlPath, 'team-lead', 'lead-1', 150);

    expect(assistantSpy).toHaveBeenCalledTimes(2);
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(2);
  });

  it('does not reuse an older in-flight parse after the file signature changes', async () => {
    const service = createLeadSessionCachingService();
    const jsonlPath = await createTempJsonl([
      createLeadAssistantEntry(
        'assistant-1',
        '2026-03-27T22:17:01.000Z',
        'This is a sufficiently long assistant thought before concurrent signature change.'
      ),
    ]);

    const originalExtract = (
      service as unknown as {
        extractLeadAssistantTextsFromJsonl: (
          jsonlPath: string,
          leadName: string,
          leadSessionId: string,
          maxTexts: number
        ) => Promise<Array<{ text: string }>>;
      }
    ).extractLeadAssistantTextsFromJsonl.bind(service);
    let releaseFirstInvocation = () => {};
    let firstInvocationStartedResolve: (() => void) | null = null;
    const firstInvocationStarted = new Promise<void>((resolve) => {
      firstInvocationStartedResolve = resolve;
    });
    const assistantSpy = vi
      .spyOn(service as never, 'extractLeadAssistantTextsFromJsonl' as never)
      .mockImplementation(async (...args: unknown[]) => {
        const [targetPath, leadName, leadSessionId, maxTexts] = args as [
          string,
          string,
          string,
          number,
        ];
        if (assistantSpy.mock.calls.length === 1) {
          firstInvocationStartedResolve?.();
          await new Promise<void>((resolve) => {
            releaseFirstInvocation = () => resolve();
          });
        }
        return originalExtract(targetPath, leadName, leadSessionId, maxTexts);
      });
    const extract = (
      service as unknown as {
        extractLeadSessionTextsFromJsonl: (
          jsonlPath: string,
          leadName: string,
          leadSessionId: string,
          maxTexts: number
        ) => Promise<Array<{ text: string }>>;
      }
    ).extractLeadSessionTextsFromJsonl.bind(service);

    const firstPromise = extract(jsonlPath, 'team-lead', 'lead-1', 150);
    await firstInvocationStarted;
    await fs.appendFile(
      jsonlPath,
      `${JSON.stringify(
        createLeadAssistantEntry(
          'assistant-2',
          '2026-03-27T22:17:02.000Z',
          'This is a sufficiently long assistant thought appended before the second caller.'
        )
      )}\n`,
      'utf8'
    );

    const secondPromise = extract(jsonlPath, 'team-lead', 'lead-1', 150);
    releaseFirstInvocation();

    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect(assistantSpy).toHaveBeenCalledTimes(2);
    expect(first.length).toBeGreaterThan(0);
    expect(second.length).toBeGreaterThan(0);
  });

  it('keeps leadName and maxTexts in the cache identity', async () => {
    const service = createLeadSessionCachingService();
    const jsonlPath = await createTempJsonl([
      createLeadAssistantEntry(
        'assistant-1',
        '2026-03-27T22:17:01.000Z',
        'This is a sufficiently long assistant thought for keying behavior one.'
      ),
      createLeadAssistantEntry(
        'assistant-2',
        '2026-03-27T22:17:02.000Z',
        'This is a sufficiently long assistant thought for keying behavior two.'
      ),
    ]);

    const assistantSpy = vi.spyOn(service as never, 'extractLeadAssistantTextsFromJsonl' as never);
    const extract = (
      service as unknown as {
        extractLeadSessionTextsFromJsonl: (
          jsonlPath: string,
          leadName: string,
          leadSessionId: string,
          maxTexts: number
        ) => Promise<Array<{ from: string; text: string }>>;
      }
    ).extractLeadSessionTextsFromJsonl.bind(service);

    const firstLead = await extract(jsonlPath, 'team-lead', 'lead-1', 1);
    const secondLeadSameKey = await extract(jsonlPath, 'team-lead', 'lead-1', 1);
    const renamedLead = await extract(jsonlPath, 'captain', 'lead-1', 1);
    const widerSlice = await extract(jsonlPath, 'team-lead', 'lead-1', 2);

    expect(firstLead).toHaveLength(1);
    expect(secondLeadSameKey).toHaveLength(1);
    expect(renamedLead[0]?.from).toBe('captain');
    expect(widerSlice).toHaveLength(2);
    expect(assistantSpy).toHaveBeenCalledTimes(3);
  });

  it('does not return stale cached content when the jsonl file is deleted', async () => {
    const service = createLeadSessionCachingService();
    const jsonlPath = await createTempJsonl([
      createLeadAssistantEntry(
        'assistant-1',
        '2026-03-27T22:17:01.000Z',
        'This is a sufficiently long assistant thought before file deletion.'
      ),
    ]);

    const assistantSpy = vi.spyOn(service as never, 'extractLeadAssistantTextsFromJsonl' as never);
    const extract = (
      service as unknown as {
        extractLeadSessionTextsFromJsonl: (
          jsonlPath: string,
          leadName: string,
          leadSessionId: string,
          maxTexts: number
        ) => Promise<Array<{ text: string }>>;
      }
    ).extractLeadSessionTextsFromJsonl.bind(service);

    const first = await extract(jsonlPath, 'team-lead', 'lead-1', 150);
    await fs.rm(jsonlPath, { force: true });

    await expect(extract(jsonlPath, 'team-lead', 'lead-1', 150)).rejects.toThrow();

    expect(first).toHaveLength(1);
    expect(assistantSpy).toHaveBeenCalledTimes(2);
  });

  it('tolerates a partial trailing line and does not keep a sticky stale result after the file is fixed', async () => {
    const service = createLeadSessionCachingService();
    const jsonlPath = await createTempJsonl([
      createLeadAssistantEntry(
        'assistant-1',
        '2026-03-27T22:17:01.000Z',
        'This is a sufficiently long assistant thought before partial trailing data.'
      ),
    ]);
    await fs.appendFile(jsonlPath, '{"type":"assistant"', 'utf8');

    const assistantSpy = vi.spyOn(service as never, 'extractLeadAssistantTextsFromJsonl' as never);
    const extract = (
      service as unknown as {
        extractLeadSessionTextsFromJsonl: (
          jsonlPath: string,
          leadName: string,
          leadSessionId: string,
          maxTexts: number
        ) => Promise<Array<{ text: string }>>;
      }
    ).extractLeadSessionTextsFromJsonl.bind(service);

    const partialRead = await extract(jsonlPath, 'team-lead', 'lead-1', 150);
    await fs.writeFile(
      jsonlPath,
      `${JSON.stringify(
        createLeadAssistantEntry(
          'assistant-1',
          '2026-03-27T22:17:01.000Z',
          'This is a sufficiently long assistant thought before partial trailing data.'
        )
      )}\n${JSON.stringify(
        createLeadAssistantEntry(
          'assistant-2',
          '2026-03-27T22:17:02.000Z',
          'This is a sufficiently long assistant thought after the file was fixed.'
        )
      )}\n`,
      'utf8'
    );

    const repairedRead = await extract(jsonlPath, 'team-lead', 'lead-1', 150);

    expect(partialRead).toHaveLength(1);
    expect(repairedRead).toHaveLength(2);
    expect(assistantSpy).toHaveBeenCalledTimes(2);
  });

  it('works for resolved jsonl paths that contain both dashes and underscores', async () => {
    const service = createLeadSessionCachingService();
    const jsonlPath = await createTempJsonlInNamedDir('team_data-lead-session-cache-check', [
      createLeadAssistantEntry(
        'assistant-1',
        '2026-03-27T22:17:01.000Z',
        'This is a sufficiently long assistant thought for mixed path characters.'
      ),
    ]);

    const assistantSpy = vi.spyOn(service as never, 'extractLeadAssistantTextsFromJsonl' as never);
    const extract = (
      service as unknown as {
        extractLeadSessionTextsFromJsonl: (
          jsonlPath: string,
          leadName: string,
          leadSessionId: string,
          maxTexts: number
        ) => Promise<Array<{ text: string }>>;
      }
    ).extractLeadSessionTextsFromJsonl.bind(service);

    const first = await extract(jsonlPath, 'team-lead', 'lead-1', 150);
    const second = await extract(jsonlPath, 'team-lead', 'lead-1', 150);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(assistantSpy).toHaveBeenCalledTimes(1);
  });

  it('does not keep a rejected in-flight parse sticky across retries', async () => {
    const service = createLeadSessionCachingService();
    const jsonlPath = await createTempJsonl([
      createLeadAssistantEntry(
        'assistant-1',
        '2026-03-27T22:17:01.000Z',
        'This is a sufficiently long assistant thought before retry after failure.'
      ),
    ]);

    const originalExtract = (
      service as unknown as {
        extractLeadAssistantTextsFromJsonl: (
          jsonlPath: string,
          leadName: string,
          leadSessionId: string,
          maxTexts: number
        ) => Promise<Array<{ text: string }>>;
      }
    ).extractLeadAssistantTextsFromJsonl.bind(service);
    let shouldFail = true;
    const assistantSpy = vi
      .spyOn(service as never, 'extractLeadAssistantTextsFromJsonl' as never)
      .mockImplementation(async (...args: unknown[]) => {
        const [targetPath, leadName, leadSessionId, maxTexts] = args as [
          string,
          string,
          string,
          number,
        ];
        if (shouldFail) {
          throw new Error('transient parse failure');
        }
        return originalExtract(targetPath, leadName, leadSessionId, maxTexts);
      });
    const extract = (
      service as unknown as {
        extractLeadSessionTextsFromJsonl: (
          jsonlPath: string,
          leadName: string,
          leadSessionId: string,
          maxTexts: number
        ) => Promise<Array<{ text: string }>>;
      }
    ).extractLeadSessionTextsFromJsonl.bind(service);

    await expect(extract(jsonlPath, 'team-lead', 'lead-1', 150)).rejects.toThrow(
      'transient parse failure'
    );

    shouldFail = false;
    const retryResult = await extract(jsonlPath, 'team-lead', 'lead-1', 150);

    expect(retryResult).toHaveLength(1);
    expect(assistantSpy).toHaveBeenCalledTimes(2);
  });

  it('does not share cache state across fresh TeamDataService instances', async () => {
    const firstService = createLeadSessionCachingService();
    const secondService = createLeadSessionCachingService();
    const jsonlPath = await createTempJsonl([
      createLeadAssistantEntry(
        'assistant-1',
        '2026-03-27T22:17:01.000Z',
        'This is a sufficiently long assistant thought for service instance isolation.'
      ),
    ]);

    const firstSpy = vi.spyOn(
      firstService as never,
      'extractLeadAssistantTextsFromJsonl' as never
    );
    const secondSpy = vi.spyOn(
      secondService as never,
      'extractLeadAssistantTextsFromJsonl' as never
    );
    const firstExtract = (
      firstService as unknown as {
        extractLeadSessionTextsFromJsonl: (
          jsonlPath: string,
          leadName: string,
          leadSessionId: string,
          maxTexts: number
        ) => Promise<Array<{ text: string }>>;
      }
    ).extractLeadSessionTextsFromJsonl.bind(firstService);
    const secondExtract = (
      secondService as unknown as {
        extractLeadSessionTextsFromJsonl: (
          jsonlPath: string,
          leadName: string,
          leadSessionId: string,
          maxTexts: number
        ) => Promise<Array<{ text: string }>>;
      }
    ).extractLeadSessionTextsFromJsonl.bind(secondService);

    await firstExtract(jsonlPath, 'team-lead', 'lead-1', 150);
    await secondExtract(jsonlPath, 'team-lead', 'lead-1', 150);

    expect(firstSpy).toHaveBeenCalledTimes(1);
    expect(secondSpy).toHaveBeenCalledTimes(1);
  });

  it('fails fast when config is missing before any read-phase step starts', async () => {
    const harness = createGetTeamDataHarness({
      config: null,
    });

    await expect(harness.service.getTeamData('missing-team')).rejects.toThrow(
      'Team not found: missing-team'
    );

    expect(harness.taskReader.getTasks).not.toHaveBeenCalled();
    expect(harness.inboxReader.listInboxNames).not.toHaveBeenCalled();
    expect(harness.inboxReader.getMessages).not.toHaveBeenCalled();
    expect(harness.membersMetaStore.getMembers).not.toHaveBeenCalled();
    expect(harness.sentMessagesStore.readMessages).not.toHaveBeenCalled();
    expect(harness.kanbanManager.getState).not.toHaveBeenCalled();
    expect(harness.listProcessesSpy).not.toHaveBeenCalled();
  });

  it('starts light reads immediately, bounds heavy reads, and keeps processes outside the parallel phase', async () => {
    const order: string[] = [];
    const tasksDeferred = createDeferred<TeamTask[]>();
    const messagesDeferred = createDeferred<InboxMessage[]>();
    const leadTextsDeferred = createDeferred<InboxMessage[]>();

    const harness = createGetTeamDataHarness({
      getTasks: async () => {
        order.push('tasks:start');
        return tasksDeferred.promise;
      },
      listInboxNames: async () => {
        order.push('inboxNames:start');
        return [];
      },
      getMessages: async () => {
        order.push('messages:start');
        return messagesDeferred.promise;
      },
      getMembers: async () => {
        order.push('meta:start');
        return [];
      },
      getState: async () => {
        order.push('kanban:start');
        return { teamName: 'my-team', reviewers: [], tasks: {} };
      },
      readMessages: async () => {
        order.push('sent:start');
        return [];
      },
      resolveMembers: () => {
        order.push('resolveMembers');
        return [];
      },
      listProcesses: () => {
        order.push('processes:start');
        return [
          {
            id: 'proc-1',
            label: 'Lead',
            pid: 101,
            registeredAt: '2026-04-08T12:00:00.000Z',
          },
        ];
      },
      getMemberAdvisories: async () => {
        order.push('runtimeAdvisories');
        return new Map();
      },
    });

    vi.spyOn(harness.service as never, 'extractLeadSessionTexts' as never).mockImplementation(
      async () => {
        order.push('leadTexts:start');
        return leadTextsDeferred.promise;
      }
    );

    const pending = harness.service.getTeamData('my-team');
    await flushMicrotasks();

    expect(order).toEqual(
      expect.arrayContaining([
        'inboxNames:start',
        'sent:start',
        'meta:start',
        'kanban:start',
        'tasks:start',
        'messages:start',
      ])
    );
    expect(order).not.toContain('leadTexts:start');
    expect(order).not.toContain('processes:start');

    tasksDeferred.resolve([]);
    await flushMicrotasks();

    expect(order).toContain('leadTexts:start');
    expect(order.indexOf('tasks:start')).toBeLessThan(order.indexOf('messages:start'));
    expect(order.indexOf('messages:start')).toBeLessThan(order.indexOf('leadTexts:start'));
    expect(order).not.toContain('processes:start');

    messagesDeferred.resolve([]);
    leadTextsDeferred.resolve([]);

    const data = await pending;

    expect(data.processes).toEqual([
      expect.objectContaining({
        id: 'proc-1',
        pid: 101,
      }),
    ]);
    expect(order.indexOf('leadTexts:start')).toBeLessThan(order.indexOf('processes:start'));
    expect(order.indexOf('resolveMembers')).toBeLessThan(order.indexOf('processes:start'));
  });

  it('keeps warning order deterministic even when read failures settle out of order', async () => {
    const tasksDeferred = createDeferred<TeamTask[]>();
    const inboxDeferred = createDeferred<string[]>();
    const messagesDeferred = createDeferred<InboxMessage[]>();
    const leadTextsDeferred = createDeferred<InboxMessage[]>();
    const sentDeferred = createDeferred<InboxMessage[]>();
    const metaDeferred = createDeferred<TeamConfig['members']>();
    const kanbanDeferred = createDeferred<KanbanState>();

    const harness = createGetTeamDataHarness({
      getTasks: async () => tasksDeferred.promise,
      listInboxNames: async () => inboxDeferred.promise,
      getMessages: async () => messagesDeferred.promise,
      getMembers: async () => metaDeferred.promise,
      getState: async () => kanbanDeferred.promise,
      readMessages: async () => sentDeferred.promise,
    });

    vi.spyOn(harness.service as never, 'extractLeadSessionTexts' as never).mockImplementation(
      async () => leadTextsDeferred.promise
    );

    const pending = harness.service.getTeamData('my-team');
    await flushMicrotasks();

    sentDeferred.reject(new Error('sent failed'));
    kanbanDeferred.reject(new Error('kanban failed'));
    tasksDeferred.reject(new Error('tasks failed'));
    metaDeferred.reject(new Error('meta failed'));
    inboxDeferred.reject(new Error('inbox failed'));
    leadTextsDeferred.reject(new Error('lead failed'));
    messagesDeferred.reject(new Error('messages failed'));

    const data = await pending;

    expect(data.warnings).toEqual([
      'Tasks failed to load',
      'Inboxes failed to load',
      'Messages failed to load',
      'Lead session texts failed to load',
      'Sent messages failed to load',
      'Member metadata failed to load',
      'Kanban state failed to load',
    ]);
  });

  it('preserves message assembly order across inbox, lead texts, and sent messages', async () => {
    const harness = createGetTeamDataHarness({
      getMessages: async () => [
        {
          from: 'alice',
          to: 'team-lead',
          text: 'Inbox update',
          timestamp: '2026-04-08T12:00:01.000Z',
          read: true,
          source: 'inbox',
          messageId: 'inbox-1',
        },
      ],
      readMessages: async () => [
        {
          from: 'user',
          to: 'team-lead',
          text: '/status',
          timestamp: '2026-04-08T12:00:03.000Z',
          read: true,
          source: 'user_sent',
          messageId: 'sent-1',
        },
      ],
    });

    vi.spyOn(harness.service as never, 'extractLeadSessionTexts' as never).mockResolvedValue([
      {
        from: 'team-lead',
        text: 'Lead summary',
        timestamp: '2026-04-08T12:00:02.000Z',
        read: true,
        source: 'lead_session',
        leadSessionId: 'lead-1',
        messageId: 'lead-1',
      },
    ]);

    const data = await harness.service.getTeamData('my-team');

    expect(data.messages.map((message) => message.messageId)).toEqual(['sent-1', 'lead-1', 'inbox-1']);
  });

  it('preserves assembled messages and resolver inputs when inbox messages fail', async () => {
    const task: TeamTask = {
      id: 'task-1',
      subject: 'Investigate rollout',
      status: 'pending',
    };
    const metaMembers = [{ name: 'alice' }];
    const inboxNames = ['alice'];
    const resolveMembersSpy = vi.fn(() => []);
    const harness = createGetTeamDataHarness({
      getTasks: async () => [task],
      listInboxNames: async () => inboxNames,
      getMessages: async () => {
        throw new Error('messages failed');
      },
      getMembers: async () => metaMembers,
      getState: async () => {
        throw new Error('kanban failed');
      },
      readMessages: async () => [
        {
          from: 'user',
          to: 'team-lead',
          text: '/status',
          timestamp: '2026-04-08T12:00:03.000Z',
          read: true,
          source: 'user_sent',
          messageId: 'sent-1',
        },
      ],
      resolveMembers: resolveMembersSpy,
    });

    vi.spyOn(harness.service as never, 'extractLeadSessionTexts' as never).mockResolvedValue([
      {
        from: 'team-lead',
        text: 'Lead summary',
        timestamp: '2026-04-08T12:00:02.000Z',
        read: true,
        source: 'lead_session',
        leadSessionId: 'lead-1',
        messageId: 'lead-1',
      },
    ]);

    const data = await harness.service.getTeamData('my-team');

    expect(data.warnings).toEqual(
      expect.arrayContaining(['Messages failed to load', 'Kanban state failed to load'])
    );
    expect(data.messages.map((message) => message.messageId)).toEqual(['sent-1', 'lead-1']);
    expect(resolveMembersSpy).toHaveBeenCalledWith(
      buildDefaultTeamConfig(),
      metaMembers,
      inboxNames,
      [
        expect.objectContaining({
          id: 'task-1',
          subject: 'Investigate rollout',
        }),
      ],
      [
        expect.objectContaining({ messageId: 'sent-1' }),
        expect.objectContaining({ messageId: 'lead-1' }),
      ]
    );
  });

  it('keeps task assembly safe when kanban loading fails', async () => {
    const harness = createGetTeamDataHarness({
      getTasks: async () => [
        {
          id: 'task-1',
          subject: 'Investigate rollout',
          status: 'pending',
        },
      ],
      getState: async () => {
        throw new Error('kanban failed');
      },
    });

    const data = await harness.service.getTeamData('my-team');

    expect(data.tasks).toEqual([
      expect.objectContaining({
        id: 'task-1',
        subject: 'Investigate rollout',
        status: 'pending',
      }),
    ]);
    expect(data.kanbanState).toEqual({
      teamName: 'my-team',
      reviewers: [],
      tasks: {},
    });
    expect(data.warnings).toEqual(expect.arrayContaining(['Kanban state failed to load']));
  });

  it('degrades a queued heavy sync throw to warning and still completes the snapshot', async () => {
    const order: string[] = [];
    const tasksDeferred = createDeferred<TeamTask[]>();
    const messagesDeferred = createDeferred<InboxMessage[]>();
    const harness = createGetTeamDataHarness({
      getTasks: async () => {
        order.push('tasks:start');
        return tasksDeferred.promise;
      },
      getMessages: async () => {
        order.push('messages:start');
        return messagesDeferred.promise;
      },
      listProcesses: () => {
        order.push('processes:start');
        return [];
      },
    });

    vi.spyOn(harness.service as never, 'extractLeadSessionTexts' as never).mockImplementation(() => {
      order.push('leadTexts:start');
      throw new Error('lead sync fail');
    });

    const pending = harness.service.getTeamData('my-team');
    await flushMicrotasks();

    expect(order).not.toContain('leadTexts:start');

    tasksDeferred.resolve([]);
    await flushMicrotasks();

    expect(order).toContain('leadTexts:start');

    messagesDeferred.resolve([]);
    const data = await pending;

    expect(data.warnings).toEqual(expect.arrayContaining(['Lead session texts failed to load']));
    expect(order).toContain('processes:start');
  });

  it('preserves presenceIndex rejection semantics and rejects before resolveMembers', async () => {
    const task: TeamTask = {
      id: 'task-1',
      subject: 'Check change presence',
      status: 'pending',
    };
    const harness = createGetTeamDataHarness({
      config: buildDefaultTeamConfig({ projectPath: '/repo' }),
      getTasks: async () => [task],
    });
    const loadDeferred = createDeferred<null>();
    const load = vi.fn(() => loadDeferred.promise);

    harness.service.setTaskChangePresenceServices(
      {
        load,
      } as never,
      {
        getSnapshot: vi.fn(() => ({
          projectFingerprint: 'project-fingerprint',
          logSourceGeneration: 'log-generation',
        })),
      } as never
    );

    const pending = harness.service.getTeamData('my-team');
    await flushMicrotasks();
    loadDeferred.reject(new Error('presence failed'));

    await expect(pending).rejects.toThrow('presence failed');
    expect(load).toHaveBeenCalledWith('my-team');
    expect(harness.resolveMembersSpy).not.toHaveBeenCalled();
  });

  it('handles a synchronous light-step failure with the same degraded warning behavior', async () => {
    const harness = createGetTeamDataHarness({
      getMembers: (() => {
        throw new Error('meta sync fail');
      }) as never,
    });

    const data = await harness.service.getTeamData('my-team');

    expect(data.warnings).toEqual(expect.arrayContaining(['Member metadata failed to load']));
    expect(data.members).toEqual([]);
  });

  it('surfaces orchestration errors that happen after the read phase and outside step wrappers', async () => {
    const harness = createGetTeamDataHarness({
      resolveMembers: () => {
        throw new Error('resolver exploded');
      },
    });

    await expect(harness.service.getTeamData('my-team')).rejects.toThrow('resolver exploded');
  });

  it('does not crash in the slow-log path when marks come from async step completion times', async () => {
    const harness = createGetTeamDataHarness();
    let now = 0;
    const dateNowSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
      now += 200;
      return now;
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      const data = await harness.service.getTeamData('my-team');
      expect(data.teamName).toBe('my-team');
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      dateNowSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});
