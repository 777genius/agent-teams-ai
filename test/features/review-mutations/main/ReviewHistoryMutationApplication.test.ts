import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { ReviewHistoryMutationApplication } from '@features/review-mutations/main';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  ReviewHistoryMutationDependencies,
  ReviewMutationPathAuthorization,
} from '@features/review-mutations/main';
import type {
  ExecuteReviewMutationRequest,
  FileChangeSummary,
  FileChangeWithContent,
  ReviewUndoAction,
} from '@shared/types/review';

const temporaryRoots: string[] = [];

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function createFile(filePath: string): FileChangeSummary {
  return {
    filePath,
    relativePath: 'fixture.ts',
    snippets: [],
    linesAdded: 1,
    linesRemoved: 1,
    isNewFile: false,
    changeKey: 'fixture-change',
  };
}

function createContent(filePath: string): FileChangeWithContent {
  return {
    ...createFile(filePath),
    originalFullContent: 'rejected\n',
    modifiedFullContent: 'agent\n',
    contentSource: 'ledger-exact',
  };
}

function createAuthorization(file: FileChangeSummary): ReviewMutationPathAuthorization {
  return {
    roots: [],
    reviewedFiles: new Map([[file.filePath, file]]),
    resolutionMemberName: 'worker',
  };
}

function createHarness(file: FileChangeSummary, content = createContent(file.filePath)) {
  const validateFilePath = vi.fn(async (_authorization, filePath: string) => filePath);
  const dependencies: ReviewHistoryMutationDependencies = {
    scope: {
      validateFilePath,
      getAuthoritativeFile: () => file,
      resolveAuthoritativeContent: vi.fn(async () => content),
      parseRenameExpectation: (value) => value as never,
      assertExpectedRename: vi.fn(),
      normalizeIdentityPath: (filePath) => filePath,
    },
    files: {
      readText: (filePath) => readFile(filePath, 'utf8'),
    },
  };
  return {
    application: new ReviewHistoryMutationApplication(dependencies),
    validateFilePath,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe('ReviewHistoryMutationApplication', () => {
  it('binds a new disk action to the authorized current preimage', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'review-history-binding-'));
    temporaryRoots.push(root);
    const filePath = path.join(root, 'fixture.ts');
    await writeFile(filePath, 'current\n', 'utf8');
    const file = createFile(filePath);
    const harness = createHarness(file);
    const action: ReviewUndoAction = {
      id: 'action-1',
      createdAt: '2026-07-24T00:00:00.000Z',
      kind: 'disk',
      descriptor: { intent: 'reject-file', filePath },
      action: {
        snapshot: { filePath, beforeContent: 'renderer-value', afterContent: 'renderer-value' },
      },
    };

    const bound = await harness.application.bindNewHistorySnapshots(
      {
        hunkDecisions: {},
        fileDecisions: { 'fixture-change': 'rejected' },
        reviewActionHistory: [action],
        reviewRedoHistory: [],
      },
      null,
      { teamName: 'safe-team', memberName: 'worker' },
      createAuthorization(file)
    );

    const boundAction = bound.reviewActionHistory[0];
    expect(boundAction?.kind).toBe('disk');
    if (boundAction?.kind !== 'disk') throw new Error('Expected a disk action');
    expect(boundAction.action.snapshot).toMatchObject({
      filePath,
      beforeContent: 'current\n',
      afterContent: 'current\n',
      authoritativeBeforeSha256: hashContent('current\n'),
      file,
      restoreMode: 'content',
    });
    expect(boundAction.action.decisionSnapshot).toEqual({
      hunkDecisions: {},
      fileDecisions: {},
    });
    expect(harness.validateFilePath).toHaveBeenCalledWith(expect.anything(), filePath, {
      requireReviewedFile: true,
      rejectHardlinks: true,
    });
  });

  it('reuses a trusted durable action instead of rebinding renderer bytes', async () => {
    const file = createFile('/sandbox/fixture.ts');
    const harness = createHarness(file);
    const trusted: ReviewUndoAction = {
      id: 'trusted-action',
      createdAt: '2026-07-24T00:00:00.000Z',
      kind: 'hunk',
      action: { filePath: file.filePath, originalIndex: 0 },
    };
    const forged: ReviewUndoAction = {
      ...trusted,
      action: { filePath: '/forged/path.ts', originalIndex: 99 },
    };

    const bound = await harness.application.bindNewHistorySnapshots(
      {
        hunkDecisions: {},
        fileDecisions: {},
        reviewActionHistory: [forged],
        reviewRedoHistory: [],
      },
      {
        hunkDecisions: {},
        fileDecisions: {},
        reviewActionHistory: [trusted],
        reviewRedoHistory: [],
        revision: 3,
      },
      null,
      null
    );

    expect(bound.reviewActionHistory).toEqual([trusted]);
    expect(harness.validateFilePath).not.toHaveBeenCalled();
  });

  it('binds Restore to the exact current disk image after preserving concurrent edits', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'review-history-restore-'));
    temporaryRoots.push(root);
    const filePath = path.join(root, 'fixture.ts');
    const rejectedContent = 'line1\nline2\n';
    const agentContent = 'line1\nagent\nline2\n';
    const observedContent = 'manual\nline1\nline2\n';
    const expectedContent = 'manual\nline1\nagent\nline2\n';
    await writeFile(filePath, observedContent, 'utf8');
    const file = createFile(filePath);
    const harness = createHarness(file, {
      ...createContent(filePath),
      originalFullContent: rejectedContent,
      modifiedFullContent: agentContent,
    });
    const previousAction: ReviewUndoAction = {
      id: 'previous-reject',
      createdAt: '2026-07-24T00:00:00.000Z',
      kind: 'disk',
      action: {
        snapshot: {
          filePath,
          beforeContent: agentContent,
          afterContent: rejectedContent,
          authoritativeBeforeSha256: hashContent(agentContent),
          file,
          restoreMode: 'content',
        },
        decisionSnapshot: { hunkDecisions: {}, fileDecisions: {} },
      },
    };
    const restoreAction: ReviewUndoAction = {
      id: 'restore-action',
      createdAt: '2026-07-24T00:01:00.000Z',
      kind: 'disk',
      descriptor: { intent: 'restore-file', filePath },
      action: {
        snapshot: {
          filePath,
          beforeContent: observedContent,
          afterContent: expectedContent,
          file,
          restoreMode: 'content',
        },
        file,
        decisionSnapshot: {
          hunkDecisions: {},
          fileDecisions: { 'fixture-change': 'rejected' },
        },
      },
    };
    const request: ExecuteReviewMutationRequest = {
      scope: { teamName: 'safe-team', memberName: 'worker' },
      decisionPersistenceScope: { scopeKey: 'agent-worker', scopeToken: 'scope-token' },
      kind: 'restore',
      diskSteps: [],
      persistedState: {
        hunkDecisions: {},
        fileDecisions: { 'fixture-change': 'accepted' },
        reviewActionHistory: [previousAction, restoreAction],
        reviewRedoHistory: [],
      },
      expectedDecisionRevision: 5,
    };

    const bound = await harness.application.bindAuthoritativeForwardMutation(
      request,
      {
        hunkDecisions: {},
        fileDecisions: { 'fixture-change': 'rejected' },
        reviewActionHistory: [previousAction],
        reviewRedoHistory: [],
        revision: 5,
      },
      request.scope,
      createAuthorization(file)
    );

    const boundAction = bound.reviewActionHistory.at(-1);
    expect(boundAction?.kind).toBe('disk');
    if (boundAction?.kind !== 'disk') throw new Error('Expected a disk action');
    expect(boundAction.action.snapshot).toMatchObject({
      filePath,
      beforeContent: observedContent,
      afterContent: expectedContent,
      authoritativeBeforeSha256: hashContent(observedContent),
      restoreMode: 'content',
      restoreConflict: undefined,
    });
  });
});
