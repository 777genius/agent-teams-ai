import {
  createReviewQueryFeature,
  type ReviewQueryDependencies,
} from '@features/change-review/main';
import { describe, expect, it, vi } from 'vitest';

import type {
  AgentChangeSet,
  FileChangeWithContent,
  SnippetDiff,
  TaskChangeSetV2,
  TeamTaskChangeSummariesResponse,
} from '@shared/types/review';

const PROJECT_PATH = '/review-query-safe-root';
const REVIEWED_FILE_PATH = `${PROJECT_PATH}/query-reviewed.ts`;
const GIT_FILE_PATH = `${PROJECT_PATH}/file.ts`;

function createDependencies() {
  const agentChanges = { kind: 'agent-changes' } as unknown as AgentChangeSet;
  const taskChanges = { kind: 'task-changes' } as unknown as TaskChangeSetV2;
  const summaries = {
    kind: 'team-task-change-summaries',
  } as unknown as TeamTaskChangeSummariesResponse;
  const stats = { linesAdded: 3, linesRemoved: 2, filesChanged: 1 };
  const content = {
    filePath: REVIEWED_FILE_PATH,
    relativePath: 'query-reviewed.ts',
    snippets: [],
    linesAdded: 1,
    linesRemoved: 1,
    isNewFile: false,
    originalFullContent: 'before\n',
    modifiedFullContent: 'after\n',
    contentSource: 'ledger-exact',
  } satisfies FileChangeWithContent;
  const displayedContent = {
    ...content,
    reviewSnapshotToken: 'snapshot-token',
  } satisfies FileChangeWithContent;
  const authorization = {
    roots: [],
    reviewedFiles: null,
    resolutionMemberName: 'worker',
  };

  const dependencies = {
    changes: {
      getAgentChanges: vi.fn(() => Promise.resolve(agentChanges)),
      getTaskChanges: vi.fn(() => Promise.resolve(taskChanges)),
      getTeamTaskChangeSummaries: vi.fn(() => Promise.resolve(summaries)),
      invalidateTaskChangeSummaries: vi.fn(() => Promise.resolve()),
      getChangeStats: vi.fn(() => Promise.resolve(stats)),
    },
    scope: {
      normalizeIdentity: vi.fn((value: string | undefined) => value?.trim()),
      resolve: vi.fn(() =>
        Promise.resolve({
          scope: { teamName: 'safe-team', memberName: 'worker' },
          authorization,
        })
      ),
      validateFilePath: vi.fn(() => Promise.resolve(REVIEWED_FILE_PATH)),
      validateSnippets: vi.fn(() => Promise.resolve()),
    },
    content: {
      getFileContent: vi.fn(() => Promise.resolve(content)),
    },
    snapshots: {
      register: vi.fn(() => displayedContent),
    },
    gitHistory: {
      getFileLog: vi.fn(() =>
        Promise.resolve([
          { hash: 'abc123', timestamp: '2026-07-24T10:00:00.000Z', message: 'query' },
        ])
      ),
    },
  } satisfies ReviewQueryDependencies;

  return {
    dependencies,
    agentChanges,
    taskChanges,
    summaries,
    stats,
    content,
    displayedContent,
    authorization,
  };
}

describe('ReviewQueryApplication', () => {
  it('delegates change and history queries without altering valid input', async () => {
    const harness = createDependencies();
    const feature = createReviewQueryFeature(harness.dependencies);
    const options = { owner: 'worker', summaryOnly: true };
    const requests = [{ taskId: 'task-1', options }];

    await expect(feature.getAgentChanges('safe-team', 'worker')).resolves.toBe(
      harness.agentChanges
    );
    await expect(feature.getTaskChanges('safe-team', 'task-1', options)).resolves.toBe(
      harness.taskChanges
    );
    await expect(feature.getTeamTaskChangeSummaries('safe-team', requests)).resolves.toBe(
      harness.summaries
    );
    await expect(feature.getChangeStats('safe-team', 'worker')).resolves.toBe(harness.stats);
    await expect(feature.getGitFileLog(PROJECT_PATH, GIT_FILE_PATH)).resolves.toEqual([
      { hash: 'abc123', timestamp: '2026-07-24T10:00:00.000Z', message: 'query' },
    ]);

    expect(harness.dependencies.changes.getAgentChanges).toHaveBeenCalledWith(
      'safe-team',
      'worker'
    );
    expect(harness.dependencies.changes.getTaskChanges).toHaveBeenCalledWith(
      'safe-team',
      'task-1',
      options
    );
    expect(harness.dependencies.changes.getTeamTaskChangeSummaries).toHaveBeenCalledWith(
      'safe-team',
      requests
    );
    expect(harness.dependencies.changes.getChangeStats).toHaveBeenCalledWith('safe-team', 'worker');
    expect(harness.dependencies.gitHistory.getFileLog).toHaveBeenCalledWith(
      PROJECT_PATH,
      GIT_FILE_PATH
    );
  });

  it('preserves the existing string-only invalidation filter', async () => {
    const harness = createDependencies();
    const feature = createReviewQueryFeature(harness.dependencies);

    await feature.invalidateTaskChangeSummaries('safe-team', [
      'task-1',
      17,
      '',
      'task-1',
    ] as unknown as string[]);
    await feature.invalidateTaskChangeSummaries('safe-team', null as unknown as string[]);

    expect(harness.dependencies.changes.invalidateTaskChangeSummaries).toHaveBeenNthCalledWith(
      1,
      'safe-team',
      ['task-1', '', 'task-1']
    );
    expect(harness.dependencies.changes.invalidateTaskChangeSummaries).toHaveBeenNthCalledWith(
      2,
      'safe-team',
      []
    );
  });

  it('authorizes, reads, and snapshot-binds file content in the original order', async () => {
    const harness = createDependencies();
    const events: string[] = [];
    const snippets: SnippetDiff[] = [];
    harness.dependencies.scope.normalizeIdentity.mockImplementation((value) => {
      events.push('normalize');
      return value?.trim();
    });
    harness.dependencies.scope.resolve.mockImplementation(() => {
      events.push('resolve');
      return Promise.resolve({
        scope: { teamName: 'safe-team', memberName: 'worker' },
        authorization: harness.authorization,
      });
    });
    harness.dependencies.scope.validateFilePath.mockImplementation(() => {
      events.push('validate-file');
      return Promise.resolve(REVIEWED_FILE_PATH);
    });
    harness.dependencies.scope.validateSnippets.mockImplementation(() => {
      events.push('validate-snippets');
      return Promise.resolve();
    });
    harness.dependencies.content.getFileContent.mockImplementation(() => {
      events.push('read-content');
      return Promise.resolve(harness.content);
    });
    harness.dependencies.snapshots.register.mockImplementation(() => {
      events.push('bind-snapshot');
      return harness.displayedContent;
    });
    const feature = createReviewQueryFeature(harness.dependencies);

    await expect(
      feature.getFileContent('renderer-team', ' worker ', '/renderer/file.ts', snippets)
    ).resolves.toBe(harness.displayedContent);

    expect(events).toEqual([
      'normalize',
      'resolve',
      'validate-file',
      'validate-snippets',
      'read-content',
      'bind-snapshot',
    ]);
    expect(harness.dependencies.scope.resolve).toHaveBeenCalledWith({
      teamName: 'renderer-team',
      memberName: 'worker',
    });
    expect(harness.dependencies.scope.validateFilePath).toHaveBeenCalledWith(
      harness.authorization,
      '/renderer/file.ts',
      { requireReviewedFile: false }
    );
    expect(harness.dependencies.content.getFileContent).toHaveBeenCalledWith(
      'safe-team',
      'worker',
      REVIEWED_FILE_PATH,
      snippets
    );
    expect(harness.dependencies.snapshots.register).toHaveBeenCalledWith(
      'safe-team',
      REVIEWED_FILE_PATH,
      snippets,
      harness.content
    );
  });

  it('keeps member validation ahead of snippet validation and all dependencies', async () => {
    const harness = createDependencies();
    const feature = createReviewQueryFeature(harness.dependencies);

    await expect(
      feature.getFileContent('safe-team', 42, REVIEWED_FILE_PATH, 'bad')
    ).rejects.toThrow('Invalid memberName');
    expect(harness.dependencies.scope.normalizeIdentity).not.toHaveBeenCalled();
    expect(harness.dependencies.scope.resolve).not.toHaveBeenCalled();
  });
});
