import {
  createChangeReviewFileDecisionCommandPort,
  createChangeReviewFileDecisionStatePort,
} from '@features/change-review/renderer';
import { describe, expect, it, vi } from 'vitest';

import type {
  ExecuteReviewMutationRequest,
  FileChangeSummary,
  ReviewDecisionSnapshot,
} from '@shared/types';

function createStore() {
  return {
    fileContents: {},
    reviewExternalChangesByFile: {},
    hunkDecisions: {},
    fileDecisions: {},
    hunkContextHashesByFile: {},
    fileChunkCounts: {},
    decisionRevision: 1,
    changeSetEpoch: 2,
    acceptAllFile: vi.fn(() => true),
    rejectAllFile: vi.fn(),
    clearReviewFileExternalChange: vi.fn(),
    invalidateResolvedFileContent: vi.fn(),
    applySingleFileDecision: vi.fn().mockResolvedValue(null),
    quiesceDecisionPersistence: vi.fn().mockResolvedValue(true),
    recordDecisionRevision: vi.fn(),
    fetchFileContent: vi.fn().mockResolvedValue(undefined),
  };
}

const file: FileChangeSummary = {
  filePath: '/repo/file.ts',
  relativePath: 'file.ts',
  snippets: [],
  linesAdded: 1,
  linesRemoved: 0,
  isNewFile: false,
};

describe('change-review file decision ports', () => {
  it('maps only the state capabilities required by the controller', () => {
    const store = createStore();
    const applyRestoredDecisionState = vi.fn<(candidate: FileChangeSummary) => void>();
    const restoreFileDecisions =
      vi.fn<(candidate: FileChangeSummary, snapshot: ReviewDecisionSnapshot) => void>();
    const reportError = vi.fn<(message: string | null) => void>();
    const port = createChangeReviewFileDecisionStatePort({
      getStore: () => store,
      applyRestoredDecisionState,
      restoreFileDecisions,
      reportError,
    });
    const snapshot = { hunkDecisions: {}, fileDecisions: {} };

    expect(port.acceptAllFile(file.filePath)).toBe(true);
    expect(port.getSnapshot()).not.toHaveProperty('acceptAllFile');
    port.rejectAllFile(file.filePath);
    port.applyRestoredDecisionState(file);
    port.restoreFileDecisions(file, snapshot);
    port.clearExternalChange(file.filePath);
    port.invalidateResolvedFileContent(file.filePath);
    port.reportError('failed');

    expect(store.acceptAllFile).toHaveBeenCalledWith(file.filePath);
    expect(store.rejectAllFile).toHaveBeenCalledWith(file.filePath);
    expect(applyRestoredDecisionState).toHaveBeenCalledWith(file);
    expect(restoreFileDecisions).toHaveBeenCalledWith(file, snapshot);
    expect(store.clearReviewFileExternalChange).toHaveBeenCalledWith(file.filePath);
    expect(store.invalidateResolvedFileContent).toHaveBeenCalledWith(file.filePath);
    expect(reportError).toHaveBeenCalledWith('failed');
  });

  it('maps durable commands without exposing the store or Review API', async () => {
    const store = createStore();
    const checkConflict = vi.fn().mockResolvedValue({
      hasConflict: false,
      conflictContent: null,
      originalContent: 'expected',
      currentContent: 'disk',
    });
    const executeMutation = vi.fn().mockResolvedValue({
      decisionRevision: 3,
      diskPostimages: [],
    });
    const readCurrentDiskContent = vi.fn().mockResolvedValue('disk');
    const port = createChangeReviewFileDecisionCommandPort({
      getStore: () => store,
      getReviewApi: () => ({ checkConflict, executeMutation }),
      readCurrentDiskContent,
    });
    const scope = { teamName: 'team', taskId: 'task' };
    const persistenceScope = { teamName: 'team', scopeKey: 'task', scopeToken: 'token' };
    const request = {
      scope,
      decisionPersistenceScope: persistenceScope,
      kind: 'restore',
      diskSteps: [],
      persistedState: {
        hunkDecisions: {},
        fileDecisions: {},
        hunkContextHashesByFile: {},
        reviewActionHistory: [],
        reviewRedoHistory: [],
      },
      expectedDecisionRevision: 1,
    } satisfies ExecuteReviewMutationRequest;

    await port.checkConflict(scope, file.filePath, 'expected');
    await port.executeMutation(request);
    await port.applySingleFileDecision('team', file.filePath, 'task', undefined);
    await expect(port.quiescePersistence(persistenceScope)).resolves.toBe(true);
    port.recordDecisionRevision(persistenceScope, 3);
    port.fetchFileContent('team', undefined, file.filePath);
    await expect(port.readCurrentDiskContent(file.filePath, 'fallback')).resolves.toBe('disk');

    expect(checkConflict).toHaveBeenCalledWith(scope, file.filePath, 'expected');
    expect(executeMutation).toHaveBeenCalledWith(request);
    expect(store.applySingleFileDecision).toHaveBeenCalledWith(
      'team',
      file.filePath,
      'task',
      undefined
    );
    expect(store.quiesceDecisionPersistence).toHaveBeenCalledWith('team', 'task', 'token');
    expect(store.recordDecisionRevision).toHaveBeenCalledWith('team', 'task', 'token', 3);
    expect(store.fetchFileContent).toHaveBeenCalledWith('team', undefined, file.filePath);
  });
});
