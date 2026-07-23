import { createHash } from 'crypto';
import * as nodeFs from 'fs';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { gitIdentityResolver } from '../../../../src/main/services/parsing/GitIdentityResolver';
import { getEffectiveInboxMessageId } from '../../../../src/main/services/team/inboxMessageIdentity';
import { buildTaskChangePresenceDescriptor } from '../../../../src/main/services/team/taskChangePresenceUtils';
import { TeamConfigReader } from '../../../../src/main/services/team/TeamConfigReader';
import { TeamDataService } from '../../../../src/main/services/team/TeamDataService';
import { TeamProvisioningService } from '../../../../src/main/services/team/TeamProvisioningService';
import { TeamTaskReader } from '../../../../src/main/services/team/TeamTaskReader';
import { encodePath, setClaudeBasePathOverride } from '../../../../src/main/utils/pathDecoder';

import type {
  InboxMessageCursor,
  InboxMessagesWindow,
} from '../../../../src/main/services/team/TeamInboxReader';
import type { TeamMetaFile } from '../../../../src/main/services/team/TeamMetaStore';
import type {
  InboxMessage,
  KanbanState,
  ResolvedTeamMember,
  TeamConfig,
  TeamMember,
  TeamProcess,
  TeamTask,
  TeamTaskWithKanban,
} from '../../../../src/shared/types/team';

const TASK_COMMENT_FORWARDING_ENV = 'CLAUDE_TEAM_TASK_COMMENT_FORWARDING';
const tempPaths: string[] = [];

type TeamDataServicePrivate = {
  extractLeadAssistantTextsFromJsonlLines(
    rawLines: readonly string[],
    leadName: string,
    leadSessionId: string,
    maxTexts: number
  ): Promise<InboxMessage[]>;
  getLeadSessionJsonlPaths(projectDir: string): Promise<Map<string, string>>;
  extractLeadSessionTextsFromJsonl(
    jsonlPath: string,
    leadName: string,
    leadSessionId: string,
    maxTexts: number
  ): Promise<InboxMessage[]>;
  extractLeadSessionTexts(teamName: string, config: TeamConfig): Promise<InboxMessage[]>;
};

function teamDataServicePrivate(service: TeamDataService): TeamDataServicePrivate {
  return service as unknown as TeamDataServicePrivate;
}

function normalizeMockInboxMessage(message: InboxMessage): InboxMessage {
  const messageId = getEffectiveInboxMessageId(message);
  return messageId ? { ...message, messageId } : { ...message };
}

function isMockMessageAfterCursor(
  message: InboxMessage,
  cursor: InboxMessageCursor | null | undefined
): boolean {
  if (!cursor) return true;
  const messageMs = Date.parse(message.timestamp);
  if (messageMs < cursor.timestampMs) return true;
  if (messageMs > cursor.timestampMs) return false;
  const messageId = getEffectiveInboxMessageId(message);
  return messageId ? messageId.localeCompare(cursor.messageId) > 0 : false;
}

function sortMockMessagesNewestFirst(messages: InboxMessage[]): InboxMessage[] {
  messages.sort((left, right) => {
    const timeDiff = Date.parse(right.timestamp) - Date.parse(left.timestamp);
    if (timeDiff !== 0) return timeDiff;
    return (getEffectiveInboxMessageId(left) ?? '').localeCompare(
      getEffectiveInboxMessageId(right) ?? ''
    );
  });
  return messages;
}

function buildMockInboxSourceRevision(messages: readonly InboxMessage[]): string {
  const hash = createHash('sha256');
  for (const message of messages) {
    hash.update(
      `${message.from ?? ''}\0${message.timestamp ?? ''}\0${message.text ?? ''}\0${
        getEffectiveInboxMessageId(message) ?? ''
      }\n`
    );
  }
  return hash.digest('hex').slice(0, 24);
}

function createMockInboxMessagesWindowReader(
  getMessages: (teamName: string) => Promise<InboxMessage[]>
): (
  teamName: string,
  options: { cursor?: InboxMessageCursor | null; limit: number }
) => Promise<InboxMessagesWindow> {
  return async (teamName, options) => {
    const limit = Math.max(1, Math.floor(options.limit));
    const messages = (await getMessages(teamName)).map(normalizeMockInboxMessage);
    const filtered = messages.filter((message) =>
      isMockMessageAfterCursor(message, options.cursor ?? null)
    );
    sortMockMessagesNewestFirst(filtered);
    return {
      messages: filtered.slice(0, limit),
      truncated: filtered.length > limit,
      sourceRevision: buildMockInboxSourceRevision(messages),
      sourceMessageCount: messages.length,
    };
  };
}

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

function createSyntheticLeadAssistantChunk(
  uuid: string,
  timestamp: string,
  text: string
): Record<string, unknown> {
  return {
    ...createLeadAssistantEntry(uuid, timestamp, text),
    message: {
      role: 'assistant',
      model: '<synthetic>',
      id: `msg-${uuid}`,
      type: 'message',
      stop_reason: 'stop_sequence',
      stop_sequence: '',
      usage: {
        input_tokens: 0,
        output_tokens: 0,
      },
      content: [{ type: 'text', text }],
    },
  };
}

function createSyntheticLeadApiErrorEntry(
  uuid: string,
  timestamp: string,
  text: string
): Record<string, unknown> {
  return {
    ...createSyntheticLeadAssistantChunk(uuid, timestamp, text),
    error: 'rate_limit',
    isApiErrorMessage: true,
    entrypoint: 'sdk-cli',
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

async function createResolverBackedLeadFixture(options?: {
  teamName?: string;
  staleProjectPath?: string;
  actualProjectPath?: string;
  leadSessionId?: string;
  sessionHistory?: string[];
  sessionFileId?: string;
}): Promise<{
  claudeRoot: string;
  teamName: string;
  configPath: string;
  staleProjectPath: string;
  actualProjectPath: string;
  actualProjectDir: string;
}> {
  const teamName = options?.teamName ?? 'my-team';
  const staleProjectPath = options?.staleProjectPath ?? '/Users/test/hookplex';
  const actualProjectPath = options?.actualProjectPath ?? '/Users/test/plugin-kit-ai';
  const leadSessionId = options?.leadSessionId ?? 'lead-1';
  const sessionFileId = options?.sessionFileId ?? leadSessionId;
  const claudeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'team-data-resolver-backed-'));
  tempPaths.push(claudeRoot);
  setClaudeBasePathOverride(claudeRoot);

  await fs.mkdir(path.join(claudeRoot, 'teams', teamName), { recursive: true });
  await fs.mkdir(path.join(claudeRoot, 'projects', encodePath(staleProjectPath)), {
    recursive: true,
  });

  const configPath = path.join(claudeRoot, 'teams', teamName, 'config.json');
  await fs.writeFile(
    configPath,
    JSON.stringify(
      {
        name: 'My Team',
        projectPath: staleProjectPath,
        ...(leadSessionId ? { leadSessionId } : {}),
        ...(options?.sessionHistory ? { sessionHistory: options.sessionHistory } : {}),
        members: [{ name: 'team-lead', agentType: 'team-lead', cwd: actualProjectPath }],
      },
      null,
      2
    ),
    'utf8'
  );

  const actualProjectDir = path.join(claudeRoot, 'projects', encodePath(actualProjectPath));
  await fs.mkdir(actualProjectDir, { recursive: true });
  await fs.writeFile(
    path.join(actualProjectDir, `${sessionFileId}.jsonl`),
    `${JSON.stringify({
      teamName,
      type: 'assistant',
      timestamp: '2026-04-18T10:00:00.000Z',
      cwd: actualProjectPath,
      message: {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: 'This is a sufficiently long lead thought recovered through the transcript resolver.',
          },
        ],
      },
    })}\n`,
    'utf8'
  );

  return {
    claudeRoot,
    teamName,
    configPath,
    staleProjectPath,
    actualProjectPath,
    actualProjectDir,
  };
}

function createResolverBackedService(): TeamDataService {
  return new TeamDataService(
    new TeamConfigReader(),
    { getTasks: vi.fn(async () => []) } as never,
    {
      listInboxNames: vi.fn(async () => []),
      getMessages: vi.fn(async () => []),
      getMessagesWindow: vi.fn(createMockInboxMessagesWindowReader(async () => [])),
    } as never,
    {} as never,
    {} as never,
    { resolveMembers: vi.fn(() => []) } as never,
    { getState: vi.fn(async () => ({ teamName: 'my-team', reviewers: [], tasks: {} })) } as never,
    {} as never,
    { getMembers: vi.fn(async () => []) } as never,
    { readMessages: vi.fn(async () => []) } as never
  );
}

function createLeadSessionCachingService(
  configOverrides: Partial<TeamConfig> = {}
): TeamDataService {
  return new TeamDataService(
    {
      listTeams: vi.fn(),
      getConfig: vi.fn(async () => ({
        name: 'My team',
        members: [{ name: 'team-lead', role: 'Lead' }],
        leadSessionId: 'lead-1',
        ...configOverrides,
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

describe('TeamDataService task projection cache invalidation', () => {
  it('invalidates global task projection cache after direct task mutations', async () => {
    const task: TeamTask = {
      id: 'task-1',
      subject: 'Task 1',
      status: 'pending',
      createdAt: '2026-05-02T12:00:00.000Z',
      updatedAt: '2026-05-02T12:00:00.000Z',
    };
    const taskController = {
      createTask: vi.fn(() => task),
      startTask: vi.fn(),
      setTaskStatus: vi.fn(),
      softDeleteTask: vi.fn(),
      restoreTask: vi.fn(),
      setTaskOwner: vi.fn(),
      updateTaskFields: vi.fn(),
      addTaskAttachmentMeta: vi.fn(),
      removeTaskAttachment: vi.fn(),
      setNeedsClarification: vi.fn(),
      linkTask: vi.fn(),
      unlinkTask: vi.fn(),
      addTaskComment: vi.fn(() => ({
        comment: {
          id: 'comment-1',
          author: 'user',
          text: 'Comment',
          createdAt: '2026-05-02T12:01:00.000Z',
          type: 'regular',
        },
      })),
    };
    const service = new TeamDataService(
      {
        getConfig: vi.fn(async () => ({
          name: 'my-team',
          projectPath: '/repo',
          members: [{ name: 'team-lead', role: 'Lead' }],
        })),
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
      { resolveMembers: vi.fn(() => []) } as never,
      { getState: vi.fn(async () => ({ teamName: 'my-team', reviewers: [], tasks: {} })) } as never,
      {} as never,
      { getMembers: vi.fn(async () => []) } as never,
      { readMessages: vi.fn(async () => []) } as never,
      (() => ({ taskBoard: taskController })) as never
    );
    const invalidateSpy = vi.spyOn(TeamTaskReader, 'invalidateAllTasksCache');

    await service.createTask('my-team', { subject: 'Task 1' });
    await service.startTask('my-team', 'task-1');
    await service.startTaskByUser('my-team', 'task-1');
    await service.updateTaskStatus('my-team', 'task-1', 'completed');
    await service.softDeleteTask('my-team', 'task-1');
    await service.restoreTask('my-team', 'task-1');
    await service.updateTaskOwner('my-team', 'task-1', 'alice');
    await service.updateTaskFields('my-team', 'task-1', { subject: 'Task 1 updated' });
    await service.addTaskAttachment('my-team', 'task-1', {
      id: 'att-1',
      filename: 'note.txt',
      mimeType: 'text/plain',
      size: 1,
      createdAt: '2026-05-02T12:02:00.000Z',
    } as never);
    await service.removeTaskAttachment('my-team', 'task-1', 'att-1');
    await service.setTaskNeedsClarification('my-team', 'task-1', 'lead');
    await service.addTaskRelationship('my-team', 'task-1', 'task-2', 'related');
    await service.removeTaskRelationship('my-team', 'task-1', 'task-2', 'related');
    await service.addTaskComment('my-team', 'task-1', 'Comment');

    expect(invalidateSpy).toHaveBeenCalledTimes(14);
  });

  it('invalidates config and global task caches after permanent team deletion', async () => {
    const claudeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'team-data-delete-cache-'));
    tempPaths.push(claudeRoot);
    setClaudeBasePathOverride(claudeRoot);

    await fs.mkdir(path.join(claudeRoot, 'teams', 'gone-team'), { recursive: true });
    await fs.mkdir(path.join(claudeRoot, 'tasks', 'gone-team'), { recursive: true });

    const configInvalidateSpy = vi.spyOn(TeamConfigReader, 'invalidateTeam');
    const taskInvalidateSpy = vi.spyOn(TeamTaskReader, 'invalidateAllTasksCache');
    const removeSpy = vi.spyOn(nodeFs.promises, 'rm');

    const service = new TeamDataService();
    await service.permanentlyDeleteTeam('gone-team');

    await expect(fs.access(path.join(claudeRoot, 'teams', 'gone-team'))).rejects.toThrow();
    await expect(fs.access(path.join(claudeRoot, 'tasks', 'gone-team'))).rejects.toThrow();
    expect(configInvalidateSpy).toHaveBeenCalledWith('gone-team');
    expect(taskInvalidateSpy).toHaveBeenCalledTimes(1);
    expect(removeSpy).toHaveBeenCalledWith(
      path.join(claudeRoot, 'teams', 'gone-team'),
      expect.objectContaining({
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      })
    );
    expect(removeSpy).toHaveBeenCalledWith(
      path.join(claudeRoot, 'tasks', 'gone-team'),
      expect.objectContaining({ maxRetries: 5, retryDelay: 50 })
    );
  });

  it('keeps team deletion mutations on verified config reads', async () => {
    const claudeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'team-data-delete-verified-'));
    tempPaths.push(claudeRoot);
    setClaudeBasePathOverride(claudeRoot);
    await fs.mkdir(path.join(claudeRoot, 'teams', 'my-team'), { recursive: true });

    const getConfig = vi.fn(async () => ({
      name: 'My team',
      members: [],
    }));
    const getConfigSnapshot = vi.fn(async () => {
      throw new Error('snapshot config read should not be used for team deletion');
    });
    const service = new TeamDataService({
      listTeams: vi.fn(),
      getConfig,
      getConfigSnapshot,
    } as never);

    await service.deleteTeam('my-team');

    const written = JSON.parse(
      await fs.readFile(path.join(claudeRoot, 'teams', 'my-team', 'config.json'), 'utf8')
    ) as TeamConfig;
    expect(written.deletedAt).toBeTruthy();
    expect(getConfig).toHaveBeenCalledWith('my-team');
    expect(getConfigSnapshot).not.toHaveBeenCalled();
  });
});

describe('TeamDataService draft metadata', () => {
  it('rejects an existing draft without overwriting its artifacts', async () => {
    const claudeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'team-data-draft-collision-'));
    tempPaths.push(claudeRoot);
    setClaudeBasePathOverride(claudeRoot);
    const teamDir = path.join(claudeRoot, 'teams', 'draft-team');
    const tasksDir = path.join(claudeRoot, 'tasks', 'draft-team');
    await fs.mkdir(teamDir, { recursive: true });
    await fs.mkdir(tasksDir, { recursive: true });
    const existingMeta = '{"displayName":"Existing Draft"}';
    await fs.writeFile(path.join(teamDir, 'team.meta.json'), existingMeta, 'utf8');
    await fs.writeFile(path.join(tasksDir, '1.json'), '{"subject":"Existing task"}', 'utf8');

    await expect(
      new TeamDataService().createTeamConfig({
        teamName: 'draft-team',
        members: [{ name: 'replacement' }],
      })
    ).rejects.toThrow('Team already exists');

    await expect(fs.readFile(path.join(teamDir, 'team.meta.json'), 'utf8')).resolves.toBe(
      existingMeta
    );
    await expect(fs.readFile(path.join(tasksDir, '1.json'), 'utf8')).resolves.toContain(
      'Existing task'
    );
  });

  it('rejects an orphaned tasks directory instead of creating a hybrid draft', async () => {
    const claudeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'team-data-task-collision-'));
    tempPaths.push(claudeRoot);
    setClaudeBasePathOverride(claudeRoot);
    await fs.mkdir(path.join(claudeRoot, 'tasks', 'draft-team'), { recursive: true });

    await expect(
      new TeamDataService().createTeamConfig({ teamName: 'draft-team', members: [] })
    ).rejects.toThrow('Team already exists');
    await expect(fs.access(path.join(claudeRoot, 'teams', 'draft-team'))).rejects.toThrow();
  });

  it('allows exactly one of two concurrent creates for the same team name', async () => {
    const claudeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'team-data-create-race-'));
    tempPaths.push(claudeRoot);
    setClaudeBasePathOverride(claudeRoot);
    const service = new TeamDataService();

    const results = await Promise.allSettled([
      service.createTeamConfig({ teamName: 'draft-team', members: [{ name: 'alpha' }] }),
      service.createTeamConfig({ teamName: 'draft-team', members: [{ name: 'beta' }] }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const members = JSON.parse(
      await fs.readFile(path.join(claudeRoot, 'teams', 'draft-team', 'members.meta.json'), 'utf8')
    ) as { members: { name: string }[] };
    expect([['alpha'], ['beta']]).toContainEqual(members.members.map((member) => member.name));
  });

  it('round-trips create config metadata through getSavedRequest', async () => {
    const claudeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'team-data-saved-request-'));
    tempPaths.push(claudeRoot);
    setClaudeBasePathOverride(claudeRoot);

    const service = new TeamDataService();
    const listCacheInvalidateSpy = vi.spyOn(TeamConfigReader, 'invalidateListTeamsCache');
    await service.createTeamConfig({
      teamName: 'draft-team',
      displayName: 'Draft Team',
      description: 'Saved draft',
      color: '#3366ff',
      cwd: '/Users/test/project',
      prompt: 'Saved prompt',
      providerId: 'codex',
      model: 'gpt-5.2',
      effort: 'high',
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
          model: 'gpt-5.2',
          effort: 'high',
          fastMode: 'on',
        },
      ],
    });
    expect(listCacheInvalidateSpy).toHaveBeenCalled();

    await expect(service.getSavedRequest('missing-team')).resolves.toBeNull();
    await expect(service.getSavedRequest('draft-team')).resolves.toMatchObject({
      teamName: 'draft-team',
      displayName: 'Draft Team',
      description: 'Saved draft',
      color: '#3366ff',
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
  });

  it('omits removed members from saved request members', async () => {
    const claudeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'team-data-saved-request-removed-'));
    tempPaths.push(claudeRoot);
    setClaudeBasePathOverride(claudeRoot);

    const service = new TeamDataService();
    await service.createTeamConfig({
      teamName: 'draft-team',
      cwd: '/Users/test/project',
      providerId: 'anthropic',
      members: [
        {
          name: 'active-builder',
          role: 'Engineer',
          workflow: 'Keep shipping',
          model: 'claude-sonnet-4.5',
        },
        {
          name: 'old-builder',
          role: 'Legacy Engineer',
          workflow: 'Should not be reused',
          model: 'claude-haiku-4.5',
        },
      ],
    });

    await service.removeMember('draft-team', 'old-builder');

    await expect(service.getSavedRequest('draft-team')).resolves.toMatchObject({
      members: [
        {
          name: 'active-builder',
          role: 'Engineer',
          workflow: 'Keep shipping',
          model: 'claude-sonnet-4.5',
        },
      ],
    });
  });

  it('persists a migrated removal tombstone and makes repeated removal restart-safe', async () => {
    const claudeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'team-data-remove-restart-'));
    tempPaths.push(claudeRoot);
    setClaudeBasePathOverride(claudeRoot);
    const teamDir = path.join(claudeRoot, 'teams', 'restart-team');
    await fs.mkdir(path.join(teamDir, 'inboxes'), { recursive: true });
    const configRaw = JSON.stringify({
      name: 'restart-team',
      members: [
        { name: 'team-lead', agentType: 'team-lead', role: 'Lead' },
        { name: 'user', role: 'Reserved recipient' },
        { name: 'alice', role: 'Developer' },
        { name: 'bob', role: 'Reviewer' },
      ],
    });
    await fs.writeFile(path.join(teamDir, 'config.json'), configRaw);
    await Promise.all(
      [
        'alice',
        'bob',
        'team-lead',
        'user',
        'alice-provisioner',
        'alice-2',
        'cross_team::other-team',
        'cross_team_send',
        'other-team.external',
        'a0123456789abcdef',
      ].map((name) => fs.writeFile(path.join(teamDir, 'inboxes', `${name}.json`), '[]'))
    );

    await new TeamDataService().removeMember('restart-team', 'alice');
    await expect(
      new TeamDataService().removeMember('restart-team', 'alice')
    ).resolves.toBeUndefined();

    const persisted = JSON.parse(
      await fs.readFile(path.join(teamDir, 'members.meta.json'), 'utf8')
    );
    expect(persisted.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'alice',
          role: 'Developer',
          removedAt: expect.any(Number),
        }),
        expect.objectContaining({ name: 'bob', role: 'Reviewer' }),
      ])
    );
    expect(persisted.members).toHaveLength(2);

    for (let restart = 0; restart < 2; restart += 1) {
      const provisioning = new TeamProvisioningService();
      const resolution = await (
        provisioning as unknown as {
          configFacade: {
            resolveLaunchExpectedMembers(
              teamName: string,
              rawConfig: string,
              providerId: string
            ): Promise<{ source: string; members: Array<{ name: string }> }>;
          };
        }
      ).configFacade.resolveLaunchExpectedMembers('restart-team', configRaw, 'codex');

      expect(resolution.source).toBe('members-meta');
      expect(resolution.members.map((member) => member.name)).toEqual(['bob']);
    }
  });
});

function createForwardingJournalStore(initialEntries: Array<Record<string, unknown>> = []) {
  const journalEntries = initialEntries;
  const journal = {
    exists: vi.fn(async () => true),
    ensureFile: vi.fn(async () => undefined),
    withEntries: vi.fn(
      async (_teamName: string, fn: (entries: unknown[]) => Promise<{ result: unknown }>) => {
        const outcome = await fn(journalEntries);
        return outcome.result;
      }
    ),
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
  const inboxWriter = options.inboxWriter ?? {
    sendMessage: vi.fn(async () => ({ deliveredToInbox: true, messageId: 'msg-1' })),
  };
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

function createGetTeamDataHarness(
  options: {
    config?: TeamConfig | null;
    getTasks?: () => Promise<TeamTask[]>;
    getTask?: (taskId: string) => TeamTask | null;
    listInboxNames?: () => Promise<string[]>;
    getMessages?: () => Promise<InboxMessage[]>;
    getMembers?: () => Promise<TeamConfig['members']>;
    getTeamMeta?: () => Promise<TeamMetaFile | null>;
    getState?: () => Promise<KanbanState>;
    readMessages?: () => Promise<InboxMessage[]>;
    resolveMembers?: (
      config: TeamConfig,
      metaMembers: TeamConfig['members'],
      inboxNames: string[],
      tasks: TeamTaskWithKanban[]
    ) => ResolvedTeamMember[];
    listProcesses?: () => TeamProcess[];
    getMemberAdvisories?: () => Promise<Map<string, unknown>>;
  } = {}
) {
  const getConfig = vi.fn(async () =>
    options.config === undefined ? buildDefaultTeamConfig() : options.config
  );
  const getConfigSnapshot = vi.fn(async () =>
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
  const getTeamMeta =
    options.getTeamMeta ??
    (async () => {
      return null;
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
    getMessagesWindow: vi.fn(createMockInboxMessagesWindowReader(getMessages)),
  };
  const membersMetaStore = {
    getMembers: vi.fn(getMembers),
  };
  const teamMetaStore = {
    getMeta: vi.fn(getTeamMeta),
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
      getConfigSnapshot,
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
        taskBoard: {
          getTask: options.getTask ?? (() => null),
        },
        processes: {
          listProcesses: listProcessesSpy,
        },
      }) as never) as never,
    {} as never,
    teamMetaStore as never,
    advisoryService as never
  );

  return {
    service,
    getConfig,
    getConfigSnapshot,
    taskReader,
    inboxReader,
    membersMetaStore,
    teamMetaStore,
    sentMessagesStore,
    resolveMembersSpy,
    kanbanManager,
    listProcessesSpy,
    advisoryService,
  };
}

function buildResolvedMember(name: string): ResolvedTeamMember {
  return {
    name,
    status: 'unknown',
    currentTaskId: null,
    taskCount: 0,
    lastActiveAt: null,
    messageCount: 0,
  };
}

function createDurableTaskStartNotificationHarness(options: {
  task: TeamTask;
  commandResults?: Array<{ outcome: string; createdInAttempt: boolean }>;
  commandFacadeCreateTask?: ReturnType<typeof vi.fn>;
  sendMessage?: ReturnType<typeof vi.fn>;
}): {
  service: TeamDataService;
  sendMessage: ReturnType<typeof vi.fn>;
  commandFacadeCreateTask: ReturnType<typeof vi.fn>;
} {
  const sendMessage =
    options.sendMessage ??
    vi.fn(async (_teamName: string, request: { messageId?: string }) => ({
      deliveredToInbox: true,
      messageId: request.messageId ?? 'generated-message-id',
    }));
  const commandResults = options.commandResults ?? [
    { outcome: 'executed', createdInAttempt: true },
  ];
  let commandAttempt = 0;
  const commandFacadeCreateTask =
    options.commandFacadeCreateTask ??
    vi.fn(async () => {
      const result = commandResults[Math.min(commandAttempt, commandResults.length - 1)];
      commandAttempt += 1;
      return {
        task: options.task,
        outcome: result?.outcome ?? 'replayed',
        createdInAttempt: result?.createdInAttempt ?? false,
      };
    });
  const service = new TeamDataService(
    {
      getConfig: vi.fn(async () => ({
        name: 'My team',
        members: [{ name: 'lead-agent', agentType: 'team-lead', role: 'Lead' }],
        leadSessionId: 'lead-session-1',
      })),
    } as never,
    {} as never,
    {} as never,
    { sendMessage } as never,
    {} as never,
    {} as never,
    {} as never,
    null,
    {} as never,
    {} as never,
    () =>
      ({
        taskBoard: {
          getTask: vi.fn(() => options.task),
          createTask: vi.fn(() => options.task),
          reconcileTaskCreation: vi.fn(() => options.task),
        },
      }) as never
  );
  service.setTaskBoardCommandFacade({ createTask: commandFacadeCreateTask } as never);
  return { service, sendMessage, commandFacadeCreateTask };
}

function createMembersMetaStoreMock(
  initialMembers: TeamMember[],
  writeMembers: (
    teamName: string,
    members: TeamMember[],
    options?: { providerBackendId?: string }
  ) => Promise<unknown> = vi.fn(async () => undefined)
) {
  let members = initialMembers;
  const getMembers = vi.fn(async () => members);
  const updateMembers = vi.fn(
    async (
      teamName: string,
      update: (currentMembers: readonly TeamMember[]) => TeamMember[] | Promise<TeamMember[]>,
      options?: { providerBackendId?: string }
    ) => {
      members = await update(members);
      if (options === undefined) {
        await writeMembers(teamName, members);
      } else {
        await writeMembers(teamName, members, options);
      }
    }
  );
  return { getMembers, writeMembers, updateMembers } as never;
}

function createRosterMutationService(
  membersMetaStore: unknown,
  options: { running?: boolean; teamName?: string; leadProviderId?: TeamMember['providerId'] } = {}
): TeamDataService {
  const teamName = options.teamName ?? 'runtime-team';
  return new TeamDataService(
    { getConfig: vi.fn(), listTeams: vi.fn() } as never,
    { getTasks: vi.fn(async () => []) } as never,
    { listInboxNames: vi.fn(async () => []), getMessages: vi.fn(async () => []) } as never,
    {} as never,
    {} as never,
    { resolveMembers: vi.fn(() => []) } as never,
    { getState: vi.fn(async () => ({ teamName, reviewers: [], tasks: {} })) } as never,
    {} as never,
    membersMetaStore as never,
    { readMessages: vi.fn(async () => []) } as never,
    (() =>
      ({
        processes: {
          listProcesses: vi.fn(async () =>
            options.running
              ? [
                  {
                    id: 'run-1',
                    label: teamName,
                    pid: 123,
                    registeredAt: new Date().toISOString(),
                  },
                ]
              : []
          ),
        },
      }) as never) as never,
    {} as never,
    { getMeta: vi.fn(async () => ({ providerId: options.leadProviderId ?? 'codex' })) } as never
  );
}

describe('TeamDataService', () => {
  it('rejects duplicate member names in replaceMembers', async () => {
    const writeMembers = vi.fn(async () => {});
    const membersMetaStore = createMembersMetaStoreMock([], writeMembers);

    const service = new TeamDataService(
      { getConfig: vi.fn(), listTeams: vi.fn() } as never,
      { getTasks: vi.fn(async () => []) } as never,
      { listInboxNames: vi.fn(async () => []), getMessages: vi.fn(async () => []) } as never,
      {} as never,
      {} as never,
      { resolveMembers: vi.fn(() => []) } as never,
      {
        getState: vi.fn(async () => ({ teamName: 'dup-team', reviewers: [], tasks: {} })),
      } as never,
      {} as never,
      membersMetaStore,
      { readMessages: vi.fn(async () => []) } as never
    );

    await expect(
      service.replaceMembers('dup-team', {
        members: [
          { name: 'alice', role: 'Reviewer' },
          { name: 'alice', role: 'Developer' },
        ],
      })
    ).rejects.toThrow('Member "alice" already exists');

    expect(writeMembers).not.toHaveBeenCalled();
  });

  it('rejects invalid or reserved member names in replaceMembers', async () => {
    const writeMembers = vi.fn(async () => {});
    const membersMetaStore = createMembersMetaStoreMock([], writeMembers);

    const service = new TeamDataService(
      { getConfig: vi.fn(), listTeams: vi.fn() } as never,
      { getTasks: vi.fn(async () => []) } as never,
      { listInboxNames: vi.fn(async () => []), getMessages: vi.fn(async () => []) } as never,
      {} as never,
      {} as never,
      { resolveMembers: vi.fn(() => []) } as never,
      {
        getState: vi.fn(async () => ({ teamName: 'dup-team', reviewers: [], tasks: {} })),
      } as never,
      {} as never,
      membersMetaStore,
      { readMessages: vi.fn(async () => []) } as never
    );

    await expect(
      service.replaceMembers('dup-team', {
        members: [{ name: 'bad/name', role: 'Reviewer' }],
      })
    ).rejects.toThrow('Member name "bad/name" is invalid');

    await expect(
      service.replaceMembers('dup-team', {
        members: [{ name: 'user', role: 'Reviewer' }],
      })
    ).rejects.toThrow('Member name "user" is reserved');

    expect(writeMembers).not.toHaveBeenCalled();
  });

  it('preserves agentId for existing members during replaceMembers', async () => {
    const writeMembers = vi.fn(async () => {});
    const membersMetaStore = createMembersMetaStoreMock(
      [
        {
          name: 'alice',
          role: 'Developer',
          providerId: 'codex',
          model: 'gpt-5.4-mini',
          effort: 'medium',
          agentType: 'general-purpose',
          agentId: 'alice@runtime-team',
          joinedAt: 1710000000000,
        },
      ],
      writeMembers
    );

    const service = new TeamDataService(
      { getConfig: vi.fn(), listTeams: vi.fn() } as never,
      { getTasks: vi.fn(async () => []) } as never,
      { listInboxNames: vi.fn(async () => []), getMessages: vi.fn(async () => []) } as never,
      {} as never,
      {} as never,
      { resolveMembers: vi.fn(() => []) } as never,
      {
        getState: vi.fn(async () => ({ teamName: 'runtime-team', reviewers: [], tasks: {} })),
      } as never,
      {} as never,
      membersMetaStore,
      { readMessages: vi.fn(async () => []) } as never
    );

    await service.replaceMembers('runtime-team', {
      members: [
        {
          name: 'alice',
          role: 'Reviewer',
          providerId: 'codex',
          model: 'gpt-5.2',
          effort: 'high',
        },
      ],
    });

    expect(writeMembers).toHaveBeenCalledWith(
      'runtime-team',
      expect.arrayContaining([
        expect.objectContaining({
          name: 'alice',
          role: 'Reviewer',
          providerId: 'codex',
          model: 'gpt-5.2',
          effort: 'high',
          agentId: 'alice@runtime-team',
        }),
      ])
    );
  });

  it('persists teammate worktree isolation in replaceMembers', async () => {
    const writeMembers = vi.fn(async () => {});
    const membersMetaStore = createMembersMetaStoreMock([], writeMembers);

    const service = new TeamDataService(
      { getConfig: vi.fn(), listTeams: vi.fn() } as never,
      { getTasks: vi.fn(async () => []) } as never,
      { listInboxNames: vi.fn(async () => []), getMessages: vi.fn(async () => []) } as never,
      {} as never,
      {} as never,
      { resolveMembers: vi.fn(() => []) } as never,
      {
        getState: vi.fn(async () => ({ teamName: 'runtime-team', reviewers: [], tasks: {} })),
      } as never,
      {} as never,
      membersMetaStore,
      { readMessages: vi.fn(async () => []) } as never
    );

    await service.replaceMembers('runtime-team', {
      members: [
        { name: 'alice', role: 'Developer', isolation: 'worktree' },
        { name: 'bob', role: 'Reviewer' },
      ],
    });

    const [, writtenMembers] = writeMembers.mock.calls[0] as unknown as [
      string,
      Array<{
        name: string;
        isolation?: 'worktree';
      }>,
    ];
    expect(writtenMembers.find((member) => member.name === 'alice')).toMatchObject({
      isolation: 'worktree',
    });
    expect(writtenMembers.find((member) => member.name === 'bob')?.isolation).toBeUndefined();
  });

  it('persists member-level provider backend and fast mode during replaceMembers', async () => {
    const writeMembers = vi.fn(async () => {});
    const membersMetaStore = createMembersMetaStoreMock([], writeMembers);

    const service = new TeamDataService(
      { getConfig: vi.fn(), listTeams: vi.fn() } as never,
      { getTasks: vi.fn(async () => []) } as never,
      { listInboxNames: vi.fn(async () => []), getMessages: vi.fn(async () => []) } as never,
      {} as never,
      {} as never,
      { resolveMembers: vi.fn(() => []) } as never,
      {
        getState: vi.fn(async () => ({ teamName: 'runtime-team', reviewers: [], tasks: {} })),
      } as never,
      {} as never,
      membersMetaStore,
      { readMessages: vi.fn(async () => []) } as never,
      (() => ({ processes: { listProcesses: vi.fn(async () => []) } }) as never) as never,
      {} as never,
      { getMeta: vi.fn(async () => ({ providerId: 'codex' })) } as never
    );

    await service.replaceMembers('runtime-team', {
      members: [
        {
          name: 'alice',
          providerId: 'codex',
          providerBackendId: 'codex-native',
          model: 'gpt-5.4',
          effort: 'high',
          fastMode: 'on',
        },
      ],
    });

    expect(writeMembers).toHaveBeenCalledWith(
      'runtime-team',
      expect.arrayContaining([
        expect.objectContaining({
          name: 'alice',
          providerId: 'codex',
          providerBackendId: 'codex-native',
          model: 'gpt-5.4',
          effort: 'high',
          fastMode: 'on',
        }),
      ])
    );
  });

  it('persists member-level provider backend and fast mode during addMember', async () => {
    const writeMembers = vi.fn(async () => {});
    const membersMetaStore = createMembersMetaStoreMock([], writeMembers);

    const service = new TeamDataService(
      { getConfig: vi.fn(), listTeams: vi.fn() } as never,
      { getTasks: vi.fn(async () => []) } as never,
      { listInboxNames: vi.fn(async () => []), getMessages: vi.fn(async () => []) } as never,
      {} as never,
      {} as never,
      { resolveMembers: vi.fn(() => []) } as never,
      {
        getState: vi.fn(async () => ({ teamName: 'runtime-team', reviewers: [], tasks: {} })),
      } as never,
      {} as never,
      membersMetaStore,
      { readMessages: vi.fn(async () => []) } as never,
      (() => ({ processes: { listProcesses: vi.fn(async () => []) } }) as never) as never,
      {} as never,
      { getMeta: vi.fn(async () => ({ providerId: 'codex' })) } as never
    );

    await service.addMember('runtime-team', {
      name: 'alice',
      providerId: 'codex',
      providerBackendId: 'codex-native',
      fastMode: 'on',
    });

    expect(writeMembers).toHaveBeenCalledWith(
      'runtime-team',
      expect.arrayContaining([
        expect.objectContaining({
          name: 'alice',
          providerId: 'codex',
          providerBackendId: 'codex-native',
          fastMode: 'on',
        }),
      ])
    );
  });

  it('allows multiple OpenCode teammates in replaceMembers drafts before they are persisted', async () => {
    const writeMembers = vi.fn(async () => {});
    const membersMetaStore = createMembersMetaStoreMock([], writeMembers);

    const service = new TeamDataService(
      { getConfig: vi.fn(), listTeams: vi.fn() } as never,
      { getTasks: vi.fn(async () => []) } as never,
      { listInboxNames: vi.fn(async () => []), getMessages: vi.fn(async () => []) } as never,
      {} as never,
      {} as never,
      { resolveMembers: vi.fn(() => []) } as never,
      {
        getState: vi.fn(async () => ({ teamName: 'runtime-team', reviewers: [], tasks: {} })),
      } as never,
      {} as never,
      membersMetaStore,
      { readMessages: vi.fn(async () => []) } as never,
      (() => ({ processes: { listProcesses: vi.fn(async () => []) } }) as never) as never,
      {} as never,
      { getMeta: vi.fn(async () => ({ providerId: 'codex' })) } as never
    );

    await expect(
      service.replaceMembers('runtime-team', {
        members: [
          { name: 'alice', providerId: 'opencode', model: 'minimax-m2.5-free' },
          { name: 'bob', providerId: 'opencode', model: 'nemotron-3-super-free' },
        ],
      })
    ).resolves.toBeUndefined();

    expect(writeMembers).toHaveBeenCalledTimes(1);
  });

  it('blocks live addMember on a running mixed team', async () => {
    const writeMembers = vi.fn(async () => {});
    const membersMetaStore = createMembersMetaStoreMock(
      [
        {
          name: 'alice',
          role: 'Reviewer',
          providerId: 'opencode',
          model: 'minimax-m2.5-free',
          agentType: 'general-purpose',
        },
      ],
      writeMembers
    );

    const service = new TeamDataService(
      { getConfig: vi.fn(), listTeams: vi.fn() } as never,
      { getTasks: vi.fn(async () => []) } as never,
      { listInboxNames: vi.fn(async () => []), getMessages: vi.fn(async () => []) } as never,
      {} as never,
      {} as never,
      { resolveMembers: vi.fn(() => []) } as never,
      {
        getState: vi.fn(async () => ({ teamName: 'mixed-team', reviewers: [], tasks: {} })),
      } as never,
      {} as never,
      membersMetaStore,
      { readMessages: vi.fn(async () => []) } as never,
      (() =>
        ({
          processes: {
            listProcesses: vi.fn(async () => [
              {
                id: 'run-1',
                label: 'mixed-team',
                pid: 123,
                registeredAt: new Date().toISOString(),
              },
            ]),
          },
        }) as never) as never,
      {} as never,
      { getMeta: vi.fn(async () => ({ providerId: 'codex' })) } as never
    );

    await expect(
      service.addMember('mixed-team', {
        name: 'bob',
        role: 'Developer',
        providerId: 'codex',
        model: 'gpt-5.4',
        effort: 'medium',
      })
    ).rejects.toThrow(
      'Live roster mutation on a running mixed team is not supported in V1. Stop the team, edit the roster, then relaunch.'
    );

    expect(writeMembers).not.toHaveBeenCalled();
  });

  it('blocks live replaceMembers on a running mixed team', async () => {
    const writeMembers = vi.fn(async () => {});
    const membersMetaStore = createMembersMetaStoreMock(
      [
        {
          name: 'alice',
          role: 'Reviewer',
          providerId: 'opencode',
          model: 'minimax-m2.5-free',
          agentType: 'general-purpose',
        },
      ],
      writeMembers
    );

    const service = new TeamDataService(
      { getConfig: vi.fn(), listTeams: vi.fn() } as never,
      { getTasks: vi.fn(async () => []) } as never,
      { listInboxNames: vi.fn(async () => []), getMessages: vi.fn(async () => []) } as never,
      {} as never,
      {} as never,
      { resolveMembers: vi.fn(() => []) } as never,
      {
        getState: vi.fn(async () => ({ teamName: 'mixed-team', reviewers: [], tasks: {} })),
      } as never,
      {} as never,
      membersMetaStore,
      { readMessages: vi.fn(async () => []) } as never,
      (() =>
        ({
          processes: {
            listProcesses: vi.fn(async () => [
              {
                id: 'run-1',
                label: 'mixed-team',
                pid: 123,
                registeredAt: new Date().toISOString(),
              },
            ]),
          },
        }) as never) as never,
      {} as never,
      { getMeta: vi.fn(async () => ({ providerId: 'codex' })) } as never
    );

    await expect(
      service.replaceMembers('mixed-team', {
        members: [{ name: 'alice', providerId: 'codex', model: 'gpt-5.4', effort: 'high' }],
      })
    ).rejects.toThrow(
      'Live roster mutation on a running mixed team is not supported in V1. Stop the team, edit the roster, then relaunch.'
    );

    expect(writeMembers).not.toHaveBeenCalled();
  });

  it('validates an add against the locked roster after a concurrent policy-sensitive change', async () => {
    const staleProjectedMembers: TeamMember[] = [
      {
        name: 'primary-reviewer',
        providerId: 'codex',
        model: 'gpt-5.4',
      },
    ];
    const lockedMembers: TeamMember[] = [
      ...staleProjectedMembers,
      {
        name: 'concurrent-side-lane',
        providerId: 'opencode',
        model: 'minimax-m2.5-free',
      },
    ];
    const writeMembers = vi.fn(async (_teamName: string, _members: readonly TeamMember[]) =>
      undefined
    );
    const getMembers = vi.fn(async () => staleProjectedMembers);
    const updateMembers = vi.fn(
      async (
        teamName: string,
        update: (members: readonly TeamMember[]) => TeamMember[] | Promise<TeamMember[]>
      ) => {
        const nextMembers = await update(lockedMembers);
        await writeMembers(teamName, nextMembers);
      }
    );
    const service = createRosterMutationService(
      { getMembers, updateMembers, writeMembers },
      { running: true, teamName: 'mixed-team', leadProviderId: 'codex' }
    );

    await expect(
      service.addMember('mixed-team', {
        name: 'new-primary',
        providerId: 'codex',
        model: 'gpt-5.4',
      })
    ).rejects.toThrow(
      'Live roster mutation on a running mixed team is not supported in V1. Stop the team, edit the roster, then relaunch.'
    );

    expect(updateMembers).toHaveBeenCalledTimes(1);
    expect(getMembers).not.toHaveBeenCalled();
    expect(writeMembers).not.toHaveBeenCalled();
  });

  it('allows live removeMember for an OpenCode-owned member on a running mixed team', async () => {
    const writeMembers = vi.fn(async () => {});
    const membersMetaStore = createMembersMetaStoreMock(
      [
        {
          name: 'alice',
          role: 'Reviewer',
          providerId: 'opencode',
          model: 'minimax-m2.5-free',
          agentType: 'general-purpose',
        },
      ],
      writeMembers
    );

    const service = new TeamDataService(
      { getConfig: vi.fn(), listTeams: vi.fn() } as never,
      { getTasks: vi.fn(async () => []) } as never,
      { listInboxNames: vi.fn(async () => []), getMessages: vi.fn(async () => []) } as never,
      {} as never,
      {} as never,
      { resolveMembers: vi.fn(() => []) } as never,
      {
        getState: vi.fn(async () => ({ teamName: 'mixed-team', reviewers: [], tasks: {} })),
      } as never,
      {} as never,
      membersMetaStore,
      { readMessages: vi.fn(async () => []) } as never,
      (() =>
        ({
          processes: {
            listProcesses: vi.fn(async () => [
              {
                id: 'run-1',
                label: 'mixed-team',
                pid: 123,
                registeredAt: new Date().toISOString(),
              },
            ]),
          },
        }) as never) as never,
      {} as never,
      { getMeta: vi.fn(async () => ({ providerId: 'codex' })) } as never
    );

    await expect(service.removeMember('mixed-team', 'alice')).resolves.toBeUndefined();

    expect(writeMembers).toHaveBeenCalledTimes(1);
  });

  it('does not carry over agentId from a previously removed member with the same name', async () => {
    const writeMembers = vi.fn(async () => {});
    const membersMetaStore = createMembersMetaStoreMock(
      [
        {
          name: 'alice',
          role: 'Developer',
          providerId: 'codex',
          model: 'gpt-5.4-mini',
          effort: 'medium',
          agentType: 'general-purpose',
          agentId: 'alice@old-runtime-team',
          joinedAt: 1710000000000,
          removedAt: 1715000000000,
        },
      ],
      writeMembers
    );

    const service = new TeamDataService(
      { getConfig: vi.fn(), listTeams: vi.fn() } as never,
      { getTasks: vi.fn(async () => []) } as never,
      { listInboxNames: vi.fn(async () => []), getMessages: vi.fn(async () => []) } as never,
      {} as never,
      {} as never,
      { resolveMembers: vi.fn(() => []) } as never,
      {
        getState: vi.fn(async () => ({ teamName: 'runtime-team', reviewers: [], tasks: {} })),
      } as never,
      {} as never,
      membersMetaStore,
      { readMessages: vi.fn(async () => []) } as never
    );

    await service.replaceMembers('runtime-team', {
      members: [
        {
          name: 'alice',
          role: 'Reviewer',
          providerId: 'codex',
          model: 'gpt-5.2',
          effort: 'high',
        },
      ],
    });

    expect(writeMembers).toHaveBeenCalledWith(
      'runtime-team',
      expect.arrayContaining([
        expect.objectContaining({
          name: 'alice',
          role: 'Reviewer',
          providerId: 'codex',
          model: 'gpt-5.2',
          effort: 'high',
          agentId: undefined,
          removedAt: undefined,
        }),
      ])
    );
  });

  it('restores a removed member without reusing the stale runtime agent id', async () => {
    const writeMembers = vi.fn(async () => {});
    const membersMetaStore = createMembersMetaStoreMock(
      [
        {
          name: 'alice',
          role: 'Developer',
          providerId: 'codex',
          model: 'gpt-5.4-mini',
          effort: 'medium',
          agentType: 'general-purpose',
          agentId: 'alice@old-runtime-team',
          joinedAt: 1710000000000,
          removedAt: 1715000000000,
        },
        {
          name: 'bob',
          role: 'Reviewer',
          providerId: 'codex',
          agentType: 'general-purpose',
          joinedAt: 1710000100000,
        },
      ],
      writeMembers
    );

    const service = new TeamDataService(
      { getConfig: vi.fn(), listTeams: vi.fn() } as never,
      { getTasks: vi.fn(async () => []) } as never,
      { listInboxNames: vi.fn(async () => []), getMessages: vi.fn(async () => []) } as never,
      {} as never,
      {} as never,
      { resolveMembers: vi.fn(() => []) } as never,
      {
        getState: vi.fn(async () => ({ teamName: 'runtime-team', reviewers: [], tasks: {} })),
      } as never,
      {} as never,
      membersMetaStore,
      { readMessages: vi.fn(async () => []) } as never
    );

    await expect(service.restoreMember('runtime-team', 'alice')).resolves.toMatchObject({
      name: 'alice',
      role: 'Developer',
      agentId: undefined,
      removedAt: undefined,
    });

    expect(writeMembers).toHaveBeenCalledWith(
      'runtime-team',
      expect.arrayContaining([
        expect.objectContaining({
          name: 'alice',
          role: 'Developer',
          agentId: undefined,
          removedAt: undefined,
        }),
      ])
    );
  });

  it('adds a member through atomic update without overwriting an unrelated tombstone', async () => {
    const removedAt = Date.parse('2026-07-19T10:00:00.000Z');
    let persistedMembers: TeamMember[] = [];
    const membersMetaStore = {
      getMembers: vi.fn(async () => [{ name: 'alice', role: 'Builder' }]),
      updateMembers: vi.fn(
        async (
          _teamName: string,
          update: (members: readonly TeamMember[]) => TeamMember[] | Promise<TeamMember[]>
        ) => {
          persistedMembers = await update([
            { name: 'alice', role: 'Builder' },
            { name: 'charlie', role: 'Removed reviewer', removedAt },
          ]);
        }
      ),
      writeMembers: vi.fn(),
    };
    const service = createRosterMutationService(membersMetaStore);

    await service.addMember('runtime-team', { name: 'bob', role: 'Reviewer' });

    expect(persistedMembers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'bob', role: 'Reviewer' }),
        expect.objectContaining({ name: 'charlie', removedAt }),
      ])
    );
    expect(membersMetaStore.writeMembers).not.toHaveBeenCalled();
  });

  it('edits a member role through atomic update without overwriting an unrelated tombstone', async () => {
    const removedAt = Date.parse('2026-07-19T10:30:00.000Z');
    let persistedMembers: TeamMember[] = [];
    const membersMetaStore = {
      getMembers: vi.fn(async () => [{ name: 'alice', role: 'Builder' }]),
      updateMembers: vi.fn(
        async (
          _teamName: string,
          update: (members: readonly TeamMember[]) => TeamMember[] | Promise<TeamMember[]>
        ) => {
          persistedMembers = await update([
            { name: 'alice', role: 'Builder' },
            { name: 'charlie', role: 'Removed reviewer', removedAt },
          ]);
        }
      ),
      writeMembers: vi.fn(),
    };
    const service = createRosterMutationService(membersMetaStore);

    await expect(service.updateMemberRole('runtime-team', 'alice', 'Lead builder')).resolves.toEqual(
      {
        oldRole: 'Builder',
        changed: true,
      }
    );

    expect(persistedMembers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'alice', role: 'Lead builder' }),
        expect.objectContaining({ name: 'charlie', removedAt }),
      ])
    );
    expect(membersMetaStore.writeMembers).not.toHaveBeenCalled();
  });

  it('restores from the locked current roster and preserves a concurrent unrelated tombstone', async () => {
    const aliceRemovedAt = Date.parse('2026-07-19T11:00:00.000Z');
    const charlieRemovedAt = Date.parse('2026-07-19T11:05:00.000Z');
    let persistedMembers: TeamMember[] = [];
    const membersMetaStore = {
      getMembers: vi.fn(async () => [
        {
          name: 'alice',
          role: 'Builder',
          agentId: 'alice@old-runtime-team',
          removedAt: aliceRemovedAt,
        },
      ]),
      updateMembers: vi.fn(
        async (
          _teamName: string,
          update: (members: readonly TeamMember[]) => TeamMember[] | Promise<TeamMember[]>
        ) => {
          persistedMembers = await update([
            {
              name: 'alice',
              role: 'Builder',
              agentId: 'alice@old-runtime-team',
              removedAt: aliceRemovedAt,
            },
            { name: 'charlie', role: 'Removed reviewer', removedAt: charlieRemovedAt },
          ]);
        }
      ),
      writeMembers: vi.fn(),
    };
    const service = createRosterMutationService(membersMetaStore);

    await expect(service.restoreMember('runtime-team', 'alice')).resolves.toMatchObject({
      name: 'alice',
      role: 'Builder',
      agentId: undefined,
      removedAt: undefined,
    });
    expect(persistedMembers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'alice', agentId: undefined, removedAt: undefined }),
        expect.objectContaining({ name: 'charlie', removedAt: charlieRemovedAt }),
      ])
    );
    expect(membersMetaStore.writeMembers).not.toHaveBeenCalled();
  });

  it('propagates atomic roster update failures without reporting an add or edit as successful', async () => {
    const updateMembers = vi.fn(async () => {
      throw new Error('members metadata disk full');
    });
    const membersMetaStore = {
      getMembers: vi.fn(async () => [{ name: 'alice', role: 'Builder' }]),
      updateMembers,
      writeMembers: vi.fn(),
    };
    const service = createRosterMutationService(membersMetaStore);

    await expect(
      service.addMember('runtime-team', { name: 'bob', role: 'Reviewer' })
    ).rejects.toThrow('members metadata disk full');
    await expect(
      service.updateMemberRole('runtime-team', 'alice', 'Lead builder')
    ).rejects.toThrow('members metadata disk full');
    expect(updateMembers).toHaveBeenCalledTimes(2);
    expect(membersMetaStore.writeMembers).not.toHaveBeenCalled();
  });

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
        getConfig: vi.fn(async () => ({
          name: 'My team',
          members: [{ name: 'team-lead', role: 'Lead' }],
        })),
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
        getConfig: vi.fn(async () => ({
          name: 'My team',
          members: [{ name: 'team-lead', role: 'Lead' }],
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
        garbageCollect: vi.fn(async () => undefined),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      () =>
        ({
          taskBoard: {
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
    const getConfig = vi.fn(async () => {
      throw new Error('verified config read should not be used for task enrichment');
    });
    const getConfigSnapshot = vi.fn(async () => ({
      name: 'My team',
      members: [],
      projectPath: '/Users/dev/my-project',
    }));

    const service = new TeamDataService(
      {
        listTeams: vi.fn(),
        getConfig,
        getConfigSnapshot,
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
      (_teamName: string) =>
        ({
          taskBoard: {
            createTask: createTaskMock,
          },
        }) as never
    );

    const result = await service.createTask('my-team', { subject: 'Test' });

    expect(result.projectPath).toBe('/Users/dev/my-project');
    expect(createTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({ projectPath: '/Users/dev/my-project' })
    );
    expect(getConfigSnapshot).toHaveBeenCalledWith('my-team');
    expect(getConfig).not.toHaveBeenCalled();
  });

  it('routes identified task creates through the durable command facade without legacy fallback', async () => {
    const directCreate = vi.fn();
    const durableTask = {
      id: '11111111-1111-4111-8111-111111111111',
      subject: 'Durable task',
      status: 'pending' as const,
    };
    const commandFacade = {
      createTask: vi.fn(async (_command: unknown) => ({
        task: durableTask,
        outcome: 'executed',
        createdInAttempt: true,
      })),
    };
    let supportsReconciliation = true;
    const reconcileTaskCreation = vi.fn();
    const service = new TeamDataService(
      {
        getConfig: vi.fn(async () => ({ name: 'My team', members: [] })),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      null,
      {} as never,
      {} as never,
      () =>
        ({
          taskBoard: {
            getTask: vi.fn(),
            createTask: directCreate,
            reconcileTaskCreation: supportsReconciliation ? reconcileTaskCreation : undefined,
          },
        }) as never
    );
    service.setTaskBoardCommandFacade(commandFacade as never);
    const command = {
      commandId: durableTask.id,
      idempotencyKey: 'create-task-intent-1',
    };

    await expect(
      service.createTask('my-team', { subject: durableTask.subject, command })
    ).resolves.toEqual(durableTask);
    expect(commandFacade.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        teamName: 'my-team',
        identity: command,
        payload: expect.objectContaining({ subject: durableTask.subject, createdBy: 'user' }),
        destination: expect.objectContaining({
          findById: expect.any(Function),
          create: expect.any(Function),
          reconcile: expect.any(Function),
        }),
      })
    );
    expect(directCreate).not.toHaveBeenCalled();

    supportsReconciliation = false;
    const fallbackCommand = {
      commandId: '22222222-2222-4222-8222-222222222222',
      idempotencyKey: 'create-task-intent-2',
    };
    await expect(
      service.createTask('my-team', {
        subject: 'Durable fallback task',
        command: fallbackCommand,
      })
    ).resolves.toEqual(durableTask);
    expect(commandFacade.createTask).toHaveBeenCalledTimes(2);
    expect(commandFacade.createTask.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        identity: fallbackCommand,
        destination: expect.not.objectContaining({
          reconcile: expect.anything(),
        }),
      })
    );
    expect(directCreate).not.toHaveBeenCalled();
  });

  it('uses one legacy create when durable task commands are unavailable', async () => {
    const commandId = '33333333-3333-4333-8333-333333333333';
    const legacyTask: TeamTask = {
      id: commandId,
      subject: 'Legacy task',
      status: 'pending',
    };
    let storedTask: (TeamTask & { creationCommand?: unknown }) | null = null;
    const directCreate = vi.fn((input: Record<string, unknown>) => {
      storedTask = {
        ...legacyTask,
        creationCommand: input.creationCommand,
      };
      return storedTask;
    });
    const getTask = vi.fn((taskId: string) => {
      if (!storedTask || storedTask.id !== taskId) {
        throw new Error(`Task not found: ${taskId}`);
      }
      return storedTask;
    });
    const reconcileTaskCreation = vi.fn(() => storedTask);
    const service = new TeamDataService(
      {
        getConfig: vi.fn(async () => ({
          name: 'My team',
          members: [],
          projectPath: '/projects/legacy',
        })),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      null,
      {} as never,
      {} as never,
      () =>
        ({
          taskBoard: {
            getTask,
            createTask: directCreate,
            reconcileTaskCreation,
          },
        }) as never
    );

    await expect(
      service.createTask('my-team', {
        subject: legacyTask.subject,
        command: {
          commandId,
          idempotencyKey: 'create-task-intent-3',
        },
      })
    ).resolves.toEqual(legacyTask);

    expect(directCreate).toHaveBeenCalledOnce();
    expect(directCreate).toHaveBeenCalledWith({
      subject: legacyTask.subject,
      createdBy: 'user',
      projectPath: '/projects/legacy',
      id: commandId,
      creationCommand: {
        namespace: 'task-board',
        scopeKey: 'my-team',
        operation: 'task.create',
        commandId,
        payloadHash: expect.stringMatching(/^sha256:/),
      },
    });
    expect(reconcileTaskCreation).toHaveBeenCalledOnce();
  });

  it('notifies a lead-owned task from the final started state on fresh durable execution', async () => {
    const task: TeamTask = {
      id: '11111111-1111-4111-8111-111111111111',
      displayId: '11111111',
      subject: 'Durable lead task',
      description: 'Use the final task description.',
      owner: 'lead-agent',
      status: 'in_progress',
    };
    const { service, sendMessage } = createDurableTaskStartNotificationHarness({ task });

    await expect(
      service.createTask('my-team', {
        subject: task.subject,
        owner: 'lead-agent',
        startImmediately: true,
        command: {
          commandId: task.id,
          idempotencyKey: 'durable-lead-task',
        },
      })
    ).resolves.toEqual(task);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      'my-team',
      expect.objectContaining({
        member: 'lead-agent',
        from: 'user',
        source: 'system_notification',
        leadSessionId: 'lead-session-1',
        messageId: 'task-start:my-team:11111111-1111-4111-8111-111111111111',
        summary: 'Start working on #11111111',
      })
    );
    expect(sendMessage.mock.calls[0]?.[1]?.text).toContain(
      'This start notification can become stale after reassignment or completion.'
    );
    expect(sendMessage.mock.calls[0]?.[1]?.text).toContain(
      'If the owner changed or the task is completed/deleted, do not start or reopen it'
    );
    expect(sendMessage.mock.calls[0]?.[1]?.text).toContain(
      'task_complete { teamName: "my-team", taskId: "11111111-1111-4111-8111-111111111111", actor: "lead-agent" }'
    );
  });

  it.each(['reconciled', 'replayed'])(
    'notifies from the resolved lead-owned started state when a durable command is %s',
    async (outcome) => {
      const task: TeamTask = {
        id: '11111111-1111-4111-8111-111111111111',
        subject: 'Recovered lead task',
        owner: 'lead-agent',
        status: 'in_progress',
      };
      const { service, sendMessage } = createDurableTaskStartNotificationHarness({
        task,
        commandResults: [{ outcome, createdInAttempt: false }],
      });

      await service.createTask('my-team', {
        subject: task.subject,
        owner: 'lead-agent',
        startImmediately: true,
        command: {
          commandId: task.id,
          idempotencyKey: 'recovered-lead-task',
        },
      });

      expect(sendMessage).toHaveBeenCalledWith(
        'my-team',
        expect.objectContaining({
          messageId: 'task-start:my-team:11111111-1111-4111-8111-111111111111',
        })
      );
    }
  );

  it.each([
    {
      name: 'a non-lead owner',
      owner: 'alice',
      status: 'in_progress' as const,
    },
    {
      name: 'a non-started final state',
      owner: 'lead-agent',
      status: 'pending' as const,
    },
  ])('does not send the durable lead notification for $name', async ({ owner, status }) => {
    const task: TeamTask = {
      id: '11111111-1111-4111-8111-111111111111',
      subject: 'No lead notification',
      owner,
      status,
    };
    const { service, sendMessage } = createDurableTaskStartNotificationHarness({
      task,
      commandResults: [{ outcome: 'replayed', createdInAttempt: false }],
    });

    await service.createTask('my-team', {
      subject: task.subject,
      owner: 'lead-agent',
      startImmediately: true,
      command: {
        commandId: task.id,
        idempotencyKey: 'no-lead-notification',
      },
    });

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('attempts the same deterministic lead notification on every durable replay', async () => {
    const task: TeamTask = {
      id: '11111111-1111-4111-8111-111111111111',
      subject: 'Replay notification',
      owner: 'lead-agent',
      status: 'in_progress',
    };
    const { service, sendMessage } = createDurableTaskStartNotificationHarness({
      task,
      commandResults: [
        { outcome: 'replayed', createdInAttempt: false },
        { outcome: 'replayed', createdInAttempt: false },
      ],
    });
    const request = {
      subject: task.subject,
      owner: 'lead-agent',
      startImmediately: true,
      command: {
        commandId: task.id,
        idempotencyKey: 'replay-notification',
      },
    };

    await service.createTask('my-team', request);
    await service.createTask('my-team', request);

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls.map((call) => call[1]?.messageId)).toEqual([
      'task-start:my-team:11111111-1111-4111-8111-111111111111',
      'task-start:my-team:11111111-1111-4111-8111-111111111111',
    ]);
  });

  it('keeps a post-commit notification failure nonfatal and deduplicates its replay', async () => {
    const task: TeamTask = {
      id: '11111111-1111-4111-8111-111111111111',
      subject: 'Retry notification',
      owner: 'lead-agent',
      status: 'in_progress',
    };
    const notificationFailure = {
      message: 'notification-message-field-marker',
      stack: 'notification-stack-field-marker',
      path: '/private/notification-path-field-marker/team.json',
      details: { value: 'notification-object-field-marker' },
      cause: { message: 'notification-cause-field-marker' },
      code: 'notification-code-field-marker',
      toString: () => 'notification-string-field-marker',
    };
    const deliveredMessageIds = new Set<string>();
    const deliveryDeduplication: boolean[] = [];
    let deliveryAttempt = 0;
    const sendMessage = vi.fn(async (_teamName: string, notification: { messageId?: string }) => {
      const messageId = notification.messageId ?? 'missing-message-id';
      const deduplicated = deliveredMessageIds.has(messageId);
      deliveryAttempt += 1;
      deliveredMessageIds.add(messageId);
      if (deliveryAttempt === 1) {
        throw notificationFailure;
      }
      deliveryDeduplication.push(deduplicated);
      return {
        deliveredToInbox: true,
        messageId,
        ...(deduplicated ? { deduplicated: true } : {}),
      };
    });
    let commitFirstAttempt: ((value: unknown) => void) | undefined;
    const commandFacadeCreateTask = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            commitFirstAttempt = resolve;
          })
      )
      .mockResolvedValueOnce({
        task,
        outcome: 'replayed',
        createdInAttempt: false,
      });
    const { service } = createDurableTaskStartNotificationHarness({
      task,
      sendMessage,
      commandFacadeCreateTask,
    });
    const request = {
      subject: task.subject,
      owner: 'lead-agent',
      startImmediately: true,
      command: {
        commandId: task.id,
        idempotencyKey: 'retry-notification',
      },
    };

    const firstCreate = service.createTask('my-team', request);
    expect(commandFacadeCreateTask).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();

    commitFirstAttempt?.({
      task,
      outcome: 'executed',
      createdInAttempt: true,
    });
    await expect(firstCreate).resolves.toEqual(task);
    await expect(service.createTask('my-team', request)).resolves.toEqual(task);

    expect(commandFacadeCreateTask).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls.map((call) => call[1]?.messageId)).toEqual([
      'task-start:my-team:11111111-1111-4111-8111-111111111111',
      'task-start:my-team:11111111-1111-4111-8111-111111111111',
    ]);
    expect([...deliveredMessageIds]).toEqual([
      'task-start:my-team:11111111-1111-4111-8111-111111111111',
    ]);
    expect(deliveryDeduplication).toEqual([true]);

    const warningCalls = vi.mocked(console.warn).mock.calls;
    expect(warningCalls).toEqual([
      [
        '[Service:TeamDataService]',
        '[TeamDataService] category=post_commit_notification code=task_start_notification_failed team=my-team task=11111111-1111-4111-8111-111111111111',
      ],
    ]);
    const warningOutput = warningCalls.flat().map(String).join('\n');
    expect(warningOutput.length).toBeLessThanOrEqual(256);
    for (const rawValue of [
      notificationFailure.message,
      notificationFailure.stack,
      notificationFailure.path,
      notificationFailure.details.value,
      notificationFailure.cause.message,
      notificationFailure.code,
      String(notificationFailure),
    ]) {
      expect(warningOutput).not.toContain(rawValue);
    }
    vi.mocked(console.warn).mockClear();
  });

  it('rejects a pre-commit persistence failure without sending a notification', async () => {
    const task: TeamTask = {
      id: '11111111-1111-4111-8111-111111111111',
      subject: 'Persistence retry',
      owner: 'lead-agent',
      status: 'in_progress',
    };
    const persistenceFailure = new Error('pre-commit-persistence-failure');
    const { service, sendMessage, commandFacadeCreateTask } =
      createDurableTaskStartNotificationHarness({ task });
    commandFacadeCreateTask.mockRejectedValueOnce(persistenceFailure);
    const request = {
      subject: task.subject,
      owner: 'lead-agent',
      startImmediately: true,
      command: {
        commandId: task.id,
        idempotencyKey: 'persistence-retry',
      },
    };

    await expect(service.createTask('my-team', request)).rejects.toBe(persistenceFailure);
    expect(sendMessage).not.toHaveBeenCalled();

    await expect(service.createTask('my-team', request)).resolves.toEqual(task);
    expect(commandFacadeCreateTask).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      'my-team',
      expect.objectContaining({
        messageId: 'task-start:my-team:11111111-1111-4111-8111-111111111111',
      })
    );
  });

  it('keeps non-durable task-start notification failure best-effort', async () => {
    const task: TeamTask = {
      id: 'legacy-task-1',
      subject: 'Legacy best-effort task',
      owner: 'lead-agent',
      status: 'in_progress',
    };
    const sendMessage = vi.fn(() => {
      throw new Error('legacy inbox unavailable');
    });
    const service = new TeamDataService(
      {
        getConfig: vi.fn(async () => ({
          name: 'My team',
          members: [{ name: 'lead-agent', agentType: 'team-lead', role: 'Lead' }],
        })),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      null,
      {} as never,
      {} as never,
      () =>
        ({
          taskBoard: { createTask: vi.fn(() => task) },
          messages: { sendMessage },
        }) as never
    );

    await expect(
      service.createTask('my-team', {
        subject: task.subject,
        owner: 'lead-agent',
        startImmediately: true,
      })
    ).resolves.toEqual(task);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('keeps derived projectPath outside the normalized durable command payload', async () => {
    const directCreate = vi.fn((input: Record<string, unknown>) => ({
      ...input,
      status: 'pending' as const,
    }));
    const commandFacade = {
      createTask: vi.fn(
        async (command: {
          identity: { commandId: string };
          payload: Record<string, unknown>;
          destination: { create(input: Record<string, unknown>): Promise<TeamTask> | TeamTask };
        }) => ({
          task: await command.destination.create({
            ...command.payload,
            id: command.identity.commandId,
            creationCommand: {
              namespace: 'task-board',
              scopeKey: 'my-team',
              operation: 'task.create',
              commandId: command.identity.commandId,
              payloadHash: 'sha256:test',
            },
          }),
          outcome: 'executed',
          createdInAttempt: true,
        })
      ),
    };
    const service = new TeamDataService(
      {
        getConfig: vi.fn(() =>
          Promise.resolve({
            name: 'My team',
            members: [],
            projectPath: '/projects/current',
          })
        ),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      null,
      {} as never,
      {} as never,
      () =>
        ({
          taskBoard: {
            getTask: vi.fn(),
            createTask: directCreate,
            reconcileTaskCreation: vi.fn(),
          },
        }) as never
    );
    service.setTaskBoardCommandFacade(commandFacade as never);

    await service.createTask('my-team', {
      subject: 'Stable intent',
      blockedBy: ['task-b', 'task-a', 'task-b'],
      related: ['task-d', 'task-c', 'task-d'],
      command: {
        commandId: '44444444-4444-4444-8444-444444444444',
        idempotencyKey: 'stable-intent',
      },
    });

    expect(commandFacade.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          blockedBy: ['task-a', 'task-b'],
          related: ['task-c', 'task-d'],
        }),
      })
    );
    expect(commandFacade.createTask.mock.calls[0]?.[0].payload).not.toHaveProperty('projectPath');
    expect(directCreate).toHaveBeenCalledWith(
      expect.objectContaining({ projectPath: '/projects/current' })
    );
  });

  it('returns lightweight notification context from config without hydrating team data', async () => {
    const getConfig = vi.fn(async () => ({
      name: 'My Team',
      projectPath: '/Users/dev/my-project',
      members: [],
    }));
    const getConfigSnapshot = vi.fn(async () => ({
      name: 'My Team',
      projectPath: '/Users/dev/my-project',
      members: [],
    }));

    const service = new TeamDataService(
      {
        listTeams: vi.fn(),
        getConfig,
        getConfigSnapshot,
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
      (() => ({ processes: { listProcesses: vi.fn(() => []) } })) as never
    );

    const result = await service.getTeamNotificationContext('my-team');

    expect(result).toEqual({
      displayName: 'My Team',
      projectPath: '/Users/dev/my-project',
    });
    expect(getConfigSnapshot).toHaveBeenCalledWith('my-team');
    expect(getConfig).not.toHaveBeenCalled();
  });

  it('deduplicates repeated notification context reads', async () => {
    const getConfig = vi.fn(async () => ({
      name: 'Fallback Team',
      members: [],
    }));
    const getConfigSnapshot = vi.fn(async () => ({
      name: 'My Team',
      projectPath: '/Users/dev/my-project',
      members: [],
    }));

    const service = new TeamDataService(
      {
        listTeams: vi.fn(),
        getConfig,
        getConfigSnapshot,
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
      (() => ({ processes: { listProcesses: vi.fn(() => []) } })) as never
    );

    const [first, second] = await Promise.all([
      service.getTeamNotificationContext('my-team'),
      service.getTeamNotificationContext('my-team'),
    ]);
    const third = await service.getTeamNotificationContext('my-team');

    expect(first).toEqual({
      displayName: 'My Team',
      projectPath: '/Users/dev/my-project',
    });
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(getConfigSnapshot).toHaveBeenCalledTimes(1);
    expect(getConfig).not.toHaveBeenCalled();
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
      (_teamName: string) =>
        ({
          taskBoard: {
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
    expect(createTaskMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ startImmediately: true })
    );
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
          taskBoard: {
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
    expect(createTaskMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: 'in_progress' })
    );
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
      (_teamName: string) =>
        ({
          taskBoard: {
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
      actionMode: 'ask',
      commentId: 'comment-1',
    });

    expect(result).toEqual({ deliveredToInbox: true, messageId: 'm-1' });
    expect(sendMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        member: 'alice',
        text: 'hello',
        summary: 'ping',
        actionMode: 'ask',
        commentId: 'comment-1',
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
          taskBoard: {
            requestReview: requestReviewMock,
          },
        }) as never
    );

    await service.requestReview('my-team', 'task-1');

    expect(requestReviewMock).toHaveBeenCalledWith('task-1', {
      from: 'lead',
      leadSessionId: 'lead-1',
    });
  });

  it('resolves the canonical lead instead of matching tech-lead role text', async () => {
    const requestReviewMock = vi.fn();

    const service = new TeamDataService(
      {
        listTeams: vi.fn(),
        getConfig: vi.fn(async () => ({
          name: 'My team',
          members: [
            { name: 'alice', role: 'tech lead' },
            { name: 'team-lead', agentType: 'team-lead', role: 'lead' },
          ],
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
          taskBoard: {
            requestReview: requestReviewMock,
          },
        }) as never
    );

    await service.requestReview('my-team', 'task-1');

    expect(requestReviewMock).toHaveBeenCalledWith('task-1', {
      from: 'team-lead',
      leadSessionId: 'lead-1',
    });
  });

  it('preserves legacy kanban reviewer for tasks still in review without review history', async () => {
    const service = new TeamDataService(
      {
        listTeams: vi.fn(),
        getConfig: vi.fn(async () => ({
          name: 'My team',
          members: [
            { name: 'lead', role: 'team lead' },
            { name: 'bob', role: 'developer' },
            { name: 'carol', role: 'reviewer' },
          ],
        })),
      } as never,
      {
        getTasks: vi.fn(async () => [
          {
            id: 'task-legacy-review',
            subject: 'Legacy review task',
            status: 'completed',
            owner: 'bob',
            reviewState: 'none',
            historyEvents: [
              {
                id: 'evt-created',
                type: 'task_created',
                status: 'completed',
                timestamp: '2026-03-01T09:00:00.000Z',
              },
            ],
          },
        ]),
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
        getState: vi.fn(async () => ({
          teamName: 'my-team',
          reviewers: [],
          tasks: {
            'task-legacy-review': {
              column: 'review',
              reviewer: 'carol',
              movedAt: '2026-03-01T10:00:00.000Z',
            },
          },
        })),
      } as never
    );

    const data = await service.getTeamData('my-team');

    expect(data.tasks[0]).toMatchObject({
      id: 'task-legacy-review',
      reviewState: 'review',
      kanbanColumn: 'review',
      reviewer: 'carol',
    });
  });

  it('does not leak stale reviewer after review is reset to pending', async () => {
    const service = new TeamDataService(
      {
        listTeams: vi.fn(),
        getConfig: vi.fn(async () => ({
          name: 'My team',
          members: [
            { name: 'lead', role: 'team lead' },
            { name: 'bob', role: 'developer' },
            { name: 'carol', role: 'reviewer' },
          ],
        })),
      } as never,
      {
        getTasks: vi.fn(async () => [
          {
            id: 'task-reopened',
            subject: 'Reopened task',
            status: 'pending',
            owner: 'bob',
            reviewState: 'none',
            historyEvents: [
              {
                id: 'evt-review',
                type: 'review_requested',
                from: 'none',
                to: 'review',
                reviewer: 'carol',
                timestamp: '2026-03-01T10:00:00.000Z',
              },
              {
                id: 'evt-pending',
                type: 'status_changed',
                from: 'completed',
                to: 'pending',
                timestamp: '2026-03-01T10:05:00.000Z',
              },
            ],
          },
        ]),
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

    const data = await service.getTeamData('my-team');

    expect(data.tasks[0]).toMatchObject({
      id: 'task-reopened',
      reviewState: 'none',
      reviewer: null,
    });
  });

  it('preserves kanban approved overlay even when task status is still in_progress', async () => {
    const harness = createGetTeamDataHarness({
      config: {
        name: 'My team',
        members: [{ name: 'jack', role: 'developer' }],
      },
      getTasks: async (): Promise<TeamTask[]> => [
        {
          id: 'task-approved',
          subject: 'Approved but stale status',
          status: 'in_progress',
          owner: 'jack',
          reviewState: 'none',
        },
      ],
      getState: async () => ({
        teamName: 'my-team',
        reviewers: [],
        tasks: {
          'task-approved': {
            column: 'approved',
            movedAt: '2026-05-06T19:06:07.257Z',
          },
        },
      }),
    });

    const data = await harness.service.getTeamData('my-team');

    expect(data.tasks[0]).toMatchObject({
      id: 'task-approved',
      status: 'in_progress',
      reviewState: 'approved',
      kanbanColumn: 'approved',
    });
    expect(harness.resolveMembersSpy).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Array),
      expect.any(Array),
      expect.arrayContaining([
        expect.objectContaining({
          id: 'task-approved',
          kanbanColumn: 'approved',
        }),
      ]),
      expect.any(Object)
    );
  });

  it('lets current kanban approved overlay win over stale review history', async () => {
    const harness = createGetTeamDataHarness({
      config: {
        name: 'My team',
        members: [{ name: 'jack', role: 'developer' }],
      },
      getTasks: async () => [
        {
          id: 'task-approved',
          subject: 'Approved after review',
          status: 'in_progress',
          owner: 'jack',
          reviewState: 'none',
          historyEvents: [
            {
              id: 'review-started',
              type: 'review_started',
              timestamp: '2026-05-06T19:00:00.000Z',
              from: 'none',
              to: 'review',
            },
          ],
        },
      ],
      getState: async () => ({
        teamName: 'my-team',
        reviewers: [],
        tasks: {
          'task-approved': {
            column: 'approved',
            movedAt: '2026-05-06T19:06:07.257Z',
          },
        },
      }),
    });

    const data = await harness.service.getTeamData('my-team');

    expect(data.tasks[0]).toMatchObject({
      id: 'task-approved',
      status: 'in_progress',
      reviewState: 'approved',
      kanbanColumn: 'approved',
      reviewer: null,
    });
  });

  it('lets current kanban review overlay win over stale approved review state', async () => {
    const harness = createGetTeamDataHarness({
      config: {
        name: 'My team',
        members: [{ name: 'jack', role: 'developer' }],
      },
      getTasks: async () => [
        {
          id: 'task-review',
          subject: 'Moved back to review',
          status: 'completed',
          owner: 'jack',
          reviewState: 'approved',
        },
      ],
      getState: async () => ({
        teamName: 'my-team',
        reviewers: [],
        tasks: {
          'task-review': {
            column: 'review',
            reviewer: 'carol',
            movedAt: '2026-05-06T19:06:07.257Z',
          },
        },
      }),
    });

    const data = await harness.service.getTeamData('my-team');

    expect(data.tasks[0]).toMatchObject({
      id: 'task-review',
      status: 'completed',
      reviewState: 'review',
      kanbanColumn: 'review',
      reviewer: 'carol',
    });
  });

  it('does not preserve stale kanban approved overlay for reopened pending tasks', async () => {
    const harness = createGetTeamDataHarness({
      config: {
        name: 'My team',
        members: [{ name: 'jack', role: 'developer' }],
      },
      getTasks: async () => [
        {
          id: 'task-reopened',
          subject: 'Reopened pending task',
          status: 'pending',
          owner: 'jack',
          reviewState: 'none',
          historyEvents: [
            {
              id: 'review-approved',
              type: 'review_approved',
              timestamp: '2026-05-06T19:00:00.000Z',
              from: 'review',
              to: 'approved',
              actor: 'carol',
            },
          ],
        },
      ],
      getState: async () => ({
        teamName: 'my-team',
        reviewers: [],
        tasks: {
          'task-reopened': {
            column: 'approved',
            movedAt: '2026-05-06T19:06:07.257Z',
          },
        },
      }),
    });

    const data = await harness.service.getTeamData('my-team');

    expect(data.tasks[0]).toMatchObject({
      id: 'task-reopened',
      status: 'pending',
      reviewState: 'none',
    });
    expect(data.tasks[0]?.kanbanColumn).toBeUndefined();
  });

  it('applies kanban overlay review state in global task projections', async () => {
    const service = new TeamDataService(
      {
        listTeams: vi.fn(async () => [
          {
            teamName: 'my-team',
            displayName: 'My team',
            projectPath: '/repo',
          },
        ]),
      } as never,
      {
        getAllTasks: vi.fn(async () => [
          {
            id: 'task-global-review',
            teamName: 'my-team',
            subject: 'Global review task',
            status: 'completed',
            owner: 'bob',
            reviewState: 'none',
            historyEvents: [
              {
                id: 'evt-created',
                type: 'task_created',
                status: 'completed',
                timestamp: '2026-03-01T09:00:00.000Z',
              },
            ],
          },
        ]),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {
        getState: vi.fn(async () => ({
          teamName: 'my-team',
          reviewers: [],
          tasks: {
            'task-global-review': {
              column: 'review',
              reviewer: 'carol',
              movedAt: '2026-03-01T10:00:00.000Z',
            },
          },
        })),
      } as never
    );

    const tasks = await service.getAllTasks();

    expect(tasks[0]).toMatchObject({
      id: 'task-global-review',
      reviewState: 'review',
      kanbanColumn: 'review',
    });
  });

  it('uses config snapshots instead of full team summaries for global task team info', async () => {
    const listTeams = vi.fn(async () => [
      {
        teamName: 'my-team',
        displayName: 'My team from list',
        projectPath: '/repo-from-list',
      },
    ]);
    const getConfigSnapshot = vi.fn(async (teamName: string) =>
      teamName === 'my-team'
        ? {
            name: 'My team from config',
            members: [{ name: 'lead', role: 'Team Lead', cwd: '/repo-from-lead' }],
            deletedAt: '2026-03-01T12:00:00.000Z',
          }
        : null
    );
    const service = new TeamDataService(
      {
        listTeams,
        getConfigSnapshot,
      } as never,
      {
        getAllTasks: vi.fn(async () => [
          {
            id: 'task-global-config',
            teamName: 'my-team',
            subject: 'Global config task',
            status: 'pending',
            owner: 'bob',
          },
        ]),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {
        getState: vi.fn(async () => ({
          teamName: 'my-team',
          reviewers: [],
          tasks: {},
        })),
      } as never
    );

    const tasks = await service.getAllTasks();

    expect(listTeams).not.toHaveBeenCalled();
    expect(getConfigSnapshot).toHaveBeenCalledWith('my-team');
    expect(tasks[0]).toMatchObject({
      id: 'task-global-config',
      teamDisplayName: 'My team from config',
      projectPath: '/repo-from-lead',
      teamDeleted: true,
    });
  });

  it('caps global task projections before building lightweight comment payloads', async () => {
    const rawTasks = Array.from({ length: 501 }, (_, index) => ({
      id: `task-${index}`,
      teamName: index === 0 ? 'old-team' : 'my-team',
      subject: `Task ${index}`,
      status: 'pending' as const,
      owner: 'bob',
      createdAt: `2026-03-01T00:${String(index % 60).padStart(2, '0')}:00.000Z`,
      updatedAt: `2026-03-01T${String(Math.floor(index / 60)).padStart(2, '0')}:${String(
        index % 60
      ).padStart(2, '0')}:00.000Z`,
      comments: [
        {
          id: `comment-${index}`,
          author: 'bob',
          text: `Comment ${index}`,
          createdAt: '2026-03-01T09:00:00.000Z',
          type: 'comment' as const,
        },
      ],
    }));
    const getState = vi.fn(async (teamName: string) => ({
      teamName,
      reviewers: [],
      tasks: {},
    }));
    const service = new TeamDataService(
      {
        listTeams: vi.fn(async () => [
          {
            teamName: 'my-team',
            displayName: 'My team',
            projectPath: '/repo',
          },
          {
            teamName: 'old-team',
            displayName: 'Old team',
            projectPath: '/old-repo',
          },
        ]),
      } as never,
      {
        getAllTasks: vi.fn(async () => rawTasks),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {
        getState,
      } as never
    );

    const tasks = await service.getAllTasks();

    expect(tasks).toHaveLength(500);
    expect(tasks[0]?.id).toBe('task-500');
    expect(tasks.some((task) => task.id === 'task-0')).toBe(false);
    expect(tasks[0]?.comments?.[0]).toMatchObject({
      id: 'comment-500',
      text: 'Comment 500',
    });
    expect(getState).not.toHaveBeenCalledWith('old-team');
  });

  it('lets kanban approved overlay win over stale review history in global task projections', async () => {
    const service = new TeamDataService(
      {
        listTeams: vi.fn(async () => [
          {
            teamName: 'my-team',
            displayName: 'My team',
            projectPath: '/repo',
          },
        ]),
      } as never,
      {
        getAllTasks: vi.fn(async () => [
          {
            id: 'task-global-approved',
            teamName: 'my-team',
            subject: 'Global approved task',
            status: 'completed',
            owner: 'bob',
            reviewState: 'none',
            historyEvents: [
              {
                id: 'evt-review',
                type: 'review_started',
                from: 'none',
                to: 'review',
                timestamp: '2026-03-01T09:00:00.000Z',
              },
            ],
          },
        ]),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {
        getState: vi.fn(async () => ({
          teamName: 'my-team',
          reviewers: [],
          tasks: {
            'task-global-approved': {
              column: 'approved',
              reviewer: 'carol',
              movedAt: '2026-03-01T10:00:00.000Z',
            },
          },
        })),
      } as never
    );

    const tasks = await service.getAllTasks();

    expect(tasks[0]).toMatchObject({
      id: 'task-global-approved',
      reviewState: 'approved',
      kanbanColumn: 'approved',
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
          taskBoard: {
            getTask: vi.fn(() => ({
              id: 'task-1',
              status: 'completed',
              reviewState: 'none',
            })),
            getKanbanState: vi.fn(() => ({
              teamName: 'my-team',
              reviewers: [],
              tasks: {
                'task-1': {
                  column: 'review',
                  movedAt: '2026-05-20T10:00:00.000Z',
                },
              },
            })),
            requestReview: requestReviewMock,
            approveReview: approveReviewMock,
            requestChanges: requestChangesMock,
          },
        }) as never
    );

    await service.updateKanban('my-team', 'task-1', { op: 'set_column', column: 'review' });
    await service.updateKanban('my-team', 'task-1', { op: 'set_column', column: 'approved' });
    await service.updateKanban('my-team', 'task-1', {
      op: 'request_changes',
      comment: 'Needs fixes',
    });

    expect(requestReviewMock).toHaveBeenCalledWith('task-1', {
      from: 'lead',
      leadSessionId: 'lead-2',
    });
    expect(approveReviewMock).toHaveBeenCalledWith('task-1', {
      from: 'lead',
      suppressTaskComment: true,
      'notify-owner': true,
      leadSessionId: 'lead-2',
    });
    expect(requestChangesMock).toHaveBeenCalledWith('task-1', {
      from: 'lead',
      comment: 'Needs fixes',
      leadSessionId: 'lead-2',
    });
  });

  it('uses direct kanban approval for completed tasks that are not in review', async () => {
    const approveReviewMock = vi.fn();
    const setKanbanColumnMock = vi.fn();

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
          taskBoard: {
            getTask: vi.fn(() => ({
              id: 'task-1',
              status: 'completed',
              reviewState: 'none',
              historyEvents: [],
            })),
            getKanbanState: vi.fn(() => ({
              teamName: 'my-team',
              reviewers: [],
              tasks: {},
            })),
            setKanbanColumn: setKanbanColumnMock,
            approveReview: approveReviewMock,
          },
        }) as never
    );

    await service.updateKanban('my-team', 'task-1', { op: 'set_column', column: 'approved' });

    expect(setKanbanColumnMock).toHaveBeenCalledWith('task-1', 'approved', {
      transition: 'manual_approve',
    });
    expect(approveReviewMock).not.toHaveBeenCalled();
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
      withEntries: vi.fn(
        async (_teamName: string, fn: (entries: unknown[]) => Promise<{ result: unknown }>) => {
          const outcome = await fn(journalEntries);
          return outcome.result;
        }
      ),
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

  it('uses startup team summary lead fields without rereading config for comment notification baselines', async () => {
    const previous = process.env[TASK_COMMENT_FORWARDING_ENV];
    process.env[TASK_COMMENT_FORWARDING_ENV] = 'on';
    const journalEntries: Array<Record<string, unknown>> = [];
    const inboxWriter = { sendMessage: vi.fn() };
    const getConfig = vi.fn(async () => {
      throw new Error('unexpected config read');
    });
    const journal = {
      exists: vi.fn(async () => false),
      ensureFile: vi.fn(async () => undefined),
      withEntries: vi.fn(
        async (_teamName: string, fn: (entries: unknown[]) => Promise<{ result: unknown }>) => {
          const outcome = await fn(journalEntries);
          return outcome.result;
        }
      ),
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
              leadName: 'team-lead',
              leadSessionId: 'lead-1',
            },
          ]),
          getConfig,
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

      expect(getConfig).not.toHaveBeenCalled();
      expect(inboxWriter.sendMessage).not.toHaveBeenCalled();
      expect(journalEntries).toEqual([
        expect.objectContaining({
          key: 'task-1:comment-1',
          state: 'seeded',
          messageId: 'task-comment-forward:my-team:task-1:comment-1',
        }),
      ]);
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
      withEntries: vi.fn(
        async (_teamName: string, fn: (entries: unknown[]) => Promise<{ result: unknown }>) => {
          const outcome = await fn(journalEntries);
          return outcome.result;
        }
      ),
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
      const firstSendRequest = (
        inboxWriter.sendMessage as unknown as { mock: { calls: unknown[][] } }
      ).mock.calls[0]?.[1] as { text?: string } | undefined;
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
      withEntries: vi.fn(
        async (_teamName: string, fn: (entries: unknown[]) => Promise<{ result: unknown }>) => {
          const outcome = await fn(journalEntries);
          return outcome.result;
        }
      ),
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
      withEntries: vi.fn(
        async (_teamName: string, fn: (entries: unknown[]) => Promise<{ result: unknown }>) => {
          const outcome = await fn(journalEntries);
          return outcome.result;
        }
      ),
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
      withEntries: vi.fn(
        async (_teamName: string, fn: (entries: unknown[]) => Promise<{ result: unknown }>) => {
          const outcome = await fn(journalEntries);
          return outcome.result;
        }
      ),
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
      sendMessage: vi.fn(async () => ({
        deliveredToInbox: true,
        messageId: 'task-comment-forward:my-team:task-1:comment-1',
      })),
    };
    const journal = {
      exists: vi.fn(async () => true),
      ensureFile: vi.fn(async () => undefined),
      withEntries: vi.fn(
        async (_teamName: string, fn: (entries: unknown[]) => Promise<{ result: unknown }>) => {
          const outcome = await fn(journalEntries);
          return outcome.result;
        }
      ),
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
      withEntries: vi.fn(
        async (_teamName: string, fn: (entries: unknown[]) => Promise<{ result: unknown }>) => {
          const outcome = await fn(journalEntries);
          return outcome.result;
        }
      ),
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
      withEntries: vi.fn(
        async (_teamName: string, fn: (entries: unknown[]) => Promise<{ result: unknown }>) => {
          const outcome = await fn(journalEntries);
          return outcome.result;
        }
      ),
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
      expect(journal.withEntries).toHaveBeenCalledTimes(3);
      expect(journalEntries[0]).toMatchObject({
        state: 'sent',
      });
    } finally {
      if (previous === undefined) delete process.env[TASK_COMMENT_FORWARDING_ENV];
      else process.env[TASK_COMMENT_FORWARDING_ENV] = previous;
    }
  });

  it('queues same-task comment notification refreshes that arrive during an active pass', async () => {
    const previous = process.env[TASK_COMMENT_FORWARDING_ENV];
    process.env[TASK_COMMENT_FORWARDING_ENV] = 'on';
    const journalEntries: Array<Record<string, unknown>> = [];
    let withEntriesCalls = 0;
    let releaseFirstJournalWrite: (() => void) | undefined;
    let resolveFirstJournalWriteStarted: (() => void) | undefined;
    const firstJournalWriteStarted = new Promise<void>((resolve) => {
      resolveFirstJournalWriteStarted = resolve;
    });
    const firstJournalWriteGate = new Promise<void>((resolve) => {
      releaseFirstJournalWrite = resolve;
    });
    const inboxWriter = {
      sendMessage: vi.fn(async (_teamName: string, message: { messageId?: string }) => ({
        deliveredToInbox: true,
        messageId: message.messageId ?? 'msg-1',
      })),
    };
    const firstTaskSnapshot = {
      id: 'task-1',
      displayId: 'abcd1234',
      subject: 'Investigate',
      status: 'pending',
      owner: 'alice',
      comments: [
        {
          id: 'comment-1',
          author: 'alice',
          text: 'First task update.',
          createdAt: '2026-03-14T10:00:00.000Z',
          type: 'regular',
        },
      ],
    };
    const secondTaskSnapshot = {
      ...firstTaskSnapshot,
      comments: [
        ...firstTaskSnapshot.comments,
        {
          id: 'comment-2',
          author: 'alice',
          text: 'Second task update.',
          createdAt: '2026-03-14T10:01:00.000Z',
          type: 'regular',
        },
      ],
    };
    const journal = {
      exists: vi.fn(async () => true),
      ensureFile: vi.fn(async () => undefined),
      withEntries: vi.fn(
        async (_teamName: string, fn: (entries: unknown[]) => Promise<{ result: unknown }>) => {
          withEntriesCalls += 1;
          if (withEntriesCalls === 1) {
            resolveFirstJournalWriteStarted?.();
            await firstJournalWriteGate;
          }
          const outcome = await fn(journalEntries);
          return outcome.result;
        }
      ),
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
          getTasks: vi
            .fn()
            .mockResolvedValueOnce([firstTaskSnapshot])
            .mockResolvedValue([secondTaskSnapshot]),
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
      await firstJournalWriteStarted;
      const second = service.notifyLeadOnTeammateTaskComment('my-team', 'task-1');

      if (!releaseFirstJournalWrite) {
        throw new Error('Expected journal release');
      }
      releaseFirstJournalWrite();

      await first;
      await second;

      expect(inboxWriter.sendMessage).toHaveBeenCalledTimes(2);
      expect(journalEntries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: 'task-1:comment-1', state: 'sent' }),
          expect.objectContaining({ key: 'task-1:comment-2', state: 'sent' }),
        ])
      );
    } finally {
      if (previous === undefined) delete process.env[TASK_COMMENT_FORWARDING_ENV];
      else process.env[TASK_COMMENT_FORWARDING_ENV] = previous;
    }
  });

  it('serializes concurrent task comment notification passes for one team journal', async () => {
    const previous = process.env[TASK_COMMENT_FORWARDING_ENV];
    process.env[TASK_COMMENT_FORWARDING_ENV] = 'on';
    const journalEntries: Array<Record<string, unknown>> = [];
    let activeJournalWrites = 0;
    let maxActiveJournalWrites = 0;
    let withEntriesCalls = 0;
    let releaseFirstJournalWrite: (() => void) | undefined;
    let resolveFirstJournalWriteStarted: (() => void) | undefined;
    const firstJournalWriteStarted = new Promise<void>((resolve) => {
      resolveFirstJournalWriteStarted = resolve;
    });
    const firstJournalWriteGate = new Promise<void>((resolve) => {
      releaseFirstJournalWrite = resolve;
    });
    const inboxWriter = {
      sendMessage: vi.fn(async (_teamName: string, message: { messageId?: string }) => ({
        deliveredToInbox: true,
        messageId: message.messageId ?? 'msg-1',
      })),
    };
    const journal = {
      exists: vi.fn(async () => true),
      ensureFile: vi.fn(async () => undefined),
      withEntries: vi.fn(
        async (_teamName: string, fn: (entries: unknown[]) => Promise<{ result: unknown }>) => {
          withEntriesCalls += 1;
          activeJournalWrites += 1;
          maxActiveJournalWrites = Math.max(maxActiveJournalWrites, activeJournalWrites);
          try {
            if (withEntriesCalls === 1) {
              resolveFirstJournalWriteStarted?.();
              await firstJournalWriteGate;
            }
            const outcome = await fn(journalEntries);
            return outcome.result;
          } finally {
            activeJournalWrites -= 1;
          }
        }
      ),
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
              displayId: 'aaaa1111',
              subject: 'Investigate A',
              status: 'pending',
              owner: 'alice',
              comments: [
                {
                  id: 'comment-1',
                  author: 'alice',
                  text: 'First task update.',
                  createdAt: '2026-03-14T10:00:00.000Z',
                  type: 'regular',
                },
              ],
            },
            {
              id: 'task-2',
              displayId: 'bbbb2222',
              subject: 'Investigate B',
              status: 'pending',
              owner: 'bob',
              comments: [
                {
                  id: 'comment-2',
                  author: 'bob',
                  text: 'Second task update.',
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

      const first = service.notifyLeadOnTeammateTaskComment('my-team', 'task-1');
      await firstJournalWriteStarted;
      const second = service.notifyLeadOnTeammateTaskComment('my-team', 'task-2');
      await Promise.resolve();

      expect(journal.withEntries).toHaveBeenCalledTimes(1);
      expect(maxActiveJournalWrites).toBe(1);

      if (!releaseFirstJournalWrite) {
        throw new Error('Expected journal release');
      }
      releaseFirstJournalWrite();

      await first;
      await second;

      expect(maxActiveJournalWrites).toBe(1);
      expect(inboxWriter.sendMessage).toHaveBeenCalledTimes(2);
      expect(journalEntries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: 'task-1:comment-1', state: 'sent' }),
          expect.objectContaining({ key: 'task-2:comment-2', state: 'sent' }),
        ])
      );
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
      withEntries: vi.fn(
        async (_teamName: string, fn: (entries: unknown[]) => Promise<{ result: unknown }>) => {
          const outcome = await fn(journalEntries);
          return outcome.result;
        }
      ),
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
    const inboxWriter = {
      sendMessage: vi.fn(async () => ({ deliveredToInbox: true, messageId: 'msg-1' })),
    };
    const journalEntries: Array<Record<string, unknown>> = [];
    const journal = {
      exists: vi.fn(async () => true),
      ensureFile: vi.fn(async () => undefined),
      withEntries: vi.fn(
        async (_teamName: string, fn: (entries: unknown[]) => Promise<{ result: unknown }>) => {
          const outcome = await fn(journalEntries);
          return outcome.result;
        }
      ),
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

  it('propagates persisted needs_attention presence through lightweight presence reads', async () => {
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
          version: 2,
          teamName: 'my-team',
          projectFingerprint: 'project-fingerprint',
          logSourceGeneration: 'log-generation',
          writtenAt: '2026-03-01T12:00:00.000Z',
          entries: {
            'task-1': {
              taskId: 'task-1',
              taskSignature: descriptor.taskSignature,
              presence: 'needs_attention',
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

    expect(data).toEqual({ 'task-1': 'needs_attention' });
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

    const feed = await service.getMessageFeed('my-team');
    const costResult = feed.messages.find((message) => message.messageId === 'lead-thought-1');

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

    const feed = await service.getMessageFeed('my-team');
    const result = feed.messages.find((message) => message.messageId === 'passive-idle-dup-1');

    expect(result).toBeDefined();
    expect(result?.source).not.toBe('lead_process');
    expect(result).toMatchObject({
      summary: 'Peer summary',
      read: true,
    });
  });

  function createPassiveUserSummaryLinkService(options: {
    inboxMessages?: InboxMessage[];
    sentMessages?: InboxMessage[];
  }): TeamDataService {
    const { inboxMessages = [], sentMessages = [] } = options;
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
        getMessages: vi.fn(async () => inboxMessages),
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
        readMessages: vi.fn(async () => sentMessages),
      } as never
    );
  }

  it('links passive [to user] acknowledgement summaries to the canonical user reply transiently', async () => {
    const passiveSummaryRow: InboxMessage = {
      from: 'alice',
      text: JSON.stringify({
        type: 'idle_notification',
        idleReason: 'available',
        summary: '[to user] acknowledgement',
      }),
      timestamp: '2026-04-08T10:00:05.000Z',
      read: true,
      messageId: 'passive-user-summary-1',
    };
    const userReplyRow: InboxMessage = {
      from: 'alice',
      to: 'user',
      text: 'Да, я здесь. Готова к работе и жду задач для ревью.',
      timestamp: '2026-04-08T10:00:00.000Z',
      read: true,
      summary: 'acknowledgement',
      messageId: 'user-reply-1',
      source: 'user_sent',
    };
    const service = createPassiveUserSummaryLinkService({
      inboxMessages: [passiveSummaryRow],
      sentMessages: [userReplyRow],
    });

    const feed = await service.getMessageFeed('my-team');
    const linked = feed.messages.find((message) => message.messageId === 'passive-user-summary-1');

    expect(linked?.relayOfMessageId).toBe('user-reply-1');
    expect(passiveSummaryRow.relayOfMessageId).toBeUndefined();
  });

  it('links passive [to user] summaries when the summary body is contained in the user reply text', async () => {
    const service = createPassiveUserSummaryLinkService({
      inboxMessages: [
        {
          from: 'alice',
          text: JSON.stringify({
            type: 'idle_notification',
            idleReason: 'available',
            summary: '[to user] Я здесь.',
          }),
          timestamp: '2026-04-08T10:00:05.000Z',
          read: true,
          messageId: 'passive-user-summary-contains-1',
        },
      ],
      sentMessages: [
        {
          from: 'alice',
          to: 'user',
          text: 'Да, я здесь. Готова к работе и жду задач для ревью.',
          timestamp: '2026-04-08T10:00:00.000Z',
          read: true,
          summary: 'presence ack',
          messageId: 'user-reply-contains-1',
          source: 'user_sent',
        },
      ],
    });

    const feed = await service.getMessageFeed('my-team');
    const linked = feed.messages.find(
      (message) => message.messageId === 'passive-user-summary-contains-1'
    );

    expect(linked?.relayOfMessageId).toBe('user-reply-contains-1');
  });

  it('does not link passive [to user] summaries outside the 15s correlation window', async () => {
    const service = createPassiveUserSummaryLinkService({
      inboxMessages: [
        {
          from: 'alice',
          text: JSON.stringify({
            type: 'idle_notification',
            idleReason: 'available',
            summary: '[to user] acknowledgement',
          }),
          timestamp: '2026-04-08T10:00:16.000Z',
          read: true,
          messageId: 'passive-user-summary-old-1',
        },
      ],
      sentMessages: [
        {
          from: 'alice',
          to: 'user',
          text: 'Да, я здесь. Готова к работе и жду задач для ревью.',
          timestamp: '2026-04-08T10:00:00.000Z',
          read: true,
          summary: 'acknowledgement',
          messageId: 'user-reply-old-1',
          source: 'user_sent',
        },
      ],
    });

    const feed = await service.getMessageFeed('my-team');
    const linked = feed.messages.find(
      (message) => message.messageId === 'passive-user-summary-old-1'
    );

    expect(linked?.relayOfMessageId).toBeUndefined();
  });

  it('does not link passive peer summaries for recipients other than user', async () => {
    const service = createPassiveUserSummaryLinkService({
      inboxMessages: [
        {
          from: 'alice',
          text: JSON.stringify({
            type: 'idle_notification',
            idleReason: 'available',
            summary: '[to bob] aligned on rollout order',
          }),
          timestamp: '2026-04-08T10:00:05.000Z',
          read: true,
          messageId: 'passive-bob-summary-1',
        },
      ],
      sentMessages: [
        {
          from: 'alice',
          to: 'user',
          text: 'aligned on rollout order',
          timestamp: '2026-04-08T10:00:00.000Z',
          read: true,
          summary: 'aligned on rollout order',
          messageId: 'user-reply-bob-summary-1',
          source: 'user_sent',
        },
      ],
    });

    const feed = await service.getMessageFeed('my-team');
    const linked = feed.messages.find((message) => message.messageId === 'passive-bob-summary-1');

    expect(linked?.relayOfMessageId).toBeUndefined();
  });

  it('does not link passive [to user] summaries when the sender differs', async () => {
    const service = createPassiveUserSummaryLinkService({
      inboxMessages: [
        {
          from: 'alice',
          text: JSON.stringify({
            type: 'idle_notification',
            idleReason: 'available',
            summary: '[to user] acknowledgement',
          }),
          timestamp: '2026-04-08T10:00:05.000Z',
          read: true,
          messageId: 'passive-user-summary-sender-1',
        },
      ],
      sentMessages: [
        {
          from: 'bob',
          to: 'user',
          text: 'Да, я здесь.',
          timestamp: '2026-04-08T10:00:00.000Z',
          read: true,
          summary: 'acknowledgement',
          messageId: 'user-reply-sender-1',
          source: 'user_sent',
        },
      ],
    });

    const feed = await service.getMessageFeed('my-team');
    const linked = feed.messages.find(
      (message) => message.messageId === 'passive-user-summary-sender-1'
    );

    expect(linked?.relayOfMessageId).toBeUndefined();
  });

  it('does not link passive [to user] summaries when multiple plausible user replies exist', async () => {
    const service = createPassiveUserSummaryLinkService({
      inboxMessages: [
        {
          from: 'alice',
          text: JSON.stringify({
            type: 'idle_notification',
            idleReason: 'available',
            summary: '[to user] acknowledgement',
          }),
          timestamp: '2026-04-08T10:00:05.000Z',
          read: true,
          messageId: 'passive-user-summary-ambiguous-1',
        },
      ],
      sentMessages: [
        {
          from: 'alice',
          to: 'user',
          text: 'Да, я здесь.',
          timestamp: '2026-04-08T10:00:00.000Z',
          read: true,
          summary: 'acknowledgement',
          messageId: 'user-reply-ambiguous-1',
          source: 'user_sent',
        },
        {
          from: 'alice',
          to: 'user',
          text: 'Да, на месте.',
          timestamp: '2026-04-08T10:00:01.000Z',
          read: true,
          summary: 'acknowledgement',
          messageId: 'user-reply-ambiguous-2',
          source: 'user_sent',
        },
      ],
    });

    const feed = await service.getMessageFeed('my-team');
    const linked = feed.messages.find(
      (message) => message.messageId === 'passive-user-summary-ambiguous-1'
    );

    expect(linked?.relayOfMessageId).toBeUndefined();
  });

  it('coalesces Codex synthetic lead stream chunks into one lead-session message', async () => {
    const service = createLeadSessionCachingService();
    const jsonlPath = await createTempJsonl([
      createSyntheticLeadAssistantChunk('chunk-1', '2026-03-27T22:17:01.000Z', 'Соз'),
      createSyntheticLeadAssistantChunk('chunk-2', '2026-03-27T22:17:01.010Z', 'дал'),
      createSyntheticLeadAssistantChunk(
        'chunk-3',
        '2026-03-27T22:17:01.020Z',
        ' стартовую задачу для /212 и раздал работу.'
      ),
    ]);

    const extract = (
      service as unknown as {
        extractLeadSessionTextsFromJsonl: (
          jsonlPath: string,
          leadName: string,
          leadSessionId: string,
          maxTexts: number
        ) => Promise<Array<{ messageId?: string; text: string }>>;
      }
    ).extractLeadSessionTextsFromJsonl.bind(service);

    const messages = await extract(jsonlPath, 'team-lead', 'lead-1', 150);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      messageId: 'lead-thought-stream-chunk-1',
      text: 'Создал стартовую задачу для /212 и раздал работу.',
    });
  });

  it('extracts Claude synthetic quota errors as lead-session messages', async () => {
    const service = createLeadSessionCachingService();
    const jsonlPath = await createTempJsonl([
      createSyntheticLeadApiErrorEntry(
        'quota-1',
        '2026-07-01T20:46:55.944Z',
        "You're out of extra usage · resets 11:50pm (Europe/Kiev)"
      ),
    ]);

    const extract = (
      service as unknown as {
        extractLeadSessionTextsFromJsonl: (
          jsonlPath: string,
          leadName: string,
          leadSessionId: string,
          maxTexts: number
        ) => Promise<InboxMessage[]>;
      }
    ).extractLeadSessionTextsFromJsonl.bind(service);

    const messages = await extract(jsonlPath, 'team-lead', 'lead-1', 150);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      from: 'team-lead',
      source: 'lead_session',
      leadSessionId: 'lead-1',
      messageId: 'lead-thought-stream-quota-1',
      text: "You're out of extra usage · resets 11:50pm (Europe/Kiev)",
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

    const assistantSpy = vi.spyOn(
      teamDataServicePrivate(service),
      'extractLeadAssistantTextsFromJsonlLines'
    );
    const extract = (
      service as unknown as {
        extractLeadSessionTextsFromJsonl: (
          jsonlPath: string,
          leadName: string,
          leadSessionId: string,
          maxTexts: number
        ) => Promise<InboxMessage[]>;
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
        extractLeadAssistantTextsFromJsonlLines: (
          rawLines: readonly string[],
          leadName: string,
          leadSessionId: string,
          maxTexts: number
        ) => Promise<InboxMessage[]>;
      }
    ).extractLeadAssistantTextsFromJsonlLines.bind(service);
    const assistantSpy = vi
      .spyOn(teamDataServicePrivate(service), 'extractLeadAssistantTextsFromJsonlLines')
      .mockImplementation(async (...args: unknown[]) => {
        const [rawLines, leadName, leadSessionId, maxTexts] = args as [
          readonly string[],
          string,
          string,
          number,
        ];
        await new Promise((resolve) => setTimeout(resolve, 25));
        return originalExtract(rawLines, leadName, leadSessionId, maxTexts);
      });
    const extract = (
      service as unknown as {
        extractLeadSessionTextsFromJsonl: (
          jsonlPath: string,
          leadName: string,
          leadSessionId: string,
          maxTexts: number
        ) => Promise<InboxMessage[]>;
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
        extractLeadAssistantTextsFromJsonlLines: (
          rawLines: readonly string[],
          leadName: string,
          leadSessionId: string,
          maxTexts: number
        ) => Promise<InboxMessage[]>;
      }
    ).extractLeadAssistantTextsFromJsonlLines.bind(service);
    let appended = false;
    const assistantSpy = vi
      .spyOn(teamDataServicePrivate(service), 'extractLeadAssistantTextsFromJsonlLines')
      .mockImplementation(async (...args: unknown[]) => {
        const [rawLines, leadName, leadSessionId, maxTexts] = args as [
          readonly string[],
          string,
          string,
          number,
        ];
        if (!appended) {
          appended = true;
          await fs.appendFile(
            jsonlPath,
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
        return originalExtract(rawLines, leadName, leadSessionId, maxTexts);
      });
    const extract = (
      service as unknown as {
        extractLeadSessionTextsFromJsonl: (
          jsonlPath: string,
          leadName: string,
          leadSessionId: string,
          maxTexts: number
        ) => Promise<InboxMessage[]>;
      }
    ).extractLeadSessionTextsFromJsonl.bind(service);

    const first = await extract(jsonlPath, 'team-lead', 'lead-1', 150);
    const second = await extract(jsonlPath, 'team-lead', 'lead-1', 150);

    expect(assistantSpy).toHaveBeenCalledTimes(2);
    expect(first).toHaveLength(1);
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
        extractLeadAssistantTextsFromJsonlLines: (
          rawLines: readonly string[],
          leadName: string,
          leadSessionId: string,
          maxTexts: number
        ) => Promise<InboxMessage[]>;
      }
    ).extractLeadAssistantTextsFromJsonlLines.bind(service);
    let releaseFirstInvocation = () => {};
    let firstInvocationStartedResolve: (() => void) | null = null;
    const firstInvocationStarted = new Promise<void>((resolve) => {
      firstInvocationStartedResolve = resolve;
    });
    const assistantSpy = vi
      .spyOn(teamDataServicePrivate(service), 'extractLeadAssistantTextsFromJsonlLines')
      .mockImplementation(async (...args: unknown[]) => {
        const [rawLines, leadName, leadSessionId, maxTexts] = args as [
          readonly string[],
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
        return originalExtract(rawLines, leadName, leadSessionId, maxTexts);
      });
    const extract = (
      service as unknown as {
        extractLeadSessionTextsFromJsonl: (
          jsonlPath: string,
          leadName: string,
          leadSessionId: string,
          maxTexts: number
        ) => Promise<InboxMessage[]>;
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

    const assistantSpy = vi.spyOn(
      teamDataServicePrivate(service),
      'extractLeadAssistantTextsFromJsonlLines'
    );
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

    const assistantSpy = vi.spyOn(
      teamDataServicePrivate(service),
      'extractLeadAssistantTextsFromJsonlLines'
    );
    const extract = (
      service as unknown as {
        extractLeadSessionTextsFromJsonl: (
          jsonlPath: string,
          leadName: string,
          leadSessionId: string,
          maxTexts: number
        ) => Promise<InboxMessage[]>;
      }
    ).extractLeadSessionTextsFromJsonl.bind(service);

    const first = await extract(jsonlPath, 'team-lead', 'lead-1', 150);
    await fs.rm(jsonlPath, { force: true });

    await expect(extract(jsonlPath, 'team-lead', 'lead-1', 150)).rejects.toThrow();

    expect(first).toHaveLength(1);
    expect(assistantSpy).toHaveBeenCalledTimes(1);
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

    const assistantSpy = vi.spyOn(
      teamDataServicePrivate(service),
      'extractLeadAssistantTextsFromJsonlLines'
    );
    const extract = (
      service as unknown as {
        extractLeadSessionTextsFromJsonl: (
          jsonlPath: string,
          leadName: string,
          leadSessionId: string,
          maxTexts: number
        ) => Promise<InboxMessage[]>;
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

    const assistantSpy = vi.spyOn(
      teamDataServicePrivate(service),
      'extractLeadAssistantTextsFromJsonlLines'
    );
    const extract = (
      service as unknown as {
        extractLeadSessionTextsFromJsonl: (
          jsonlPath: string,
          leadName: string,
          leadSessionId: string,
          maxTexts: number
        ) => Promise<InboxMessage[]>;
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
        extractLeadAssistantTextsFromJsonlLines: (
          rawLines: readonly string[],
          leadName: string,
          leadSessionId: string,
          maxTexts: number
        ) => Promise<InboxMessage[]>;
      }
    ).extractLeadAssistantTextsFromJsonlLines.bind(service);
    let shouldFail = true;
    const assistantSpy = vi
      .spyOn(teamDataServicePrivate(service), 'extractLeadAssistantTextsFromJsonlLines')
      .mockImplementation(async (...args: unknown[]) => {
        const [rawLines, leadName, leadSessionId, maxTexts] = args as [
          readonly string[],
          string,
          string,
          number,
        ];
        if (shouldFail) {
          throw new Error('transient parse failure');
        }
        return originalExtract(rawLines, leadName, leadSessionId, maxTexts);
      });
    const extract = (
      service as unknown as {
        extractLeadSessionTextsFromJsonl: (
          jsonlPath: string,
          leadName: string,
          leadSessionId: string,
          maxTexts: number
        ) => Promise<InboxMessage[]>;
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
      teamDataServicePrivate(firstService),
      'extractLeadAssistantTextsFromJsonlLines'
    );
    const secondSpy = vi.spyOn(
      teamDataServicePrivate(secondService),
      'extractLeadAssistantTextsFromJsonlLines'
    );
    const firstExtract = (
      firstService as unknown as {
        extractLeadSessionTextsFromJsonl: (
          jsonlPath: string,
          leadName: string,
          leadSessionId: string,
          maxTexts: number
        ) => Promise<InboxMessage[]>;
      }
    ).extractLeadSessionTextsFromJsonl.bind(firstService);
    const secondExtract = (
      secondService as unknown as {
        extractLeadSessionTextsFromJsonl: (
          jsonlPath: string,
          leadName: string,
          leadSessionId: string,
          maxTexts: number
        ) => Promise<InboxMessage[]>;
      }
    ).extractLeadSessionTextsFromJsonl.bind(secondService);

    await firstExtract(jsonlPath, 'team-lead', 'lead-1', 150);
    await secondExtract(jsonlPath, 'team-lead', 'lead-1', 150);

    expect(firstSpy).toHaveBeenCalledTimes(1);
    expect(secondSpy).toHaveBeenCalledTimes(1);
  });

  it('uses live base context for lead_session messages without full transcript discovery', async () => {
    const service = createLeadSessionCachingService();
    const projectResolver = {
      getLiveBaseContext: vi.fn(() =>
        Promise.resolve({
          projectDir: '/fast-project',
          projectId: 'fast-project',
          config: {
            name: 'My team',
            members: [{ name: 'fast-lead', agentType: 'lead' }],
            leadSessionId: 'lead-1',
          },
        })
      ),
      getContext: vi.fn(() => {
        return Promise.reject(new Error('full transcript discovery should not be used'));
      }),
    };
    (service as unknown as { projectResolver: typeof projectResolver }).projectResolver =
      projectResolver;
    vi.spyOn(teamDataServicePrivate(service), 'getLeadSessionJsonlPaths').mockResolvedValue(
      new Map([['lead-1', '/fast-project/lead-1.jsonl']])
    );
    vi.spyOn(teamDataServicePrivate(service), 'extractLeadSessionTextsFromJsonl').mockResolvedValue(
      [
        {
          from: 'fast-lead',
          text: 'Fast path recovered lead thought from the known lead session.',
          timestamp: '2026-04-18T10:00:00.000Z',
          read: true,
          source: 'lead_session',
          leadSessionId: 'lead-1',
          messageId: 'lead-fast-1',
        },
      ]
    );

    const feed = await service.getMessageFeed('my-team');

    expect(projectResolver.getLiveBaseContext).toHaveBeenCalledWith('my-team');
    expect(projectResolver.getContext).not.toHaveBeenCalled();
    expect(feed.messages.some((message) => message.messageId === 'lead-fast-1')).toBe(true);
  });

  it('falls back to lightweight transcript context when live base context lacks the lead session file', async () => {
    const service = createLeadSessionCachingService();
    const projectResolver = {
      getLiveBaseContext: vi.fn(() =>
        Promise.resolve({
          projectDir: '/stale-project',
          projectId: 'stale-project',
          config: {
            name: 'My team',
            members: [{ name: 'stale-lead', agentType: 'lead' }],
            leadSessionId: 'lead-1',
          },
        })
      ),
      getContext: vi.fn(() =>
        Promise.resolve({
          projectDir: '/actual-project',
          projectId: 'actual-project',
          config: {
            name: 'My team',
            members: [{ name: 'actual-lead', agentType: 'lead' }],
            leadSessionId: 'lead-1',
          },
          sessionIds: ['lead-1'],
        })
      ),
    };
    (service as unknown as { projectResolver: typeof projectResolver }).projectResolver =
      projectResolver;
    vi.spyOn(teamDataServicePrivate(service), 'getLeadSessionJsonlPaths').mockImplementation(
      (...args: unknown[]) => {
        const [projectDir] = args as [string];
        if (projectDir === '/actual-project') {
          return Promise.resolve(new Map([['lead-1', '/actual-project/lead-1.jsonl']]));
        }
        return Promise.resolve(new Map());
      }
    );
    vi.spyOn(teamDataServicePrivate(service), 'extractLeadSessionTextsFromJsonl').mockResolvedValue(
      [
        {
          from: 'actual-lead',
          text: 'Fallback path recovered lead thought from the repaired context.',
          timestamp: '2026-04-18T10:00:00.000Z',
          read: true,
          source: 'lead_session',
          leadSessionId: 'lead-1',
          messageId: 'lead-fallback-1',
        },
      ]
    );

    const feed = await service.getMessageFeed('my-team');

    expect(projectResolver.getLiveBaseContext).toHaveBeenCalledWith('my-team');
    expect(projectResolver.getContext).toHaveBeenCalledWith('my-team', {
      includeTeamSubagentSessionDiscovery: false,
    });
    expect(feed.messages.some((message) => message.messageId === 'lead-fallback-1')).toBe(true);
  });

  it('falls back when the fast context only contains older sessionHistory but not the current lead session', async () => {
    const service = createLeadSessionCachingService({
      leadSessionId: 'lead-current',
      sessionHistory: ['lead-history'],
    });
    const projectResolver = {
      getLiveBaseContext: vi.fn(() =>
        Promise.resolve({
          projectDir: '/history-project',
          projectId: 'history-project',
          config: {
            name: 'My team',
            members: [{ name: 'history-lead', agentType: 'lead' }],
            leadSessionId: 'lead-current',
            sessionHistory: ['lead-history'],
          },
        })
      ),
      getContext: vi.fn(() =>
        Promise.resolve({
          projectDir: '/current-project',
          projectId: 'current-project',
          config: {
            name: 'My team',
            members: [{ name: 'current-lead', agentType: 'lead' }],
            leadSessionId: 'lead-current',
            sessionHistory: ['lead-history'],
          },
          sessionIds: ['lead-current', 'lead-history'],
        })
      ),
    };
    (service as unknown as { projectResolver: typeof projectResolver }).projectResolver =
      projectResolver;
    vi.spyOn(teamDataServicePrivate(service), 'getLeadSessionJsonlPaths').mockImplementation(
      (...args: unknown[]) => {
        const [projectDir] = args as [string];
        if (projectDir === '/current-project') {
          return Promise.resolve(
            new Map([['lead-current', '/current-project/lead-current.jsonl']])
          );
        }
        return Promise.resolve(new Map([['lead-history', '/history-project/lead-history.jsonl']]));
      }
    );
    const extractSpy = vi
      .spyOn(teamDataServicePrivate(service), 'extractLeadSessionTextsFromJsonl')
      .mockResolvedValue([
        {
          from: 'current-lead',
          text: 'Current lead session wins over older session history.',
          timestamp: '2026-04-18T10:00:00.000Z',
          read: true,
          source: 'lead_session',
          leadSessionId: 'lead-current',
          messageId: 'lead-current-1',
        },
      ]);

    const feed = await service.getMessageFeed('my-team');

    expect(projectResolver.getContext).toHaveBeenCalledWith('my-team', {
      includeTeamSubagentSessionDiscovery: false,
    });
    expect(extractSpy).toHaveBeenCalledWith(
      '/current-project/lead-current.jsonl',
      'current-lead',
      'lead-current',
      150
    );
    expect(feed.messages.some((message) => message.messageId === 'lead-current-1')).toBe(true);
  });

  it('refreshes lead jsonl paths when lightweight fallback keeps the same project directory', async () => {
    const service = createLeadSessionCachingService({
      leadSessionId: 'lead-current',
      sessionHistory: ['lead-history'],
    });
    const projectResolver = {
      getLiveBaseContext: vi.fn(() =>
        Promise.resolve({
          projectDir: '/same-project',
          projectId: 'same-project',
          config: {
            name: 'My team',
            members: [{ name: 'history-lead', agentType: 'lead' }],
            leadSessionId: 'lead-current',
            sessionHistory: ['lead-history'],
          },
        })
      ),
      getContext: vi.fn(() =>
        Promise.resolve({
          projectDir: '/same-project',
          projectId: 'same-project',
          config: {
            name: 'My team',
            members: [{ name: 'current-lead', agentType: 'lead' }],
            leadSessionId: 'lead-current',
            sessionHistory: ['lead-history'],
          },
          sessionIds: ['lead-current', 'lead-history'],
        })
      ),
    };
    (service as unknown as { projectResolver: typeof projectResolver }).projectResolver =
      projectResolver;
    const getPathsSpy = vi
      .spyOn(teamDataServicePrivate(service), 'getLeadSessionJsonlPaths')
      .mockResolvedValueOnce(new Map([['lead-history', '/same-project/lead-history.jsonl']]))
      .mockResolvedValueOnce(new Map([['lead-current', '/same-project/lead-current.jsonl']]));
    const extractSpy = vi
      .spyOn(teamDataServicePrivate(service), 'extractLeadSessionTextsFromJsonl')
      .mockResolvedValue([
        {
          from: 'current-lead',
          text: 'Same-directory fallback refreshed the lead session path list.',
          timestamp: '2026-04-18T10:00:00.000Z',
          read: true,
          source: 'lead_session',
          leadSessionId: 'lead-current',
          messageId: 'lead-same-project-1',
        },
      ]);

    const feed = await service.getMessageFeed('my-team');

    expect(projectResolver.getContext).toHaveBeenCalledWith('my-team', {
      includeTeamSubagentSessionDiscovery: false,
    });
    expect(getPathsSpy).toHaveBeenCalledTimes(2);
    expect(extractSpy).toHaveBeenCalledWith(
      '/same-project/lead-current.jsonl',
      'current-lead',
      'lead-current',
      150
    );
    expect(feed.messages.some((message) => message.messageId === 'lead-same-project-1')).toBe(true);
  });

  it('loads durable lead_session messages through the transcript resolver when projectPath is stale', async () => {
    const fixture = await createResolverBackedLeadFixture();
    const service = createResolverBackedService();

    const feed = await service.getMessageFeed(fixture.teamName);
    const persistedConfig = JSON.parse(await fs.readFile(fixture.configPath, 'utf8')) as TeamConfig;

    expect(
      feed.messages.find(
        (message) =>
          message.source === 'lead_session' &&
          message.text.includes('recovered through the transcript resolver')
      )
    ).toBeTruthy();
    expect(persistedConfig.projectPath).toBe(fixture.actualProjectPath);
  });

  it('still returns lead_session messages when projectPath repair persistence fails', async () => {
    const fixture = await createResolverBackedLeadFixture();
    const originalWriteFile = nodeFs.promises.writeFile.bind(nodeFs.promises);
    const teamTmpPrefix = path.join(fixture.claudeRoot, 'teams', fixture.teamName, '.tmp.');

    vi.spyOn(nodeFs.promises, 'writeFile').mockImplementation(
      async (...args: Parameters<typeof nodeFs.promises.writeFile>) => {
        const [targetPath] = args;
        if (typeof targetPath === 'string' && targetPath.startsWith(teamTmpPrefix)) {
          throw new Error('simulated atomic write failure');
        }
        return originalWriteFile(...args);
      }
    );

    const service = createResolverBackedService();
    const page = await service.getMessagesPage(fixture.teamName, { limit: 10 });
    const persistedConfig = JSON.parse(await fs.readFile(fixture.configPath, 'utf8')) as TeamConfig;

    expect(
      page.messages.find(
        (message) =>
          message.source === 'lead_session' &&
          message.text.includes('recovered through the transcript resolver')
      )
    ).toBeTruthy();
    expect(persistedConfig.projectPath).toBe(fixture.staleProjectPath);
  });

  it('does not guess lead_session messages from resolver-discovered session ids when config has no leadSessionId or sessionHistory', async () => {
    const fixture = await createResolverBackedLeadFixture({
      leadSessionId: undefined,
      sessionFileId: 'lead-discovered',
    });
    const service = createResolverBackedService();

    const page = await service.getMessagesPage(fixture.teamName, { limit: 10 });

    expect(page.messages.some((message) => message.source === 'lead_session')).toBe(false);
  });

  it('does not mix resolver-discovered non-lead session ids into durable lead_session messages when config already knows the lead session', async () => {
    const fixture = await createResolverBackedLeadFixture();
    await fs.writeFile(
      path.join(fixture.actualProjectDir, 'member-1.jsonl'),
      `${JSON.stringify({
        teamName: fixture.teamName,
        type: 'assistant',
        timestamp: '2026-04-18T10:05:00.000Z',
        cwd: fixture.actualProjectPath,
        message: {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: 'Member bootstrap noise that should never appear as a lead_session thought in the team activity timeline.',
            },
          ],
        },
      })}\n`,
      'utf8'
    );
    const service = createResolverBackedService();

    const page = await service.getMessagesPage(fixture.teamName, { limit: 20 });
    const leadSessionMessages = page.messages.filter(
      (message) => message.source === 'lead_session'
    );

    expect(
      leadSessionMessages.some((message) =>
        message.text.includes('recovered through the transcript resolver')
      )
    ).toBe(true);
    expect(
      leadSessionMessages.some((message) =>
        message.text.includes('Member bootstrap noise that should never appear')
      )
    ).toBe(false);
    expect(new Set(leadSessionMessages.map((message) => message.leadSessionId))).toEqual(
      new Set(['lead-1'])
    );
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

  it('uses snapshot config reads for UI team data snapshots', async () => {
    const harness = createGetTeamDataHarness();

    await harness.service.getTeamData('my-team');

    expect(harness.getConfigSnapshot).toHaveBeenCalledWith('my-team');
    expect(harness.getConfig).not.toHaveBeenCalled();
  });

  it('compacts heavy task text in UI team data snapshots', async () => {
    const longDescription = 'description '.repeat(500);
    const longPrompt = 'prompt '.repeat(500);
    const longComment = 'comment '.repeat(500);
    const longNote = 'note '.repeat(500);
    const longSourceMessage = 'source '.repeat(500);
    const task: TeamTask = {
      id: 'task-1',
      subject: 'Heavy task',
      status: 'pending',
      description: longDescription,
      prompt: longPrompt,
      comments: [
        {
          id: 'comment-1',
          author: 'alice',
          text: longComment,
          createdAt: '2026-04-09T10:00:00.000Z',
          type: 'regular',
        },
      ],
      historyEvents: [
        {
          id: 'event-1',
          timestamp: '2026-04-09T10:01:00.000Z',
          type: 'review_requested',
          from: 'none',
          to: 'review',
          note: longNote,
        },
      ],
      sourceMessage: {
        text: longSourceMessage,
        from: 'user',
        timestamp: '2026-04-09T09:59:00.000Z',
      },
    };
    const harness = createGetTeamDataHarness({
      getTasks: async () => [task],
    });

    const data = await harness.service.getTeamData('my-team');
    const snapshotTask = data.tasks[0]!;

    expect(snapshotTask.description).toHaveLength(2_000);
    expect(snapshotTask.prompt).toHaveLength(2_000);
    expect(snapshotTask.comments?.[0]?.text).toHaveLength(120);
    expect(snapshotTask.historyEvents?.[0]).toMatchObject({
      type: 'review_requested',
      note: expect.stringMatching(/^note /),
    });
    expect((snapshotTask.historyEvents?.[0] as { note?: string } | undefined)?.note).toHaveLength(
      500
    );
    expect(snapshotTask.sourceMessage?.text).toHaveLength(1_000);
    expect(task.comments?.[0]?.text).toBe(longComment);
  });

  it('returns full task text from the task detail endpoint', async () => {
    const longDescription = 'description '.repeat(500);
    const longComment = 'comment '.repeat(500);
    const fullTask: TeamTask = {
      id: 'task-1',
      subject: 'Heavy task',
      status: 'completed',
      description: longDescription,
      comments: [
        {
          id: 'comment-1',
          author: 'alice',
          text: longComment,
          createdAt: '2026-04-09T10:00:00.000Z',
          type: 'regular',
        },
      ],
    };
    const harness = createGetTeamDataHarness({
      getTask: (taskId) => (taskId === 'task-1' ? fullTask : null),
      getState: async () => ({
        teamName: 'my-team',
        reviewers: ['alice'],
        tasks: {
          'task-1': {
            column: 'review',
            reviewer: 'alice',
            movedAt: '2026-04-09T10:02:00.000Z',
          },
        },
      }),
    });

    const task = await harness.service.getTask('my-team', 'task-1');

    expect(task?.description).toBe(longDescription);
    expect(task?.comments?.[0]?.text).toBe(longComment);
    expect(task).toMatchObject({
      id: 'task-1',
      kanbanColumn: 'review',
      reviewer: 'alice',
    });
    await expect(harness.service.getTask('my-team', 'missing-task')).resolves.toBeNull();
  });

  it('skips member branch enrichment for thin UI team data snapshots', async () => {
    const getBranchSpy = vi.spyOn(gitIdentityResolver, 'getBranch').mockResolvedValue('main');
    const harness = createGetTeamDataHarness({
      config: buildDefaultTeamConfig({
        projectPath: '/repo',
        members: [
          { name: 'team-lead', role: 'Lead', cwd: '/repo' },
          { name: 'alice', role: 'Developer', cwd: '/repo-alice' },
        ],
      }),
      resolveMembers: () => [
        { ...buildResolvedMember('team-lead'), cwd: '/repo' },
        { ...buildResolvedMember('alice'), cwd: '/repo-alice' },
      ],
    });

    const data = await harness.service.getTeamData('my-team', {
      includeMemberBranches: false,
    });

    expect(getBranchSpy).not.toHaveBeenCalled();
    expect(data.members.find((member) => member.name === 'alice')?.gitBranch).toBeUndefined();
  });

  it('keeps member branch enrichment on by default for full UI team data snapshots', async () => {
    const rootRepoPath = path.normalize('/repo');
    const aliceRepoPath = path.normalize('/repo-alice');
    const getBranchSpy = vi
      .spyOn(gitIdentityResolver, 'getBranch')
      .mockImplementation(async (cwd) => (cwd === aliceRepoPath ? 'feature/alice' : 'main'));
    const harness = createGetTeamDataHarness({
      config: buildDefaultTeamConfig({
        projectPath: rootRepoPath,
        members: [
          { name: 'team-lead', role: 'Lead', cwd: rootRepoPath },
          { name: 'alice', role: 'Developer', cwd: aliceRepoPath },
        ],
      }),
      resolveMembers: () => [
        { ...buildResolvedMember('team-lead'), cwd: rootRepoPath },
        { ...buildResolvedMember('alice'), cwd: aliceRepoPath },
      ],
    });

    const data = await harness.service.getTeamData('my-team');

    expect(getBranchSpy).toHaveBeenCalledWith(rootRepoPath);
    expect(getBranchSpy).toHaveBeenCalledWith(aliceRepoPath);
    expect(data.members.find((member) => member.name === 'alice')?.gitBranch).toBe('feature/alice');
  });

  it('keeps member branch enrichment on for explicit full UI team data snapshots', async () => {
    const rootRepoPath = path.normalize('/repo');
    const aliceRepoPath = path.normalize('/repo-alice');
    const getBranchSpy = vi
      .spyOn(gitIdentityResolver, 'getBranch')
      .mockImplementation(async (cwd) => (cwd === aliceRepoPath ? 'feature/alice' : 'main'));
    const harness = createGetTeamDataHarness({
      config: buildDefaultTeamConfig({
        projectPath: rootRepoPath,
        members: [
          { name: 'team-lead', role: 'Lead', cwd: rootRepoPath },
          { name: 'alice', role: 'Developer', cwd: aliceRepoPath },
        ],
      }),
      resolveMembers: () => [
        { ...buildResolvedMember('team-lead'), cwd: rootRepoPath },
        { ...buildResolvedMember('alice'), cwd: aliceRepoPath },
      ],
    });

    const data = await harness.service.getTeamData('my-team', {
      includeMemberBranches: true,
    });

    expect(getBranchSpy).toHaveBeenCalledWith(rootRepoPath);
    expect(getBranchSpy).toHaveBeenCalledWith(aliceRepoPath);
    expect(data.members.find((member) => member.name === 'alice')?.gitBranch).toBe('feature/alice');
  });

  it('uses snapshot config reads for UI message feed snapshots', async () => {
    const harness = createGetTeamDataHarness();

    await harness.service.getMessageFeed('my-team');

    expect(harness.getConfigSnapshot).toHaveBeenCalledWith('my-team');
    expect(harness.getConfig).not.toHaveBeenCalled();
  });

  it('starts light reads immediately, bounds heavy reads, and keeps processes outside the parallel phase', async () => {
    const order: string[] = [];
    const tasksDeferred = createDeferred<TeamTask[]>();

    const harness = createGetTeamDataHarness({
      getTasks: async () => {
        order.push('tasks:start');
        return tasksDeferred.promise;
      },
      listInboxNames: async () => {
        order.push('inboxNames:start');
        return [];
      },
      getMembers: async () => {
        order.push('meta:start');
        return [];
      },
      getState: async () => {
        order.push('kanban:start');
        return { teamName: 'my-team', reviewers: [], tasks: {} };
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

    const pending = harness.service.getTeamData('my-team');
    await flushMicrotasks();

    expect(order).toEqual(
      expect.arrayContaining(['inboxNames:start', 'meta:start', 'kanban:start', 'tasks:start'])
    );
    expect(order).not.toContain('processes:start');
    expect(order).not.toContain('leadTexts:start');

    tasksDeferred.resolve([]);

    const data = await pending;

    expect(data.processes).toEqual([
      expect.objectContaining({
        id: 'proc-1',
        pid: 101,
      }),
    ]);
    expect(order).not.toContain('leadTexts:start');
    expect(order.indexOf('resolveMembers')).toBeLessThan(order.indexOf('processes:start'));
  });

  it('attaches runtime advisories during the same snapshot refresh', async () => {
    const advisory = {
      kind: 'sdk_retrying' as const,
      observedAt: '2026-04-09T10:00:00.000Z',
      retryUntil: '2026-04-09T10:01:00.000Z',
      retryDelayMs: 60_000,
      message: 'capacity retry',
    };
    const harness = createGetTeamDataHarness({
      resolveMembers: () => [buildResolvedMember('alice')],
      getMemberAdvisories: async () => new Map([['alice', advisory]]),
    });

    const data = await harness.service.getTeamData('my-team');

    expect(harness.advisoryService.getMemberAdvisories).toHaveBeenCalledTimes(1);
    expect(data.members).toEqual([
      expect.objectContaining({
        name: 'alice',
        runtimeAdvisory: advisory,
      }),
    ]);
  });

  it('does not block the team snapshot on slow runtime advisories', async () => {
    const deferred = createDeferred<Map<string, unknown>>();
    const harness = createGetTeamDataHarness({
      resolveMembers: () => [buildResolvedMember('alice')],
      getMemberAdvisories: async () => deferred.promise,
    });

    const data = await harness.service.getTeamData('my-team');

    expect(harness.advisoryService.getMemberAdvisories).toHaveBeenCalledTimes(1);
    expect(data.members).toEqual([expect.objectContaining({ name: 'alice' })]);
    expect(data.members[0]?.runtimeAdvisory).toBeUndefined();

    deferred.resolve(new Map());
    await Promise.resolve();
  });

  it('synthesizes a team lead from team meta when config and members meta have no lead entry', async () => {
    const harness = createGetTeamDataHarness({
      config: {
        name: 'My team',
        projectPath: '/repo',
        members: [
          {
            name: 'alice',
            role: 'Reviewer',
            providerId: 'codex',
            model: 'gpt-5.4',
          },
        ],
      },
      getTeamMeta: async () => ({
        version: 1,
        cwd: '/repo',
        providerId: 'codex',
        model: 'gpt-5.4',
        effort: 'medium',
        createdAt: Date.now(),
      }),
      resolveMembers: () => [buildResolvedMember('alice')],
    });

    const data = await harness.service.getTeamData('my-team');

    expect(data.members[0]).toMatchObject({
      name: 'team-lead',
      agentType: 'team-lead',
      role: 'Team Lead',
      providerId: 'codex',
      model: 'gpt-5.4',
      effort: 'medium',
      cwd: '/repo',
    });
    expect(data.members[1]).toMatchObject({
      name: 'alice',
    });
    expect(harness.teamMetaStore.getMeta).toHaveBeenCalledWith('my-team');
  });

  it('surfaces lane-aware member runtime truth alongside the synthesized lead snapshot', async () => {
    const harness = createGetTeamDataHarness({
      config: {
        name: 'My team',
        projectPath: '/repo',
        members: [{ name: 'alice', role: 'Developer', providerId: 'opencode' }],
      },
      getTeamMeta: async () => ({
        version: 1,
        cwd: '/repo',
        providerId: 'codex',
        providerBackendId: 'codex-native',
        model: 'gpt-5.4',
        effort: 'medium',
        fastMode: 'off',
        createdAt: Date.now(),
      }),
      resolveMembers: () => [
        {
          ...buildResolvedMember('alice'),
          providerId: 'opencode',
          providerBackendId: 'opencode-cli',
          model: 'minimax-m2.5-free',
          laneId: 'secondary:opencode:alice',
          laneKind: 'secondary',
          laneOwnerProviderId: 'opencode',
          selectedFastMode: 'inherit',
          resolvedFastMode: false,
        },
      ],
    });

    const data = await harness.service.getTeamData('my-team');

    expect(data.members[0]).toMatchObject({
      name: 'team-lead',
      agentType: 'team-lead',
      providerId: 'codex',
      providerBackendId: 'codex-native',
      model: 'gpt-5.4',
      effort: 'medium',
      cwd: '/repo',
    });
    expect(data.members[1]).toMatchObject({
      name: 'alice',
      providerId: 'opencode',
      providerBackendId: 'opencode-cli',
      model: 'minimax-m2.5-free',
      laneId: 'secondary:opencode:alice',
      laneKind: 'secondary',
      laneOwnerProviderId: 'opencode',
      selectedFastMode: 'inherit',
      resolvedFastMode: false,
    });
  });

  it('does not show stale Codex backend when Anthropic launch identity overrides legacy team meta', async () => {
    const harness = createGetTeamDataHarness({
      config: {
        name: 'My team',
        projectPath: '/repo',
        members: [{ name: 'alice', role: 'Developer' }],
      },
      getTeamMeta: async () => ({
        version: 1,
        cwd: '/repo',
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
      }),
    });

    const data = await harness.service.getTeamData('my-team');

    expect(data.members[0]).toMatchObject({
      name: 'team-lead',
      providerId: 'anthropic',
      model: 'opus[1m]',
      effort: 'low',
    });
    expect(data.members[0].providerBackendId).toBeUndefined();
    const resolverOptions = (
      harness.resolveMembersSpy.mock.calls[0] as unknown[] | undefined
    )?.[4] as { leadProviderId?: string; leadProviderBackendId?: string } | undefined;
    expect(resolverOptions).toMatchObject({ leadProviderId: 'anthropic' });
    expect(resolverOptions?.leadProviderBackendId).toBeUndefined();
  });

  it('degrades advisory lookup failure to warning and still completes the snapshot', async () => {
    const harness = createGetTeamDataHarness({
      resolveMembers: () => [buildResolvedMember('alice')],
      getMemberAdvisories: async () => {
        throw new Error('advisory failed');
      },
    });

    const data = await harness.service.getTeamData('my-team');

    expect(data.members).toEqual([expect.objectContaining({ name: 'alice' })]);
    expect(data.members[0]?.runtimeAdvisory).toBeUndefined();
    expect(data.warnings).toEqual(
      expect.arrayContaining(['Member runtime advisories failed to load'])
    );
  });

  it('surfaces isAlive in the structural snapshot from live process state', async () => {
    const aliveHarness = createGetTeamDataHarness({
      listProcesses: () =>
        [
          {
            id: 'proc-1',
            label: 'Lead',
            pid: 101,
            registeredAt: '2026-04-09T10:00:00.000Z',
          },
        ] satisfies TeamProcess[],
    });
    const offlineHarness = createGetTeamDataHarness({
      listProcesses: () =>
        [
          {
            id: 'proc-1',
            label: 'Lead',
            pid: 101,
            registeredAt: '2026-04-09T10:00:00.000Z',
            stoppedAt: '2026-04-09T10:05:00.000Z',
          },
        ] satisfies TeamProcess[],
    });

    const aliveData = await aliveHarness.service.getTeamData('my-team');
    const offlineData = await offlineHarness.service.getTeamData('my-team');

    expect(aliveData.isAlive).toBe(true);
    expect(offlineData.isAlive).toBe(false);
  });

  it('keeps warning order deterministic even when read failures settle out of order', async () => {
    const tasksDeferred = createDeferred<TeamTask[]>();
    const inboxDeferred = createDeferred<string[]>();
    const metaDeferred = createDeferred<TeamConfig['members']>();
    const kanbanDeferred = createDeferred<KanbanState>();

    const harness = createGetTeamDataHarness({
      getTasks: async () => tasksDeferred.promise,
      listInboxNames: async () => inboxDeferred.promise,
      getMembers: async () => metaDeferred.promise,
      getState: async () => kanbanDeferred.promise,
    });

    const pending = harness.service.getTeamData('my-team');
    await flushMicrotasks();

    kanbanDeferred.reject(new Error('kanban failed'));
    tasksDeferred.reject(new Error('tasks failed'));
    metaDeferred.reject(new Error('meta failed'));
    inboxDeferred.reject(new Error('inbox failed'));

    const data = await pending;

    expect(data.warnings).toEqual([
      'Tasks failed to load',
      'Inboxes failed to load',
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

    vi.spyOn(teamDataServicePrivate(harness.service), 'extractLeadSessionTexts').mockResolvedValue([
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

    const feed = await harness.service.getMessageFeed('my-team');

    expect(feed.messages.map((message) => message.messageId)).toEqual([
      'sent-1',
      'lead-1',
      'inbox-1',
    ]);
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

    vi.spyOn(teamDataServicePrivate(harness.service), 'extractLeadSessionTexts').mockResolvedValue([
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
    const feed = await harness.service.getMessageFeed('my-team');

    expect(data.warnings).toEqual(expect.arrayContaining(['Kanban state failed to load']));
    expect(feed.messages.map((message) => message.messageId)).toEqual(['sent-1', 'lead-1']);
    expect(resolveMembersSpy).toHaveBeenCalledWith(
      buildDefaultTeamConfig(),
      metaMembers,
      inboxNames,
      expect.arrayContaining([
        expect.objectContaining({
          id: 'task-1',
          subject: 'Investigate rollout',
        }),
      ]),
      expect.objectContaining({
        launchSnapshot: null,
        leadProviderId: undefined,
        leadProviderBackendId: undefined,
        leadFastMode: undefined,
        leadResolvedFastMode: undefined,
      })
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
    const harness = createGetTeamDataHarness({
      getTasks: async () => {
        order.push('tasks:start');
        return tasksDeferred.promise;
      },
      listProcesses: () => {
        order.push('processes:start');
        return [];
      },
    });

    vi.spyOn(teamDataServicePrivate(harness.service), 'extractLeadSessionTexts').mockImplementation(
      () => {
        order.push('leadTexts:start');
        throw new Error('lead sync fail');
      }
    );

    const pending = harness.service.getTeamData('my-team');
    await flushMicrotasks();

    expect(order).not.toContain('leadTexts:start');

    tasksDeferred.resolve([]);
    const data = await pending;

    expect(data.warnings ?? []).not.toContain('Lead session texts failed to load');
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

  describe('getMessagesPage', () => {
    function createPaginationService(
      messages: Array<{
        from: string;
        text: string;
        timestamp: string;
        messageId?: string;
        source?: InboxMessage['source'];
        leadSessionId?: string;
      }>
    ) {
      return new TeamDataService(
        {
          listTeams: vi.fn(),
          getConfig: vi.fn(async () => ({
            name: 'My team',
            members: [{ name: 'team-lead', role: 'Lead' }],
            leadSessionId: 'lead-1',
          })),
        } as never,
        { getTasks: vi.fn(async () => []) } as never,
        {
          listInboxNames: vi.fn(async () => []),
          getMessages: vi.fn(async () => messages.map((m) => ({ ...m, read: true }))),
          getMessagesWindow: vi.fn(
            createMockInboxMessagesWindowReader(async () =>
              messages.map((message) => ({ ...message, read: true }))
            )
          ),
        } as never,
        {} as never,
        {} as never,
        { resolveMembers: vi.fn(() => []) } as never,
        {
          getState: vi.fn(async () => ({ teamName: 'my-team', reviewers: [], tasks: {} })),
        } as never,
        {} as never,
        {} as never,
        { readMessages: vi.fn(async () => []) } as never
      );
    }

    it('returns first page with cursor and hasMore', async () => {
      const msgs = Array.from({ length: 5 }, (_, i) => ({
        from: 'alice',
        text: `msg-${i}`,
        timestamp: `2026-01-01T00:00:0${i}.000Z`,
        messageId: `m${i}`,
        source: 'inbox' as const,
      }));
      const service = createPaginationService(msgs);
      const page = await service.getMessagesPage('my-team', { limit: 3 });

      expect(page.messages).toHaveLength(3);
      expect(page.hasMore).toBe(true);
      expect(page.nextCursor).toBeTruthy();
      // Newest first
      expect(page.messages[0].messageId).toBe('m4');
    });

    it('cursor excludes already-seen messages without losing same-timestamp messages', async () => {
      const msgs = [
        { from: 'a', text: '1', timestamp: '2026-01-01T00:00:02.000Z', messageId: 'x1' },
        { from: 'b', text: '2', timestamp: '2026-01-01T00:00:02.000Z', messageId: 'x2' },
        { from: 'c', text: '3', timestamp: '2026-01-01T00:00:01.000Z', messageId: 'x3' },
      ];
      const service = createPaginationService(msgs);
      const page1 = await service.getMessagesPage('my-team', { limit: 1 });
      expect(page1.messages).toHaveLength(1);
      expect(page1.hasMore).toBe(true);

      const page2 = await service.getMessagesPage('my-team', {
        cursor: page1.nextCursor!,
        limit: 10,
      });
      expect(page2.feedRevision).toBe(page1.feedRevision);
      // Should get the remaining 2 messages, not lose the one with same timestamp
      expect(page2.messages.length).toBeGreaterThanOrEqual(1);
      const allIds = [...page1.messages, ...page2.messages].map((m) => m.messageId);
      expect(new Set(allIds).size).toBe(allIds.length); // no duplicates
    });

    it('annotates slash command results in paginated path', async () => {
      const msgs = [
        {
          from: 'user',
          text: '/cost',
          timestamp: '2026-01-01T00:00:00.000Z',
          messageId: 'cmd1',
          source: 'user_sent' as const,
          leadSessionId: 'lead-1',
        },
        {
          from: 'team-lead',
          text: 'Total cost: $1.05',
          timestamp: '2026-01-01T00:00:01.000Z',
          messageId: 'resp1',
          source: 'lead_process' as const,
          leadSessionId: 'lead-1',
        },
      ];
      const service = createPaginationService(msgs);
      const page = await service.getMessagesPage('my-team', { limit: 10 });
      const result = page.messages.find((m) => m.messageId === 'resp1');
      expect(result?.messageKind).toBe('slash_command_result');
    });

    it('normalizes stable effective message ids before pagination and cursoring', async () => {
      const msgs = [
        {
          from: 'alice',
          text: 'same-ts-a',
          timestamp: '2026-01-01T00:00:02.000Z',
          source: 'inbox' as const,
        },
        {
          from: 'bob',
          text: 'same-ts-b',
          timestamp: '2026-01-01T00:00:02.000Z',
          source: 'inbox' as const,
        },
        {
          from: 'carol',
          text: 'older',
          timestamp: '2026-01-01T00:00:01.000Z',
          source: 'inbox' as const,
        },
      ];
      const service = createPaginationService(msgs);

      const page1 = await service.getMessagesPage('my-team', { limit: 1 });
      const page2 = await service.getMessagesPage('my-team', {
        cursor: page1.nextCursor!,
        limit: 10,
      });

      expect(page1.messages[0]?.messageId).toMatch(/^inbox-/);
      expect(page1.nextCursor).toContain(page1.messages[0]!.messageId!);
      expect(page2.messages.every((message) => Boolean(message.messageId))).toBe(true);
      expect(
        new Set([...page1.messages, ...page2.messages].map((message) => message.messageId)).size
      ).toBe(3);
    });

    it('dedups newest-page live overlay against durable lead thoughts that already paged off the first page', async () => {
      const fillerMessages = Array.from({ length: 55 }, (_, index) => ({
        from: 'alice',
        text: `filler-${index}`,
        timestamp: `2026-01-01T00:00:${String(10 + index).padStart(2, '0')}.000Z`,
        messageId: `filler-${index}`,
        source: 'inbox' as const,
      }));
      const durableThought = {
        from: 'team-lead',
        text: 'Hello there',
        timestamp: '2026-01-01T00:00:01.000Z',
        messageId: 'durable-thought',
        source: 'lead_session' as const,
        leadSessionId: 'lead-1',
      };
      const service = createPaginationService([...fillerMessages, durableThought]);

      const page = await service.getMessagesPage('my-team', {
        limit: 50,
        liveMessages: [
          {
            from: 'team-lead',
            text: 'Hello there',
            timestamp: '2026-01-01T00:01:30.000Z',
            read: true,
            source: 'lead_process',
            messageId: 'live-thought',
            leadSessionId: 'lead-1',
          },
        ],
      });

      expect(page.messages).toHaveLength(50);
      expect(page.messages.some((message) => message.messageId === 'live-thought')).toBe(false);
      expect(page.messages.some((message) => message.messageId === 'durable-thought')).toBe(false);
    });

    it('does not skip durable rows when live overlay fills the newest page', async () => {
      const msgs = [
        {
          from: 'alice',
          text: 'durable-newest',
          timestamp: '2026-01-01T00:00:02.000Z',
          messageId: 'durable-2',
          source: 'inbox' as const,
        },
        {
          from: 'alice',
          text: 'durable-older',
          timestamp: '2026-01-01T00:00:01.000Z',
          messageId: 'durable-1',
          source: 'inbox' as const,
        },
      ];
      const service = createPaginationService(msgs);

      const page1 = await service.getMessagesPage('my-team', {
        limit: 1,
        liveMessages: [
          {
            from: 'team-lead',
            text: 'live-thought',
            timestamp: '2026-01-01T00:00:03.000Z',
            read: true,
            source: 'lead_process',
            messageId: 'live-1',
            leadSessionId: 'lead-1',
          },
        ],
      });

      expect(page1.messages.map((message) => message.messageId)).toEqual(['live-1']);
      expect(page1.hasMore).toBe(true);
      expect(page1.nextCursor).toBe('2026-01-01T00:00:03.000Z|live-1');

      const page2 = await service.getMessagesPage('my-team', {
        limit: 10,
        cursor: page1.nextCursor!,
      });

      expect(page2.feedRevision).toBe(page1.feedRevision);
      expect(page2.messages.map((message) => message.messageId)).toEqual([
        'durable-2',
        'durable-1',
      ]);
    });

    it('caps live overlay messages before merging the newest page', async () => {
      const service = createPaginationService([]);
      const liveMessages = Array.from({ length: 205 }, (_, index) => ({
        from: 'team-lead',
        text: `live-${index}`,
        timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
        read: true,
        source: 'lead_process' as const,
        messageId: `live-${index}`,
        leadSessionId: 'lead-1',
      }));

      const page = await service.getMessagesPage('my-team', {
        limit: 250,
        liveMessages,
      });

      expect(page.messages).toHaveLength(200);
      expect(page.messages.map((message) => message.messageId)).toContain('live-204');
      expect(page.messages.map((message) => message.messageId)).toContain('live-5');
      expect(page.messages.map((message) => message.messageId)).not.toContain('live-4');
    });
  });
});
