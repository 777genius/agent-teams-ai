import {
  createChangeReviewFileDraftCommandPort,
  createChangeReviewFileDraftStatePort,
} from '@features/change-review/renderer';
import { describe, expect, it, vi } from 'vitest';

import type { ChangeReviewFileDraftCommandPort } from '@features/change-review/renderer';
import type { ExecuteReviewMutationRequest, ReviewPersistedStateSnapshot } from '@shared/types';

function createStore() {
  return {
    activeChangeSet: { files: [] },
    editedContents: { '/repo/a.ts': 'manual' },
    reviewExternalChangesByFile: { '/repo/a.ts': { type: 'change' } },
    hunkDecisions: { '/repo/a.ts:0': 'accepted' as const },
    fileDecisions: {},
    hunkContextHashesByFile: {},
    decisionRevision: 4,
    changeSetEpoch: 2,
    applyError: null as string | null,
    updateEditedContent: vi.fn(),
    discardFileEdits: vi.fn(),
    clearReviewFileExternalChange: vi.fn(),
    reloadReviewFileFromDisk: vi.fn(),
    saveEditedFile: vi
      .fn<ChangeReviewFileDraftCommandPort['saveEditedFile']>()
      .mockResolvedValue({ ok: true }),
    quiesceDecisionPersistence: vi.fn().mockResolvedValue(true),
    recordDecisionRevision: vi.fn(),
    fetchFileContent: vi.fn().mockResolvedValue(undefined),
  };
}

const persistedState: ReviewPersistedStateSnapshot = {
  hunkDecisions: {},
  fileDecisions: {},
  hunkContextHashesByFile: {},
  reviewActionHistory: [],
  reviewRedoHistory: [],
};

describe('change-review file draft ports', () => {
  it('maps only the state capabilities owned by file draft orchestration', () => {
    const store = createStore();
    const applyReloadedReviewState = vi.fn();
    const reportError = vi.fn();
    const port = createChangeReviewFileDraftStatePort({
      getStore: () => store,
      applyReloadedReviewState,
      reportError,
    });

    expect(port.getSnapshot()).toMatchObject({
      editedContents: { '/repo/a.ts': 'manual' },
      decisionRevision: 4,
      changeSetEpoch: 2,
    });
    const observedChange = port.readExternalChange('/repo/a.ts');
    if (!observedChange) throw new Error('Expected the fixture external-change event.');
    port.updateEditedContent('/repo/a.ts', 'next');
    port.discardFileEdits('/repo/a.ts');
    expect(port.clearExternalChange('/repo/a.ts', { type: 'change' })).toBe(false);
    expect(port.clearExternalChange('/repo/a.ts', observedChange)).toBe(true);
    port.reloadFileFromDisk('/repo/a.ts');
    port.applyReloadedReviewState(persistedState);
    port.reportError('failed');

    expect(store.updateEditedContent).toHaveBeenCalledWith('/repo/a.ts', 'next');
    expect(store.discardFileEdits).toHaveBeenCalledWith('/repo/a.ts');
    expect(store.clearReviewFileExternalChange).toHaveBeenCalledWith('/repo/a.ts');
    expect(store.reloadReviewFileFromDisk).toHaveBeenCalledWith('/repo/a.ts');
    expect(applyReloadedReviewState).toHaveBeenCalledWith(persistedState);
    expect(reportError).toHaveBeenCalledWith('failed');
  });

  it('does not clear a watcher event that replaced the observed event', () => {
    const store = createStore();
    const port = createChangeReviewFileDraftStatePort({
      getStore: () => store,
      applyReloadedReviewState: vi.fn(),
      reportError: vi.fn(),
    });
    const observedChange = port.readExternalChange('/repo/a.ts');
    if (!observedChange) throw new Error('Expected the fixture external-change event.');
    store.reviewExternalChangesByFile['/repo/a.ts'] = { type: 'change' };

    expect(port.clearExternalChange('/repo/a.ts', observedChange)).toBe(false);
    expect(store.clearReviewFileExternalChange).not.toHaveBeenCalled();
  });

  it('maps Reload to the exact WAL mutation without leaking renderer-only scope fields', async () => {
    const store = createStore();
    const executeMutation = vi
      .fn<
        (request: ExecuteReviewMutationRequest) => Promise<{
          decisionRevision: number;
          diskPostimages: [];
        }>
      >()
      .mockResolvedValue({ decisionRevision: 5, diskPostimages: [] });
    const checkConflict = vi.fn().mockResolvedValue({
      hasConflict: false,
      conflictContent: null,
      currentContent: 'disk',
      originalContent: 'disk',
    });
    const port = createChangeReviewFileDraftCommandPort({
      getStore: () => store,
      getReviewApi: () => ({ executeMutation, checkConflict }),
    });

    await expect(
      port.saveEditedFile('/repo/a.ts', { teamName: 'team', taskId: 'task' }, 'disk-before')
    ).resolves.toEqual({ ok: true });
    await port.commitExternalReload({
      reviewScope: { teamName: 'team', taskId: 'task' },
      persistenceScope: { teamName: 'team', scopeKey: 'task-task', scopeToken: 'token' },
      filePath: '/repo/a.ts',
      persistedState,
      expectedDecisionRevision: 4,
    });
    await port.quiescePersistence({
      teamName: 'team',
      scopeKey: 'task-task',
      scopeToken: 'token',
    });
    port.recordDecisionRevision(
      { teamName: 'team', scopeKey: 'task-task', scopeToken: 'token' },
      5
    );

    expect(executeMutation).toHaveBeenCalledWith({
      scope: { teamName: 'team', taskId: 'task' },
      decisionPersistenceScope: { scopeKey: 'task-task', scopeToken: 'token' },
      kind: 'reload-external',
      externalFilePath: '/repo/a.ts',
      diskSteps: [],
      persistedState,
      expectedDecisionRevision: 4,
    });
    expect(store.quiesceDecisionPersistence).toHaveBeenCalledWith('team', 'task-task', 'token');
    expect(store.recordDecisionRevision).toHaveBeenCalledWith('team', 'task-task', 'token', 5);
    expect(store.saveEditedFile).toHaveBeenCalledWith(
      '/repo/a.ts',
      { teamName: 'team', taskId: 'task' },
      'disk-before'
    );
  });

  it('forwards the operation-owned Save result independently from the global UI error', async () => {
    const store = createStore();
    store.applyError = 'unrelated background error';
    const port = createChangeReviewFileDraftCommandPort({
      getStore: () => store,
      getReviewApi: () => ({
        executeMutation: vi.fn(),
        checkConflict: vi.fn(),
      }),
    });

    await expect(
      port.saveEditedFile('/repo/a.ts', { teamName: 'team', taskId: 'task' }, 'disk')
    ).resolves.toEqual({ ok: true });

    store.applyError = null;
    store.saveEditedFile.mockResolvedValueOnce({
      ok: false,
      error: 'disk changed again',
    });
    await expect(
      port.saveEditedFile('/repo/a.ts', { teamName: 'team', taskId: 'task' }, 'disk')
    ).resolves.toEqual({ ok: false, error: 'disk changed again' });
  });
});
