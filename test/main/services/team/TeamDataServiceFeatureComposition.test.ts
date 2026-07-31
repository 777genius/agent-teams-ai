import { TeamDataServiceFeatureComposition } from '@main/services/team/TeamDataServiceFeatureComposition';
import { describe, expect, it, vi } from 'vitest';

function createCompositionHarness() {
  const task = {
    id: 'task-1',
    displayId: 'task0001',
    subject: 'Keep mutable collaborators late-bound',
    status: 'pending',
  };
  const board = {
    getTask: vi.fn(() => task),
    listTasks: vi.fn(() => [task]),
    listDeletedTasks: vi.fn(() => []),
    createTask: vi.fn(() => task),
    startTask: vi.fn(),
  };
  const initialCommandFacade = {
    createTask: vi.fn(async () => ({
      task,
      outcome: 'executed',
      createdInAttempt: true,
    })),
  };
  const initialAdvisoryService = {
    getMemberAdvisories: vi.fn(async () => new Map()),
  };
  let commandFacade = initialCommandFacade;
  let advisoryService = initialAdvisoryService;

  const composition = new TeamDataServiceFeatureComposition({
    configReader: {},
    taskReader: {
      getTasks: vi.fn(async () => []),
    },
    inboxReader: {
      listInboxNames: vi.fn(async () => []),
      getMessages: vi.fn(async () => []),
      getMessagesFor: vi.fn(async () => []),
    },
    inboxWriter: {
      sendMessage: vi.fn(async () => ({
        deliveredToInbox: true,
        messageId: 'message-1',
      })),
    },
    memberResolver: {
      resolveMembers: vi.fn(() => [
        {
          name: 'team-lead',
          agentType: 'team-lead',
          role: 'Lead',
          status: 'unknown',
          currentTaskId: null,
          taskCount: 0,
          lastActiveAt: null,
          messageCount: 0,
        },
      ]),
    },
    kanbanManager: {
      getState: vi.fn(async () => ({
        teamName: 'my-team',
        reviewers: [],
        tasks: {},
      })),
    },
    membersMetaStore: {
      getMembers: vi.fn(async () => []),
    },
    sentMessagesStore: {
      readMessages: vi.fn(async () => []),
    },
    taskCommentNotificationJournal: {},
    teamMetaStore: {
      getMeta: vi.fn(async () => null),
    },
    projectResolver: {},
    memberBranchConcurrency: 1,
    getTaskBoard: vi.fn(() => board),
    getTaskBoardCommandFacade: () => commandFacade,
    getMemberRuntimeAdvisoryService: () => advisoryService,
    reconcileArtifacts: vi.fn(),
    controllerSendMessage: vi.fn(),
    controllerAppendSentMessage: vi.fn(),
    readSnapshotConfig: vi.fn(async () => ({
      name: 'My team',
      members: [{ name: 'team-lead', agentType: 'team-lead', role: 'Lead' }],
      leadSessionId: 'lead-session-1',
    })),
    readLaunchSnapshot: vi.fn(async () => null),
    readProcesses: vi.fn(async () => []),
    listTeams: vi.fn(async () => []),
    sendMessage: vi.fn(async () => ({
      deliveredToInbox: true,
      messageId: 'message-1',
    })),
    sendRuntimeRecipientMessage: vi.fn(async () => ({
      deliveredToInbox: true,
      messageId: 'message-1',
    })),
    invalidateMessageFeed: vi.fn(),
    invalidateGlobalTaskProjectionCache: vi.fn(),
    createMessageId: vi.fn(() => 'message-1'),
    nowMs: vi.fn(() => 1_780_000_000_000),
    nowIso: vi.fn(() => '2026-05-27T00:00:00.000Z'),
    resolveGitBranch: vi.fn(async () => null),
    selectCurrentActiveTask: vi.fn(() => null),
    compactTask: vi.fn((value) => value),
    logDebug: vi.fn(),
    logWarning: vi.fn(),
  } as never);

  return {
    composition,
    initialAdvisoryService,
    initialCommandFacade,
    replaceAdvisoryService: (replacement: typeof initialAdvisoryService) => {
      advisoryService = replacement;
    },
    replaceCommandFacade: (replacement: typeof initialCommandFacade) => {
      commandFacade = replacement;
    },
    task,
  };
}

describe('TeamDataServiceFeatureComposition', () => {
  it('resolves the task-board command facade when a durable command runs', async () => {
    const harness = createCompositionHarness();
    const replacement = {
      createTask: vi.fn(async () => ({
        task: harness.task,
        outcome: 'replayed',
        createdInAttempt: false,
      })),
    };
    harness.replaceCommandFacade(replacement);

    await harness.composition.taskStartCoordinator.createTask('my-team', {
      command: {
        commandId: '11111111-1111-4111-8111-111111111111',
        idempotencyKey: 'late-bound-command-facade',
      },
      subject: harness.task.subject,
    });

    expect(harness.initialCommandFacade.createTask).not.toHaveBeenCalled();
    expect(replacement.createTask).toHaveBeenCalledOnce();
  });

  it('resolves the member runtime advisory service during each snapshot read', async () => {
    const harness = createCompositionHarness();
    const replacement = {
      getMemberAdvisories: vi.fn(async () => new Map()),
    };
    harness.replaceAdvisoryService(replacement);

    await harness.composition.viewReadModelService.getTeamData('my-team', {
      includeMemberBranches: false,
    });

    expect(harness.initialAdvisoryService.getMemberAdvisories).not.toHaveBeenCalled();
    expect(replacement.getMemberAdvisories).toHaveBeenCalledWith(
      'my-team',
      [expect.objectContaining({ name: 'team-lead' })],
      { observedAfterMs: null }
    );
  });
});
