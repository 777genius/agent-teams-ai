import {
  createReviewDecisionPersistenceFeature,
  type ReviewDecisionPersistenceDependencies,
} from '@features/change-review/main';
import { describe, expect, it, vi } from 'vitest';

import type { FileChangeSummary } from '@shared/types/review';

const REVIEWED_PATH = '/safe/reviewed.ts';

function createHarness() {
  const reviewedFile = {
    filePath: REVIEWED_PATH,
    relativePath: 'reviewed.ts',
    snippets: [],
    linesAdded: 1,
    linesRemoved: 0,
    isNewFile: false,
  } satisfies FileChangeSummary;
  const authorization = {
    roots: [],
    reviewedFiles: new Map([[REVIEWED_PATH, reviewedFile]]),
    resolutionMemberName: 'worker',
  };
  const dependencies = {
    scope: {
      parse: vi.fn((value: unknown) => value as { teamName: string; taskId?: string }),
      resolve: vi.fn(() =>
        Promise.resolve({
          scope: { teamName: 'safe-team', taskId: 'task-1' },
          authorization,
        })
      ),
      normalizeIdentityPath: vi.fn((filePath: string) => filePath),
      validateFilePath: vi.fn(() => Promise.resolve(REVIEWED_PATH)),
      getAuthoritativeFile: vi.fn(() => reviewedFile),
    },
    paths: {
      isAbsoluteNormalized: vi.fn((filePath: string) => filePath.startsWith('/')),
    },
    locks: {
      withLogicalScopeLock: async <T>(
        _teamName: string,
        _scopeKey: string,
        operation: () => Promise<T>
      ): Promise<T> => operation(),
      withPersistenceScopeLock: async <T>(
        _teamName: string,
        _scope: { scopeKey: string; scopeToken: string },
        operation: () => Promise<T>
      ): Promise<T> => operation(),
    },
  } satisfies ReviewDecisionPersistenceDependencies;

  return { dependencies, authorization, reviewedFile };
}

describe('ReviewDecisionPersistenceApplication', () => {
  it('authorizes draft and decision history from the same exact task scope', async () => {
    const harness = createHarness();
    const feature = createReviewDecisionPersistenceFeature(harness.dependencies);

    const draft = await feature.authorizeDraftHistoryScope('safe-team', 'task-task-1');
    expect(harness.dependencies.scope.parse).toHaveBeenCalledWith({
      teamName: 'safe-team',
      taskId: 'task-1',
    });
    expect(harness.dependencies.scope.resolve).toHaveBeenCalledWith(
      { teamName: 'safe-team', taskId: 'task-1' },
      { requireIdentity: true }
    );
    expect(draft.isCurrentReviewedFile(REVIEWED_PATH)).toBe(true);
    expect(draft.isCurrentReviewedFile('relative.ts')).toBe(false);
    await draft.assertCurrentReviewedFile('/renderer/file.ts');
    expect(harness.dependencies.scope.validateFilePath).toHaveBeenCalledWith(
      harness.authorization,
      '/renderer/file.ts',
      { requireReviewedFile: true }
    );

    const decision = await feature.authorizeDecisionHistoryScope('safe-team', 'task-task-1');
    expect(decision.files).toEqual([harness.reviewedFile]);
    expect(decision.normalizePath(REVIEWED_PATH)).toBe(REVIEWED_PATH);
    expect(decision.resolveFile(REVIEWED_PATH)).toBe(harness.reviewedFile);
  });

  it('serializes the same persistence scope while allowing another scope to proceed', async () => {
    const harness = createHarness();
    const feature = createReviewDecisionPersistenceFeature(harness.dependencies);
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const events: string[] = [];
    const first = feature.withLock(
      'safe-team',
      { scopeKey: 'task-a', scopeToken: 'token-a' },
      async () => {
        events.push('first:start');
        await firstGate;
        events.push('first:end');
      }
    );
    const second = feature.withLock(
      'safe-team',
      { scopeKey: 'task-a', scopeToken: 'token-a' },
      () => {
        events.push('second');
        return Promise.resolve();
      }
    );
    const independent = feature.withLock(
      'safe-team',
      { scopeKey: 'task-b', scopeToken: 'token-b' },
      () => {
        events.push('independent');
        return Promise.resolve();
      }
    );

    await vi.waitFor(() => expect(events).toContain('independent'));
    expect(events).not.toContain('second');
    releaseFirst();
    await Promise.all([first, second, independent]);

    expect(events).toEqual(['first:start', 'independent', 'first:end', 'second']);
  });

  it('releases the queue after a rejected operation', async () => {
    const harness = createHarness();
    const feature = createReviewDecisionPersistenceFeature(harness.dependencies);
    const scope = { scopeKey: 'task-a', scopeToken: 'token-a' };

    await expect(
      feature.withLock('safe-team', scope, () => Promise.reject(new Error('write failed')))
    ).rejects.toThrow('write failed');
    await expect(feature.withLock('safe-team', scope, () => Promise.resolve('next'))).resolves.toBe(
      'next'
    );
  });
});
