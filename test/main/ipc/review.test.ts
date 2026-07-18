import {
  initializeReviewHandlers,
  registerReviewHandlers,
  removeReviewHandlers,
} from '@main/ipc/review';
import { ReviewDecisionStore } from '@main/services/team/ReviewDecisionStore';
import {
  REVIEW_APPLY_DECISIONS,
  REVIEW_CHECK_CONFLICT,
  REVIEW_CLEAR_DECISIONS,
  REVIEW_CLEAR_DRAFT_HISTORY,
  REVIEW_DELETE_EDITED_FILE,
  REVIEW_EXECUTE_MUTATION,
  REVIEW_GET_FILE_CONTENT,
  REVIEW_LOAD_DECISIONS,
  REVIEW_LOAD_DRAFT_HISTORY,
  REVIEW_REJECT_FILE,
  REVIEW_REJECT_HUNKS,
  REVIEW_RESTORE_REJECTED_RENAME,
  REVIEW_SAVE_DECISIONS,
  REVIEW_SAVE_DRAFT_HISTORY_ENTRY,
  REVIEW_SAVE_EDITED_FILE,
} from '@preload/constants/ipcChannels';
import { createHash } from 'crypto';
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IpcResult } from '@shared/types/ipc';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

let decisionTeamsBasePath: string;

vi.mock('@main/utils/pathDecoder', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@main/utils/pathDecoder')>()),
  getTeamsBasePath: () => decisionTeamsBasePath,
}));

vi.mock('@shared/utils/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }),
}));

type ReviewHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

function createMockIpcMain(): IpcMain & {
  invoke: (channel: string, ...args: unknown[]) => Promise<IpcResult<unknown>>;
} {
  const handlers = new Map<string, ReviewHandler>();
  return {
    handle: vi.fn((channel: string, handler: ReviewHandler) => handlers.set(channel, handler)),
    removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
    invoke: async (channel: string, ...args: unknown[]) => {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`No handler for ${channel}`);
      return (await handler({} as IpcMainInvokeEvent, ...args)) as IpcResult<unknown>;
    },
  } as unknown as IpcMain & {
    invoke: (channel: string, ...args: unknown[]) => Promise<IpcResult<unknown>>;
  };
}

describe('review IPC path confinement', () => {
  let tmpDir: string;
  let projectDir: string;
  let worktreeDir: string;
  let outsideDir: string;
  let projectFile: string;
  let worktreeFile: string;
  let outsideFile: string;
  let ipcMain: ReturnType<typeof createMockIpcMain>;
  let extractor: {
    getTaskChanges: ReturnType<typeof vi.fn>;
    getAgentChanges: ReturnType<typeof vi.fn>;
  };
  let applier: {
    checkConflict: ReturnType<typeof vi.fn>;
    rejectHunks: ReturnType<typeof vi.fn>;
    rejectFile: ReturnType<typeof vi.fn>;
    applyReviewDecisions: ReturnType<typeof vi.fn>;
    saveEditedFile: ReturnType<typeof vi.fn>;
    deleteEditedFile: ReturnType<typeof vi.fn>;
    restoreRejectedRename: ReturnType<typeof vi.fn>;
    reapplyRejectedRename: ReturnType<typeof vi.fn>;
    classifyEditedFileTransition: ReturnType<typeof vi.fn>;
    classifyRejectedRenameTransition: ReturnType<typeof vi.fn>;
  };
  let resolver: {
    getFileContent: ReturnType<typeof vi.fn>;
    invalidateFile: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'review-ipc-test-'));
    decisionTeamsBasePath = path.join(tmpDir, 'teams');
    projectDir = path.join(tmpDir, 'project');
    worktreeDir = path.join(tmpDir, 'worktree');
    outsideDir = path.join(tmpDir, 'outside');
    projectFile = path.join(projectDir, 'src', 'project.ts');
    worktreeFile = path.join(worktreeDir, 'src', 'worktree.ts');
    outsideFile = path.join(outsideDir, 'outside.ts');
    await Promise.all([
      mkdir(path.dirname(projectFile), { recursive: true }),
      mkdir(path.dirname(worktreeFile), { recursive: true }),
      mkdir(outsideDir, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(projectFile, 'project\n', 'utf8'),
      writeFile(worktreeFile, 'worktree\n', 'utf8'),
      writeFile(outsideFile, 'outside\n', 'utf8'),
    ]);

    extractor = {
      getTaskChanges: vi.fn().mockResolvedValue({
        files: [
          {
            filePath: projectFile,
            relativePath: 'src/project.ts',
            snippets: [],
            linesAdded: 1,
            linesRemoved: 1,
            isNewFile: false,
          },
        ],
        scope: { memberName: 'worker' },
      }),
      getAgentChanges: vi.fn().mockResolvedValue({
        files: [
          {
            filePath: projectFile,
            relativePath: 'src/project.ts',
            snippets: [],
            linesAdded: 1,
            linesRemoved: 1,
            isNewFile: false,
          },
          {
            filePath: path.join(projectDir, 'src', 'missing.ts'),
            relativePath: 'src/missing.ts',
            snippets: [],
            linesAdded: 1,
            linesRemoved: 0,
            isNewFile: true,
          },
        ],
      }),
    };
    let renameTransitionState: 'accepted' | 'rejected' = 'rejected';
    applier = {
      checkConflict: vi.fn().mockResolvedValue({ hasConflict: false }),
      rejectHunks: vi.fn().mockResolvedValue({ success: true }),
      rejectFile: vi.fn().mockResolvedValue({ success: true }),
      applyReviewDecisions: vi
        .fn()
        .mockResolvedValue({ applied: 1, skipped: 0, conflicts: 0, errors: [] }),
      saveEditedFile: vi.fn().mockImplementation(async (filePath, content, expectedCurrent) => {
        if (expectedCurrent === 'different\n') {
          throw new Error('File changed since review update; refusing to overwrite');
        }
        await writeFile(filePath, content, 'utf8');
        return { success: true };
      }),
      deleteEditedFile: vi.fn().mockImplementation(async (filePath) => {
        await rm(filePath, { force: true });
        return { success: true };
      }),
      restoreRejectedRename: vi.fn().mockImplementation(async () => {
        renameTransitionState = 'accepted';
        return { success: true };
      }),
      reapplyRejectedRename: vi.fn().mockImplementation(async () => {
        renameTransitionState = 'rejected';
        return { success: true };
      }),
      classifyEditedFileTransition: vi
        .fn()
        .mockImplementation(async (filePath, beforeContent, afterContent) => {
          let current: string | null;
          try {
            current = await readFile(filePath, 'utf8');
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'ENOENT' || code === 'ENOTDIR') current = null;
            else throw error;
          }
          const beforeMatches = current === beforeContent;
          const afterMatches = current === afterContent;
          if (beforeMatches && afterMatches) return 'both';
          if (beforeMatches) return 'before';
          if (afterMatches) return 'after';
          throw new Error('File changed since review update; durable mutation state is ambiguous');
        }),
      classifyRejectedRenameTransition: vi
        .fn()
        .mockImplementation(async () => renameTransitionState),
    };
    resolver = {
      getFileContent: vi
        .fn()
        .mockImplementation(
          async (
            _teamName: string,
            _memberName: string,
            filePath: string,
            snippets: unknown[]
          ) => ({
            filePath,
            relativePath: path.basename(filePath),
            snippets,
            linesAdded: 0,
            linesRemoved: 0,
            isNewFile: false,
            originalFullContent: 'before\n',
            modifiedFullContent: 'after\n',
            contentSource: 'ledger-exact',
          })
        ),
      invalidateFile: vi.fn(),
    };
    initializeReviewHandlers({
      extractor: extractor as never,
      applier: applier as never,
      contentResolver: resolver as never,
      configReader: {
        getConfig: vi.fn().mockResolvedValue({
          name: 'safe-team',
          projectPath: projectDir,
          members: [{ name: 'worker', cwd: worktreeDir }],
        }),
      },
    });
    ipcMain = createMockIpcMain();
    registerReviewHandlers(ipcMain);
  });

  afterEach(async () => {
    removeReviewHandlers(ipcMain);
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function getDisplayedSnapshotToken(
    filePath: string,
    snippets: unknown[] = []
  ): Promise<string> {
    const result = await ipcMain.invoke(
      REVIEW_GET_FILE_CONTENT,
      'safe-team',
      'worker',
      filePath,
      snippets
    );
    if (!result.success) throw new Error(result.error);
    const token = (result.data as { reviewSnapshotToken?: string }).reviewSnapshotToken;
    if (!token) throw new Error('Review snapshot token was not returned');
    return token;
  }

  it('rejects path traversal in persisted review decision identities', async () => {
    const result = await ipcMain.invoke(
      REVIEW_SAVE_DECISIONS,
      '../outside',
      'task-123',
      'scope-token',
      {},
      {},
      null,
      [],
      0
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('Invalid review');
    }
  });

  it('round-trips ordered review Undo history with the exact decision scope', async () => {
    const action = {
      id: 'accept-hunk-1',
      createdAt: '2026-07-17T12:00:00.000Z',
      kind: 'hunk' as const,
      action: { filePath: projectFile, originalIndex: 0 },
    };
    const saved = await ipcMain.invoke(
      REVIEW_SAVE_DECISIONS,
      'safe-team',
      'agent-worker',
      'agent:worker:content:history',
      { [`${projectFile}:0`]: 'accepted' },
      {},
      null,
      [action],
      0
    );
    expect(saved).toEqual({ success: true, data: { revision: 1 } });

    const loaded = await ipcMain.invoke(
      REVIEW_LOAD_DECISIONS,
      'safe-team',
      'agent-worker',
      'agent:worker:content:history'
    );
    expect(loaded).toEqual({
      success: true,
      data: {
        hunkDecisions: { [`${projectFile}:0`]: 'accepted' },
        fileDecisions: {},
        hunkContextHashesByFile: undefined,
        reviewActionHistory: [action],
        reviewRedoHistory: [],
        revision: 1,
      },
    });
  });

  it('persists and clears exact-scope manual editor history through IPC', async () => {
    const entry = {
      filePath: projectFile,
      codec: 'codemirror-history-v1' as const,
      revision: 1,
      diskBaseline: 'project\n',
      editorState: {
        doc: 'project edited\n',
        selection: { ranges: [{ anchor: 15, head: 15 }], main: 0 },
        history: { done: [{ changes: ['edit'] }], undone: [] },
      },
    };
    const saved = await ipcMain.invoke(
      REVIEW_SAVE_DRAFT_HISTORY_ENTRY,
      'safe-team',
      'agent-worker',
      'scope-token-a',
      entry
    );
    expect(saved).toMatchObject({
      success: true,
      data: { ...entry, updatedAt: expect.any(String) },
    });

    const loaded = await ipcMain.invoke(
      REVIEW_LOAD_DRAFT_HISTORY,
      'safe-team',
      'agent-worker',
      'scope-token-a'
    );
    expect(loaded).toMatchObject({
      success: true,
      data: { entries: { [projectFile]: { ...entry } } },
    });
    const sibling = await ipcMain.invoke(
      REVIEW_LOAD_DRAFT_HISTORY,
      'safe-team',
      'agent-worker',
      'scope-token-b'
    );
    expect(sibling).toEqual({ success: true, data: null });

    const invalidClear = await ipcMain.invoke(
      REVIEW_CLEAR_DRAFT_HISTORY,
      'safe-team',
      'agent-worker',
      'scope-token-a',
      ''
    );
    expect(invalidClear.success).toBe(false);
    await expect(
      ipcMain.invoke(REVIEW_LOAD_DRAFT_HISTORY, 'safe-team', 'agent-worker', 'scope-token-a')
    ).resolves.toMatchObject({ success: true, data: { entries: { [projectFile]: entry } } });

    const cleared = await ipcMain.invoke(
      REVIEW_CLEAR_DRAFT_HISTORY,
      'safe-team',
      'agent-worker',
      'scope-token-a',
      projectFile
    );
    expect(cleared).toEqual({ success: true, data: undefined });
    await expect(
      ipcMain.invoke(REVIEW_LOAD_DRAFT_HISTORY, 'safe-team', 'agent-worker', 'scope-token-a')
    ).resolves.toEqual({ success: true, data: null });
  });

  it('replays and completes a prepared review mutation before hydrating decisions', async () => {
    const { ReviewMutationJournalStore } =
      await import('@main/services/team/ReviewMutationJournalStore');
    const journal = new ReviewMutationJournalStore();
    const persistenceScope = {
      scopeKey: 'agent-worker',
      scopeToken: 'agent:worker:content:recovery-test',
    };
    await journal.prepare({
      teamName: 'safe-team',
      persistenceScope,
      reviewScope: { teamName: 'safe-team', memberName: 'worker' },
      kind: 'reject',
      decisions: [
        {
          filePath: projectFile,
          reviewKey: 'stable-change-key',
          fileDecision: 'pending',
          hunkDecisions: { 0: 'rejected' },
          hunkContextHashes: { 0: 'context-hash' },
        },
      ],
      fileContents: [
        {
          filePath: projectFile,
          relativePath: 'project.ts',
          snippets: [],
          linesAdded: 1,
          linesRemoved: 1,
          isNewFile: false,
          originalFullContent: 'before\n',
          modifiedFullContent: 'after\n',
          contentSource: 'ledger-exact',
        },
      ],
    });
    applier.applyReviewDecisions.mockClear();

    const recovered = await ipcMain.invoke(
      REVIEW_LOAD_DECISIONS,
      'safe-team',
      persistenceScope.scopeKey,
      persistenceScope.scopeToken
    );

    expect(recovered).toEqual({
      success: true,
      data: {
        hunkDecisions: { 'stable-change-key:0': 'rejected' },
        fileDecisions: {},
        hunkContextHashesByFile: { 'stable-change-key': { 0: 'context-hash' } },
        reviewActionHistory: [],
        reviewRedoHistory: [],
        revision: 1,
      },
    });
    expect(applier.applyReviewDecisions).toHaveBeenCalledTimes(1);
    await expect(journal.list('safe-team', persistenceScope)).resolves.toEqual([]);

    const saved = await ipcMain.invoke(
      REVIEW_SAVE_DECISIONS,
      'safe-team',
      persistenceScope.scopeKey,
      persistenceScope.scopeToken,
      { 'stable-change-key:0': 'rejected' },
      {},
      { 'stable-change-key': { 0: 'context-hash' } },
      [],
      1
    );
    expect(saved).toEqual({ success: true, data: { revision: 2 } });
    await expect(journal.list('safe-team', persistenceScope)).resolves.toEqual([]);
  });

  it('explicitly discards a failed mutation journal with the exact saved-decision scope', async () => {
    const { ReviewMutationJournalStore } =
      await import('@main/services/team/ReviewMutationJournalStore');
    const journal = new ReviewMutationJournalStore();
    const persistenceScope = {
      scopeKey: 'agent-worker',
      scopeToken: 'agent:worker:content:failed-recovery',
    };
    const prepared = await journal.prepare({
      teamName: 'safe-team',
      persistenceScope,
      reviewScope: { teamName: 'safe-team', memberName: 'worker' },
      kind: 'reject',
      decisions: [
        {
          filePath: projectFile,
          reviewKey: projectFile,
          fileDecision: 'rejected',
          hunkDecisions: { 0: 'rejected' },
        },
      ],
      fileContents: [
        {
          filePath: projectFile,
          relativePath: 'project.ts',
          snippets: [],
          linesAdded: 1,
          linesRemoved: 1,
          isNewFile: false,
          originalFullContent: 'before\n',
          modifiedFullContent: 'after\n',
          contentSource: 'ledger-exact',
        },
      ],
    });
    await journal.markFailed(prepared, new Error('write failed'));

    const load = await ipcMain.invoke(
      REVIEW_LOAD_DECISIONS,
      'safe-team',
      persistenceScope.scopeKey,
      persistenceScope.scopeToken
    );
    expect(load.success).toBe(false);

    const clear = await ipcMain.invoke(
      REVIEW_CLEAR_DECISIONS,
      'safe-team',
      persistenceScope.scopeKey,
      persistenceScope.scopeToken
    );
    expect(clear).toEqual({ success: true, data: { revision: 0 } });
    await expect(journal.list('safe-team', persistenceScope)).resolves.toEqual([]);
  });

  it('commits disk Undo and Redo after JSON strips optional action fields', async () => {
    const persistenceScope = {
      scopeKey: 'agent-worker',
      scopeToken: 'agent:worker:content:undo-transaction',
    };
    const action = {
      id: 'disk-action-1',
      createdAt: '2026-07-17T12:00:00.000Z',
      kind: 'disk' as const,
      action: {
        snapshot: {
          filePath: projectFile,
          beforeContent: 'restored\n',
          afterContent: 'project\n',
          authoritativeBeforeSha256: createHash('sha256').update('restored\n').digest('hex'),
          restoreMode: undefined,
          renameExpectation: undefined,
          fileIndex: undefined,
        },
        originalIndex: 0,
      },
    };
    const redoAction = {
      action,
      decisionSnapshot: {
        hunkDecisions: { [`${projectFile}:0`]: 'rejected' as const },
        fileDecisions: {},
      },
      hunkContextHashesByFile: {},
    };
    const durableAction = JSON.parse(JSON.stringify(action)) as typeof action;
    const durableRedoAction = JSON.parse(JSON.stringify(redoAction)) as typeof redoAction;
    await new ReviewDecisionStore().save('safe-team', persistenceScope.scopeKey, {
      scopeToken: persistenceScope.scopeToken,
      hunkDecisions: { [`${projectFile}:0`]: 'rejected' },
      fileDecisions: {},
      hunkContextHashesByFile: {},
      reviewActionHistory: [action],
      reviewRedoHistory: [],
      expectedRevision: 0,
    });

    const result = await ipcMain.invoke(REVIEW_EXECUTE_MUTATION, {
      scope: { teamName: 'safe-team', memberName: 'worker' },
      decisionPersistenceScope: persistenceScope,
      kind: 'undo',
      expectedTopActionId: action.id,
      diskSteps: [
        {
          id: `${action.id}:0`,
          type: 'write',
          filePath: projectFile,
          expectedContent: 'project\n',
          content: 'restored\n',
        },
      ],
      persistedState: {
        hunkDecisions: {},
        fileDecisions: {},
        hunkContextHashesByFile: {},
        reviewActionHistory: [],
        reviewRedoHistory: [redoAction],
      },
      expectedDecisionRevision: 1,
    });

    expect(result).toEqual({ success: true, data: { decisionRevision: 2 } });
    expect(applier.saveEditedFile).toHaveBeenCalledWith(projectFile, 'restored\n', 'project\n');
    await expect(
      ipcMain.invoke(
        REVIEW_LOAD_DECISIONS,
        'safe-team',
        persistenceScope.scopeKey,
        persistenceScope.scopeToken
      )
    ).resolves.toMatchObject({
      success: true,
      data: {
        hunkDecisions: {},
        fileDecisions: {},
        reviewActionHistory: [],
        reviewRedoHistory: [durableRedoAction],
      },
    });

    applier.saveEditedFile.mockClear();
    const forgedRedo = await ipcMain.invoke(REVIEW_EXECUTE_MUTATION, {
      scope: { teamName: 'safe-team', memberName: 'worker' },
      decisionPersistenceScope: persistenceScope,
      kind: 'redo',
      expectedTopRedoActionId: action.id,
      diskSteps: [
        {
          id: `${action.id}:redo:0`,
          type: 'write',
          filePath: projectFile,
          expectedContent: 'restored\n',
          content: 'forged\n',
        },
      ],
      persistedState: {
        hunkDecisions: redoAction.decisionSnapshot.hunkDecisions,
        fileDecisions: {},
        hunkContextHashesByFile: {},
        reviewActionHistory: [action],
        reviewRedoHistory: [],
      },
      expectedDecisionRevision: 2,
    });
    expect(forgedRedo).toEqual({
      success: false,
      error: 'Review Redo disk mutation does not match durable history',
    });
    expect(applier.saveEditedFile).not.toHaveBeenCalled();

    const redone = await ipcMain.invoke(REVIEW_EXECUTE_MUTATION, {
      scope: { teamName: 'safe-team', memberName: 'worker' },
      decisionPersistenceScope: persistenceScope,
      kind: 'redo',
      expectedTopRedoActionId: action.id,
      diskSteps: [
        {
          id: `${action.id}:redo:0`,
          type: 'write',
          filePath: projectFile,
          expectedContent: 'restored\n',
          content: 'project\n',
        },
      ],
      persistedState: {
        hunkDecisions: redoAction.decisionSnapshot.hunkDecisions,
        fileDecisions: {},
        hunkContextHashesByFile: {},
        reviewActionHistory: [action],
        reviewRedoHistory: [],
      },
      expectedDecisionRevision: 2,
    });

    expect(redone).toEqual({ success: true, data: { decisionRevision: 3 } });
    expect(applier.saveEditedFile).toHaveBeenCalledWith(projectFile, 'project\n', 'restored\n');
    await expect(
      ipcMain.invoke(
        REVIEW_LOAD_DECISIONS,
        'safe-team',
        persistenceScope.scopeKey,
        persistenceScope.scopeToken
      )
    ).resolves.toMatchObject({
      success: true,
      data: {
        hunkDecisions: redoAction.decisionSnapshot.hunkDecisions,
        reviewActionHistory: [durableAction],
        reviewRedoHistory: [],
        revision: 3,
      },
    });
    const { ReviewMutationJournalStore } =
      await import('@main/services/team/ReviewMutationJournalStore');
    await expect(
      new ReviewMutationJournalStore().list('safe-team', persistenceScope)
    ).resolves.toEqual([]);
  });

  it('rejects Undo disk steps that do not exactly match the durable action', async () => {
    const persistenceScope = {
      scopeKey: 'agent-worker',
      scopeToken: 'agent:worker:content:undo-step-integrity',
    };
    const file = {
      filePath: projectFile,
      relativePath: 'src/project.ts',
      snippets: [],
      linesAdded: 1,
      linesRemoved: 1,
      isNewFile: false,
    };
    const action = {
      id: 'disk-step-integrity-action',
      createdAt: '2026-07-17T12:00:00.000Z',
      kind: 'disk' as const,
      action: {
        snapshot: {
          filePath: projectFile,
          beforeContent: 'restored\n',
          afterContent: 'project\n',
          authoritativeBeforeSha256: createHash('sha256').update('restored\n').digest('hex'),
          file,
        },
        file,
        decisionSnapshot: { hunkDecisions: {}, fileDecisions: {} },
      },
    };
    const redoAction = {
      action,
      decisionSnapshot: { hunkDecisions: {}, fileDecisions: {} },
      hunkContextHashesByFile: {},
    };
    await new ReviewDecisionStore().save('safe-team', persistenceScope.scopeKey, {
      scopeToken: persistenceScope.scopeToken,
      hunkDecisions: {},
      fileDecisions: {},
      hunkContextHashesByFile: {},
      reviewActionHistory: [action],
      reviewRedoHistory: [],
      expectedRevision: 0,
    });
    const baseRequest = {
      scope: { teamName: 'safe-team', memberName: 'worker' },
      decisionPersistenceScope: persistenceScope,
      kind: 'undo' as const,
      expectedTopActionId: action.id,
      persistedState: {
        hunkDecisions: {},
        fileDecisions: {},
        hunkContextHashesByFile: {},
        reviewActionHistory: [],
        reviewRedoHistory: [redoAction],
      },
      expectedDecisionRevision: 1,
    };

    const missing = await ipcMain.invoke(REVIEW_EXECUTE_MUTATION, {
      ...baseRequest,
      diskSteps: [],
    });
    expect(missing).toEqual({
      success: false,
      error: 'Review Undo disk mutation does not match durable history',
    });

    const forged = await ipcMain.invoke(REVIEW_EXECUTE_MUTATION, {
      ...baseRequest,
      diskSteps: [
        {
          id: `${action.id}:0`,
          type: 'write',
          filePath: projectFile,
          expectedContent: 'project\n',
          content: 'forged\n',
        },
      ],
    });
    expect(forged).toEqual({
      success: false,
      error: 'Review Undo disk mutation does not match durable history',
    });
    expect(applier.saveEditedFile).not.toHaveBeenCalled();
    await expect(readFile(projectFile, 'utf8')).resolves.toBe('project\n');
  });

  it('rejects generic deletion, rewrites, and additions of trusted disk history', async () => {
    const persistenceScope = {
      scopeKey: 'agent-worker',
      scopeToken: 'agent:worker:content:main-bound-history',
    };
    const trustedAction = {
      id: 'main-bound-history-action',
      createdAt: '2026-07-17T12:00:00.000Z',
      kind: 'disk' as const,
      action: {
        snapshot: {
          filePath: projectFile,
          beforeContent: 'project\n',
          afterContent: 'project\n',
          authoritativeBeforeSha256: createHash('sha256').update('project\n').digest('hex'),
        },
        originalIndex: 0,
      },
    };
    await new ReviewDecisionStore().save('safe-team', persistenceScope.scopeKey, {
      scopeToken: persistenceScope.scopeToken,
      hunkDecisions: { [`${projectFile}:0`]: 'rejected' },
      fileDecisions: {},
      hunkContextHashesByFile: {},
      reviewActionHistory: [trustedAction],
      reviewRedoHistory: [],
      expectedRevision: 0,
    });
    const forgedRewrite = {
      ...trustedAction,
      action: {
        ...trustedAction.action,
        snapshot: {
          ...trustedAction.action.snapshot,
          beforeContent: 'renderer-forged-before\n',
          afterContent: 'renderer-forged-after\n',
          authoritativeBeforeSha256: createHash('sha256')
            .update('renderer-forged-before\n')
            .digest('hex'),
        },
      },
    };

    const saved = await ipcMain.invoke(
      REVIEW_SAVE_DECISIONS,
      'safe-team',
      persistenceScope.scopeKey,
      persistenceScope.scopeToken,
      { [`${projectFile}:0`]: 'rejected' },
      {},
      null,
      [forgedRewrite],
      1
    );
    expect(saved).toEqual({
      success: false,
      error: 'Generic saves cannot remove, reorder, or move durable review history',
    });

    const deleted = await ipcMain.invoke(
      REVIEW_SAVE_DECISIONS,
      'safe-team',
      persistenceScope.scopeKey,
      persistenceScope.scopeToken,
      { [`${projectFile}:0`]: 'rejected' },
      {},
      null,
      [],
      1
    );
    expect(deleted).toEqual({
      success: false,
      error: 'Generic saves cannot remove, reorder, or move durable review history',
    });

    const firstLoad = await ipcMain.invoke(
      REVIEW_LOAD_DECISIONS,
      'safe-team',
      persistenceScope.scopeKey,
      persistenceScope.scopeToken
    );
    expect(firstLoad).toMatchObject({
      success: true,
      data: {
        reviewActionHistory: [
          {
            id: trustedAction.id,
            action: {
              snapshot: {
                beforeContent: 'project\n',
                afterContent: 'project\n',
                authoritativeBeforeSha256: createHash('sha256')
                  .update('project\n')
                  .digest('hex'),
              },
            },
          },
        ],
      },
    });

    const newDiskAction = {
      ...forgedRewrite,
      id: 'untrusted-new-disk-action',
    };
    const rejected = await ipcMain.invoke(
      REVIEW_SAVE_DECISIONS,
      'safe-team',
      persistenceScope.scopeKey,
      persistenceScope.scopeToken,
      { [`${projectFile}:0`]: 'rejected' },
      {},
      null,
      [trustedAction, newDiskAction],
      1
    );
    expect(rejected).toEqual({
      success: false,
      error: 'Disk review history must be committed atomically with its mutation',
    });
  });

  it('rejects generic hunk history that does not invert its decision state', async () => {
    const result = await ipcMain.invoke(
      REVIEW_SAVE_DECISIONS,
      'safe-team',
      'agent-worker',
      'agent:worker:content:forged-generic-hunk',
      { [`${projectFile}:0`]: 'rejected' },
      {},
      {},
      [
        {
          id: 'forged-generic-hunk-action',
          createdAt: '2026-07-17T12:00:00.000Z',
          kind: 'hunk',
          action: { filePath: projectFile, originalIndex: 1 },
        },
      ],
      0,
      []
    );

    expect(result).toEqual({
      success: false,
      error: 'Generic hunk history does not match its decision transition',
    });
  });

  it('rejects a generic hunk descriptor that mislabels the decision intent', async () => {
    const result = await ipcMain.invoke(
      REVIEW_SAVE_DECISIONS,
      'safe-team',
      'agent-worker',
      'agent:worker:content:forged-generic-descriptor',
      { [`${projectFile}:0`]: 'accepted' },
      {},
      {},
      [
        {
          id: 'forged-generic-descriptor-action',
          createdAt: '2026-07-18T12:00:00.000Z',
          kind: 'hunk',
          descriptor: { intent: 'reject-hunk', filePath: projectFile, hunkIndex: 0 },
          action: { filePath: projectFile, originalIndex: 0 },
        },
      ],
      0,
      []
    );

    expect(result).toEqual({
      success: false,
      error: 'Generic hunk history descriptor does not match its decision transition',
    });
  });

  it('ties a forward Restore step to its newly appended durable action', async () => {
    const persistenceScope = {
      scopeKey: 'agent-worker',
      scopeToken: 'agent:worker:content:restore-step-integrity',
    };
    const aliasedProjectFile = `${path.dirname(projectFile)}${path.sep}..${path.sep}src${path.sep}${path.basename(projectFile)}`;
    const file = {
      filePath: projectFile,
      relativePath: 'src/project.ts',
      snippets: [],
      linesAdded: 1,
      linesRemoved: 1,
      isNewFile: false,
    };
    resolver.getFileContent.mockResolvedValue({
      ...file,
      originalFullContent: 'project\n',
      modifiedFullContent: 'restored\n',
      contentSource: 'ledger-exact',
    });
    const action = {
      id: 'restore-step-integrity-action',
      createdAt: '2026-07-17T12:00:00.000Z',
      kind: 'disk' as const,
      descriptor: { intent: 'restore-file' as const, filePath: aliasedProjectFile },
      action: {
        snapshot: {
          filePath: aliasedProjectFile,
          beforeContent: 'project\n',
          afterContent: 'restored\n',
          file,
        },
        file,
        decisionSnapshot: { hunkDecisions: {}, fileDecisions: {} },
      },
    };
    const persistedState = {
      hunkDecisions: {},
      fileDecisions: { [projectFile]: 'accepted' as const },
      hunkContextHashesByFile: {},
      reviewActionHistory: [action],
      reviewRedoHistory: [],
    };
    const baseRequest = {
      scope: { teamName: 'safe-team', memberName: 'worker' },
      decisionPersistenceScope: persistenceScope,
      kind: 'restore' as const,
      persistedState,
      expectedDecisionRevision: 0,
    };

    const forged = await ipcMain.invoke(REVIEW_EXECUTE_MUTATION, {
      ...baseRequest,
      diskSteps: [
        {
          id: `${action.id}:0`,
          type: 'write',
          filePath: aliasedProjectFile,
          expectedContent: 'project\n',
          content: 'forged\n',
        },
      ],
    });
    expect(forged).toEqual({
      success: false,
      error: 'Review Restore disk mutation does not match durable history',
    });
    expect(applier.saveEditedFile).not.toHaveBeenCalled();

    const forgedAction = {
      ...action,
      action: {
        ...action.action,
        snapshot: { ...action.action.snapshot, afterContent: 'forged\n' },
      },
    };
    const coordinatedForgery = await ipcMain.invoke(REVIEW_EXECUTE_MUTATION, {
      ...baseRequest,
      persistedState: {
        ...persistedState,
        reviewActionHistory: [forgedAction],
      },
      diskSteps: [
        {
          id: `${action.id}:0`,
          type: 'write',
          filePath: aliasedProjectFile,
          expectedContent: 'project\n',
          content: 'forged\n',
        },
      ],
    });
    expect(coordinatedForgery).toEqual({
      success: false,
      error: 'Review Restore content does not match authoritative review history',
    });
    expect(applier.saveEditedFile).not.toHaveBeenCalled();

    const forgedDecisions = await ipcMain.invoke(REVIEW_EXECUTE_MUTATION, {
      ...baseRequest,
      persistedState: {
        ...persistedState,
        fileDecisions: { [projectFile]: 'rejected' },
      },
      diskSteps: [
        {
          id: `${action.id}:0`,
          type: 'write',
          filePath: aliasedProjectFile,
          expectedContent: 'project\n',
          content: 'restored\n',
        },
      ],
    });
    expect(forgedDecisions).toEqual({
      success: false,
      error: 'Invalid durable Restore history transition',
    });
    expect(applier.saveEditedFile).not.toHaveBeenCalled();

    const forgedDescriptor = await ipcMain.invoke(REVIEW_EXECUTE_MUTATION, {
      ...baseRequest,
      persistedState: {
        ...persistedState,
        reviewActionHistory: [
          { ...action, descriptor: { intent: 'reject-file', filePath: aliasedProjectFile } },
        ],
      },
      diskSteps: [
        {
          id: `${action.id}:0`,
          type: 'write',
          filePath: aliasedProjectFile,
          expectedContent: 'project\n',
          content: 'restored\n',
        },
      ],
    });
    expect(forgedDescriptor).toEqual({
      success: false,
      error: 'Invalid durable Restore history transition',
    });
    expect(applier.saveEditedFile).not.toHaveBeenCalled();

    const restored = await ipcMain.invoke(REVIEW_EXECUTE_MUTATION, {
      ...baseRequest,
      diskSteps: [
        {
          id: `${action.id}:0`,
          type: 'write',
          filePath: aliasedProjectFile,
          expectedContent: 'project\n',
          content: 'restored\n',
        },
      ],
    });
    expect(restored).toMatchObject({
      success: true,
      data: {
        decisionRevision: 1,
        committedReviewAction: {
          id: action.id,
          kind: 'disk',
          descriptor: { intent: 'restore-file', filePath: projectFile },
          action: { snapshot: { authoritativeBeforeSha256: expect.any(String) } },
        },
      },
    });
    await expect(readFile(projectFile, 'utf8')).resolves.toBe('restored\n');
  });

  it('fails Restore closed when the latest durable snapshot has a reconstruction conflict', async () => {
    const persistenceScope = {
      scopeKey: 'agent-worker',
      scopeToken: 'agent:worker:content:restore-conflict',
    };
    const file = {
      filePath: projectFile,
      relativePath: 'src/project.ts',
      snippets: [],
      linesAdded: 1,
      linesRemoved: 1,
      isNewFile: false,
    };
    resolver.getFileContent.mockResolvedValue({
      ...file,
      originalFullContent: 'project\n',
      modifiedFullContent: 'restored\n',
      contentSource: 'ledger-exact',
    });
    const conflict = 'Concurrent edits cannot be reconstructed safely; refusing Restore.';
    const rejectedAction = {
      id: 'conflicted-reject-action',
      createdAt: '2026-07-17T12:00:00.000Z',
      kind: 'disk' as const,
      action: {
        snapshot: {
          filePath: projectFile,
          beforeContent: 'stale-agent-content\n',
          afterContent: 'project\n',
          authoritativeBeforeSha256: createHash('sha256')
            .update('stale-agent-content\n')
            .digest('hex'),
          restoreConflict: conflict,
          file,
        },
        file,
        decisionSnapshot: { hunkDecisions: {}, fileDecisions: {} },
      },
    };
    await new ReviewDecisionStore().save('safe-team', persistenceScope.scopeKey, {
      scopeToken: persistenceScope.scopeToken,
      hunkDecisions: {},
      fileDecisions: { [projectFile]: 'rejected' },
      hunkContextHashesByFile: {},
      reviewActionHistory: [rejectedAction],
      reviewRedoHistory: [],
      expectedRevision: 0,
    });
    const restoreAction = {
      id: 'restore-after-conflict',
      createdAt: '2026-07-17T12:01:00.000Z',
      kind: 'disk' as const,
      action: {
        snapshot: {
          filePath: projectFile,
          beforeContent: 'project\n',
          afterContent: 'restored\n',
          file,
        },
        file,
        decisionSnapshot: {
          hunkDecisions: {},
          fileDecisions: { [projectFile]: 'rejected' as const },
        },
      },
    };

    const result = await ipcMain.invoke(REVIEW_EXECUTE_MUTATION, {
      scope: { teamName: 'safe-team', memberName: 'worker' },
      decisionPersistenceScope: persistenceScope,
      kind: 'restore',
      expectedDecisionRevision: 1,
      diskSteps: [
        {
          id: `${restoreAction.id}:0`,
          type: 'write',
          filePath: projectFile,
          expectedContent: 'project\n',
          content: 'restored\n',
        },
      ],
      persistedState: {
        hunkDecisions: {},
        fileDecisions: { [projectFile]: 'accepted' },
        hunkContextHashesByFile: {},
        reviewActionHistory: [rejectedAction, restoreAction],
        reviewRedoHistory: [],
      },
    });

    expect(result).toEqual({ success: false, error: conflict });
    expect(applier.saveEditedFile).not.toHaveBeenCalled();
    await expect(readFile(projectFile, 'utf8')).resolves.toBe('project\n');
  });

  it('refuses Restore when an external file occupies an authoritative new-file path', async () => {
    const newFilePath = path.join(projectDir, 'src', 'missing.ts');
    const file = {
      filePath: newFilePath,
      relativePath: 'src/missing.ts',
      snippets: [],
      linesAdded: 1,
      linesRemoved: 0,
      isNewFile: true,
    };
    resolver.getFileContent.mockResolvedValue({
      ...file,
      originalFullContent: null,
      modifiedFullContent: 'agent-new-file\n',
      contentSource: 'ledger-exact',
    });
    await writeFile(newFilePath, 'external-owner\n', 'utf8');
    const persistenceScope = {
      scopeKey: 'agent-worker',
      scopeToken: 'agent:worker:content:new-file-occupied',
    };
    const action = {
      id: 'restore-occupied-new-file',
      createdAt: '2026-07-17T12:00:00.000Z',
      kind: 'disk' as const,
      action: {
        snapshot: {
          filePath: newFilePath,
          beforeContent: 'external-owner\n',
          afterContent: 'agent-new-file\n',
          file,
          restoreMode: 'content' as const,
        },
        file,
        decisionSnapshot: { hunkDecisions: {}, fileDecisions: {} },
      },
    };

    const restored = await ipcMain.invoke(REVIEW_EXECUTE_MUTATION, {
      scope: { teamName: 'safe-team', memberName: 'worker' },
      decisionPersistenceScope: persistenceScope,
      kind: 'restore',
      diskSteps: [
        {
          id: `${action.id}:0`,
          type: 'write',
          filePath: newFilePath,
          expectedContent: 'external-owner\n',
          content: 'agent-new-file\n',
        },
      ],
      persistedState: {
        hunkDecisions: {},
        fileDecisions: { [newFilePath]: 'accepted' },
        hunkContextHashesByFile: {},
        reviewActionHistory: [action],
        reviewRedoHistory: [],
      },
      expectedDecisionRevision: 0,
    });

    expect(restored).toEqual({
      success: false,
      error: 'A file now exists at this reviewed new-file path; refusing Restore',
    });
    await expect(readFile(newFilePath, 'utf8')).resolves.toBe('external-owner\n');
    expect(applier.saveEditedFile).not.toHaveBeenCalled();
  });

  it('restores an authoritative new file only through a missing-path CAS', async () => {
    const newFilePath = path.join(projectDir, 'src', 'missing.ts');
    const file = {
      filePath: newFilePath,
      relativePath: 'src/missing.ts',
      snippets: [],
      linesAdded: 1,
      linesRemoved: 0,
      isNewFile: true,
    };
    resolver.getFileContent.mockResolvedValue({
      ...file,
      originalFullContent: null,
      modifiedFullContent: 'agent-new-file\n',
      contentSource: 'ledger-exact',
    });
    const persistenceScope = {
      scopeKey: 'agent-worker',
      scopeToken: 'agent:worker:content:new-file-missing',
    };
    const action = {
      id: 'restore-missing-new-file',
      createdAt: '2026-07-17T12:00:00.000Z',
      kind: 'disk' as const,
      action: {
        snapshot: {
          filePath: newFilePath,
          beforeContent: '',
          afterContent: 'agent-new-file\n',
          file,
          restoreMode: 'delete-file' as const,
        },
        file,
        decisionSnapshot: { hunkDecisions: {}, fileDecisions: {} },
      },
    };

    const restored = await ipcMain.invoke(REVIEW_EXECUTE_MUTATION, {
      scope: { teamName: 'safe-team', memberName: 'worker' },
      decisionPersistenceScope: persistenceScope,
      kind: 'restore',
      diskSteps: [
        {
          id: `${action.id}:0`,
          type: 'write',
          filePath: newFilePath,
          expectedContent: null,
          content: 'agent-new-file\n',
        },
      ],
      persistedState: {
        hunkDecisions: {},
        fileDecisions: { [newFilePath]: 'accepted' },
        hunkContextHashesByFile: {},
        reviewActionHistory: [action],
        reviewRedoHistory: [],
      },
      expectedDecisionRevision: 0,
    });

    expect(restored).toMatchObject({
      success: true,
      data: {
        decisionRevision: 1,
        committedReviewAction: {
          id: action.id,
          kind: 'disk',
          action: { snapshot: { authoritativeBeforeSha256: null } },
        },
      },
    });
    await expect(readFile(newFilePath, 'utf8')).resolves.toBe('agent-new-file\n');
    await expect(
      ipcMain.invoke(
        REVIEW_LOAD_DECISIONS,
        'safe-team',
        persistenceScope.scopeKey,
        persistenceScope.scopeToken
      )
    ).resolves.toMatchObject({
      success: true,
      data: {
        reviewActionHistory: [
          {
            action: { snapshot: { authoritativeBeforeSha256: null } },
          },
        ],
      },
    });
  });

  it('refuses a stale durable Undo before touching disk', async () => {
    const persistenceScope = {
      scopeKey: 'agent-worker',
      scopeToken: 'agent:worker:content:stale-undo',
    };
    const action = {
      id: 'newer-action',
      createdAt: '2026-07-17T12:00:00.000Z',
      kind: 'hunk' as const,
      action: { filePath: projectFile, originalIndex: 0 },
    };
    await ipcMain.invoke(
      REVIEW_SAVE_DECISIONS,
      'safe-team',
      persistenceScope.scopeKey,
      persistenceScope.scopeToken,
      { [`${projectFile}:0`]: 'accepted' },
      {},
      null,
      [action],
      0
    );
    applier.saveEditedFile.mockClear();

    const result = await ipcMain.invoke(REVIEW_EXECUTE_MUTATION, {
      scope: { teamName: 'safe-team', memberName: 'worker' },
      decisionPersistenceScope: persistenceScope,
      kind: 'undo',
      expectedTopActionId: 'stale-action',
      diskSteps: [
        {
          id: 'stale-action:0',
          type: 'write',
          filePath: projectFile,
          expectedContent: 'project\n',
          content: 'restored\n',
        },
      ],
      persistedState: {
        hunkDecisions: {},
        fileDecisions: {},
        reviewActionHistory: [],
        reviewRedoHistory: [],
      },
      expectedDecisionRevision: 1,
    });

    expect(result).toEqual({
      success: false,
      error: 'Review history changed; refusing stale Undo',
    });
    expect(applier.saveEditedFile).not.toHaveBeenCalled();

    const invalidTransition = await ipcMain.invoke(REVIEW_EXECUTE_MUTATION, {
      scope: { teamName: 'safe-team', memberName: 'worker' },
      decisionPersistenceScope: persistenceScope,
      kind: 'undo',
      expectedTopActionId: action.id,
      diskSteps: [],
      persistedState: {
        hunkDecisions: {},
        fileDecisions: {},
        hunkContextHashesByFile: {},
        reviewActionHistory: [],
        reviewRedoHistory: [],
      },
      expectedDecisionRevision: 1,
    });
    expect(invalidTransition).toEqual({
      success: false,
      error: 'Invalid durable Undo history transition',
    });
  });

  it('journals decision-only hunk Undo and Redo and rejects a stale Redo top id', async () => {
    const persistenceScope = {
      scopeKey: 'agent-worker',
      scopeToken: 'agent:worker:content:hunk-redo',
    };
    const action = {
      id: 'hunk-action',
      createdAt: '2026-07-17T12:00:00.000Z',
      kind: 'hunk' as const,
      action: { filePath: projectFile, originalIndex: 0 },
    };
    const redoAction = {
      action,
      decisionSnapshot: {
        hunkDecisions: { [`${projectFile}:0`]: 'accepted' as const },
        fileDecisions: {},
      },
      hunkContextHashesByFile: { [projectFile]: { 0: 'context-hash' } },
    };
    await ipcMain.invoke(
      REVIEW_SAVE_DECISIONS,
      'safe-team',
      persistenceScope.scopeKey,
      persistenceScope.scopeToken,
      redoAction.decisionSnapshot.hunkDecisions,
      {},
      redoAction.hunkContextHashesByFile,
      [action],
      0
    );

    const forgedUndoDecisions = await ipcMain.invoke(REVIEW_EXECUTE_MUTATION, {
      scope: { teamName: 'safe-team', memberName: 'worker' },
      decisionPersistenceScope: persistenceScope,
      kind: 'undo',
      expectedTopActionId: action.id,
      diskSteps: [],
      persistedState: {
        hunkDecisions: { [`${projectFile}:0`]: 'rejected' },
        fileDecisions: {},
        hunkContextHashesByFile: redoAction.hunkContextHashesByFile,
        reviewActionHistory: [],
        reviewRedoHistory: [redoAction],
      },
      expectedDecisionRevision: 1,
    });
    expect(forgedUndoDecisions).toEqual({
      success: false,
      error: 'Invalid durable Undo history transition',
    });

    const undone = await ipcMain.invoke(REVIEW_EXECUTE_MUTATION, {
      scope: { teamName: 'safe-team', memberName: 'worker' },
      decisionPersistenceScope: persistenceScope,
      kind: 'undo',
      expectedTopActionId: action.id,
      diskSteps: [],
      persistedState: {
        hunkDecisions: {},
        fileDecisions: {},
        hunkContextHashesByFile: redoAction.hunkContextHashesByFile,
        reviewActionHistory: [],
        reviewRedoHistory: [redoAction],
      },
      expectedDecisionRevision: 1,
    });
    expect(undone).toEqual({ success: true, data: { decisionRevision: 2 } });
    expect(applier.saveEditedFile).not.toHaveBeenCalled();

    const stale = await ipcMain.invoke(REVIEW_EXECUTE_MUTATION, {
      scope: { teamName: 'safe-team', memberName: 'worker' },
      decisionPersistenceScope: persistenceScope,
      kind: 'redo',
      expectedTopRedoActionId: 'stale-action',
      diskSteps: [],
      persistedState: {
        hunkDecisions: redoAction.decisionSnapshot.hunkDecisions,
        fileDecisions: {},
        hunkContextHashesByFile: redoAction.hunkContextHashesByFile,
        reviewActionHistory: [action],
        reviewRedoHistory: [],
      },
      expectedDecisionRevision: 2,
    });
    expect(stale).toEqual({
      success: false,
      error: 'Review history changed; refusing stale Redo',
    });

    const tampered = await ipcMain.invoke(REVIEW_EXECUTE_MUTATION, {
      scope: { teamName: 'safe-team', memberName: 'worker' },
      decisionPersistenceScope: persistenceScope,
      kind: 'redo',
      expectedTopRedoActionId: action.id,
      diskSteps: [],
      persistedState: {
        hunkDecisions: { [`${projectFile}:0`]: 'rejected' },
        fileDecisions: {},
        hunkContextHashesByFile: redoAction.hunkContextHashesByFile,
        reviewActionHistory: [action],
        reviewRedoHistory: [],
      },
      expectedDecisionRevision: 2,
    });
    expect(tampered).toEqual({
      success: false,
      error: 'Invalid durable Redo history transition',
    });

    const redone = await ipcMain.invoke(REVIEW_EXECUTE_MUTATION, {
      scope: { teamName: 'safe-team', memberName: 'worker' },
      decisionPersistenceScope: persistenceScope,
      kind: 'redo',
      expectedTopRedoActionId: action.id,
      diskSteps: [],
      persistedState: {
        hunkDecisions: redoAction.decisionSnapshot.hunkDecisions,
        fileDecisions: {},
        hunkContextHashesByFile: redoAction.hunkContextHashesByFile,
        reviewActionHistory: [action],
        reviewRedoHistory: [],
      },
      expectedDecisionRevision: 2,
    });
    expect(redone).toEqual({ success: true, data: { decisionRevision: 3 } });
  });

  it('atomically reloads an externally changed file without silently dropping independent Undo', async () => {
    const persistenceScope = {
      scopeKey: 'agent-worker',
      scopeToken: 'agent:worker:content:external-reload',
    };
    const missingFile = path.join(projectDir, 'src', 'missing.ts');
    const changedAction = {
      id: 'changed-action',
      createdAt: '2026-07-18T08:00:00.000Z',
      kind: 'hunk' as const,
      action: { filePath: projectFile, originalIndex: 0 },
    };
    const independentAction = {
      id: 'independent-action',
      createdAt: '2026-07-18T08:00:01.000Z',
      kind: 'hunk' as const,
      action: { filePath: missingFile, originalIndex: 0 },
    };
    const redoEntry = {
      action: {
        ...changedAction,
        id: 'redo-changed-action',
        createdAt: '2026-07-18T08:00:02.000Z',
      },
      decisionSnapshot: {
        hunkDecisions: { [`${projectFile}:0`]: 'rejected' as const },
        fileDecisions: {},
      },
      hunkContextHashesByFile: { [projectFile]: { 0: 'changed-hash' } },
    };
    await new ReviewDecisionStore().save('safe-team', persistenceScope.scopeKey, {
      scopeToken: persistenceScope.scopeToken,
      hunkDecisions: {
        [`${projectFile}:0`]: 'rejected',
        [`${missingFile}:0`]: 'accepted',
      },
      fileDecisions: { [projectFile]: 'rejected', [missingFile]: 'accepted' },
      hunkContextHashesByFile: {
        [projectFile]: { 0: 'changed-hash' },
        [missingFile]: { 0: 'independent-hash' },
      },
      reviewActionHistory: [changedAction, independentAction],
      reviewRedoHistory: [redoEntry],
      expectedRevision: 0,
    });

    const forged = await ipcMain.invoke(REVIEW_EXECUTE_MUTATION, {
      scope: { teamName: 'safe-team', memberName: 'worker' },
      decisionPersistenceScope: persistenceScope,
      kind: 'reload-external',
      externalFilePath: projectFile,
      diskSteps: [],
      persistedState: {
        hunkDecisions: { [`${missingFile}:0`]: 'accepted' },
        fileDecisions: { [missingFile]: 'accepted' },
        hunkContextHashesByFile: { [missingFile]: { 0: 'independent-hash' } },
        reviewActionHistory: [],
        reviewRedoHistory: [],
      },
      expectedDecisionRevision: 1,
    });
    expect(forged).toEqual({
      success: false,
      error: 'Invalid durable external file reload transition',
    });

    const reloaded = await ipcMain.invoke(REVIEW_EXECUTE_MUTATION, {
      scope: { teamName: 'safe-team', memberName: 'worker' },
      decisionPersistenceScope: persistenceScope,
      kind: 'reload-external',
      externalFilePath: projectFile,
      diskSteps: [],
      persistedState: {
        hunkDecisions: { [`${missingFile}:0`]: 'accepted' },
        fileDecisions: { [missingFile]: 'accepted' },
        hunkContextHashesByFile: { [missingFile]: { 0: 'independent-hash' } },
        reviewActionHistory: [independentAction],
        reviewRedoHistory: [],
      },
      expectedDecisionRevision: 1,
    });

    expect(reloaded).toEqual({ success: true, data: { decisionRevision: 2 } });
    expect(applier.saveEditedFile).not.toHaveBeenCalled();
    await expect(
      ipcMain.invoke(
        REVIEW_LOAD_DECISIONS,
        'safe-team',
        persistenceScope.scopeKey,
        persistenceScope.scopeToken
      )
    ).resolves.toMatchObject({
      success: true,
      data: {
        hunkDecisions: { [`${missingFile}:0`]: 'accepted' },
        fileDecisions: { [missingFile]: 'accepted' },
        reviewActionHistory: [independentAction],
        reviewRedoHistory: [],
        revision: 2,
      },
    });
  });

  it('recovers a prepared decision-only Undo through the production IPC path', async () => {
    const persistenceScope = {
      scopeKey: 'agent-worker',
      scopeToken: 'agent:worker:content:hunk-undo-recovery',
    };
    const action = {
      id: 'recover-hunk-action',
      createdAt: '2026-07-17T12:00:00.000Z',
      kind: 'hunk' as const,
      action: { filePath: projectFile, originalIndex: 0 },
    };
    const redoAction = {
      action,
      decisionSnapshot: {
        hunkDecisions: { [`${projectFile}:0`]: 'accepted' as const },
        fileDecisions: {},
      },
      hunkContextHashesByFile: { [projectFile]: { 0: 'context-hash' } },
    };
    await ipcMain.invoke(
      REVIEW_SAVE_DECISIONS,
      'safe-team',
      persistenceScope.scopeKey,
      persistenceScope.scopeToken,
      redoAction.decisionSnapshot.hunkDecisions,
      {},
      redoAction.hunkContextHashesByFile,
      [action],
      0
    );
    const { ReviewMutationJournalStore } =
      await import('@main/services/team/ReviewMutationJournalStore');
    const journal = new ReviewMutationJournalStore();
    await journal.prepare({
      teamName: 'safe-team',
      persistenceScope,
      reviewScope: { teamName: 'safe-team', memberName: 'worker' },
      kind: 'undo',
      decisions: [],
      fileContents: [],
      diskSteps: [],
      persistedState: {
        hunkDecisions: {},
        fileDecisions: {},
        hunkContextHashesByFile: redoAction.hunkContextHashesByFile,
        reviewActionHistory: [],
        reviewRedoHistory: [redoAction],
      },
      expectedDecisionRevision: 1,
    });

    const recovered = await ipcMain.invoke(
      REVIEW_LOAD_DECISIONS,
      'safe-team',
      persistenceScope.scopeKey,
      persistenceScope.scopeToken
    );
    expect(recovered).toMatchObject({
      success: true,
      data: {
        hunkDecisions: {},
        reviewActionHistory: [],
        reviewRedoHistory: [redoAction],
        revision: 2,
      },
    });
    expect(applier.saveEditedFile).not.toHaveBeenCalled();
    await expect(journal.list('safe-team', persistenceScope)).resolves.toEqual([]);
  });

  it('refuses a delayed CAS clear after a newer WAL commit', async () => {
    const persistenceScope = {
      scopeKey: 'agent-worker',
      scopeToken: 'agent:worker:content:stale-clear',
    };
    const file = {
      filePath: projectFile,
      relativePath: 'src/project.ts',
      snippets: [],
      linesAdded: 1,
      linesRemoved: 1,
      isNewFile: false,
    };
    const action = {
      id: 'stale-clear-action',
      createdAt: '2026-07-17T12:00:00.000Z',
      kind: 'disk' as const,
      action: {
        snapshot: {
          filePath: projectFile,
          beforeContent: 'restored\n',
          afterContent: 'project\n',
          authoritativeBeforeSha256: createHash('sha256').update('restored\n').digest('hex'),
          file,
        },
        file,
        decisionSnapshot: { hunkDecisions: {}, fileDecisions: {} },
      },
    };
    await new ReviewDecisionStore().save('safe-team', persistenceScope.scopeKey, {
      scopeToken: persistenceScope.scopeToken,
      hunkDecisions: {},
      fileDecisions: {},
      hunkContextHashesByFile: {},
      reviewActionHistory: [action],
      reviewRedoHistory: [],
      expectedRevision: 0,
    });
    await ipcMain.invoke(REVIEW_EXECUTE_MUTATION, {
      scope: { teamName: 'safe-team', memberName: 'worker' },
      decisionPersistenceScope: persistenceScope,
      kind: 'undo',
      expectedTopActionId: action.id,
      expectedDecisionRevision: 1,
      diskSteps: [
        {
          id: `${action.id}:0`,
          type: 'write',
          filePath: projectFile,
          expectedContent: 'project\n',
          content: 'restored\n',
        },
      ],
      persistedState: {
        hunkDecisions: {},
        fileDecisions: {},
        hunkContextHashesByFile: {},
        reviewActionHistory: [],
        reviewRedoHistory: [
          {
            action,
            decisionSnapshot: { hunkDecisions: {}, fileDecisions: {} },
            hunkContextHashesByFile: {},
          },
        ],
      },
    });

    const staleClear = await ipcMain.invoke(
      REVIEW_CLEAR_DECISIONS,
      'safe-team',
      persistenceScope.scopeKey,
      persistenceScope.scopeToken,
      1
    );
    expect(staleClear).toEqual({
      success: false,
      error: 'Review decisions changed; refusing stale state overwrite',
    });
    await expect(
      ipcMain.invoke(
        REVIEW_LOAD_DECISIONS,
        'safe-team',
        persistenceScope.scopeKey,
        persistenceScope.scopeToken
      )
    ).resolves.toMatchObject({ success: true, data: { revision: 2 } });
  });

  it('resumes a multi-file Undo from the first uncheckpointed disk step', async () => {
    const { ReviewMutationJournalStore } =
      await import('@main/services/team/ReviewMutationJournalStore');
    const journal = new ReviewMutationJournalStore();
    const persistenceScope = {
      scopeKey: 'agent-worker',
      scopeToken: 'agent:worker:content:partial-undo',
    };
    await writeFile(projectFile, 'restored-project\n', 'utf8');
    await journal.prepare({
      teamName: 'safe-team',
      persistenceScope,
      reviewScope: { teamName: 'safe-team', memberName: 'worker' },
      kind: 'undo',
      decisions: [],
      fileContents: [],
      diskSteps: [
        {
          id: 'bulk-undo:0',
          type: 'write',
          filePath: projectFile,
          expectedContent: 'project\n',
          content: 'restored-project\n',
          status: 'applied',
        },
        {
          id: 'bulk-undo:1',
          type: 'write',
          filePath: worktreeFile,
          expectedContent: 'worktree\n',
          content: 'restored-worktree\n',
          status: 'pending',
        },
      ],
      persistedState: {
        hunkDecisions: {},
        fileDecisions: {},
        reviewActionHistory: [],
        reviewRedoHistory: [],
      },
      expectedDecisionRevision: 0,
    });
    applier.saveEditedFile.mockClear();

    const recovered = await ipcMain.invoke(
      REVIEW_LOAD_DECISIONS,
      'safe-team',
      persistenceScope.scopeKey,
      persistenceScope.scopeToken
    );

    expect(recovered).toMatchObject({ success: true, data: { reviewActionHistory: [] } });
    expect(applier.saveEditedFile).toHaveBeenCalledTimes(1);
    expect(applier.saveEditedFile).toHaveBeenCalledWith(
      worktreeFile,
      'restored-worktree\n',
      'worktree\n'
    );
    await expect(journal.list('safe-team', persistenceScope)).resolves.toEqual([]);
  });

  it('preflights every multi-file Undo step before the first disk write', async () => {
    extractor.getAgentChanges.mockResolvedValue({
      files: [
        {
          filePath: projectFile,
          relativePath: 'src/project.ts',
          snippets: [],
          linesAdded: 1,
          linesRemoved: 1,
          isNewFile: false,
        },
        {
          filePath: worktreeFile,
          relativePath: 'src/worktree.ts',
          snippets: [],
          linesAdded: 1,
          linesRemoved: 1,
          isNewFile: false,
        },
      ],
    });
    const persistenceScope = {
      scopeKey: 'agent-worker',
      scopeToken: 'agent:worker:content:bulk-preflight',
    };
    const action = {
      id: 'bulk-preflight-action',
      createdAt: '2026-07-17T12:00:00.000Z',
      kind: 'bulk' as const,
      decisionSnapshot: { hunkDecisions: {}, fileDecisions: {} },
      diskSnapshots: [
        { filePath: projectFile, beforeContent: 'restored-project\n', afterContent: 'project\n' },
        {
          filePath: worktreeFile,
          beforeContent: 'restored-worktree\n',
          afterContent: 'stale-worktree\n',
        },
      ],
    };
    await ipcMain.invoke(
      REVIEW_SAVE_DECISIONS,
      'safe-team',
      persistenceScope.scopeKey,
      persistenceScope.scopeToken,
      {},
      {},
      null,
      [action],
      0
    );
    applier.saveEditedFile.mockClear();

    const result = await ipcMain.invoke(REVIEW_EXECUTE_MUTATION, {
      scope: { teamName: 'safe-team', memberName: 'worker' },
      decisionPersistenceScope: persistenceScope,
      kind: 'undo',
      expectedTopActionId: action.id,
      expectedDecisionRevision: 1,
      diskSteps: [
        {
          id: `${action.id}:0`,
          type: 'write',
          filePath: projectFile,
          expectedContent: 'project\n',
          content: 'restored-project\n',
        },
        {
          id: `${action.id}:1`,
          type: 'write',
          filePath: worktreeFile,
          expectedContent: 'stale-worktree\n',
          content: 'restored-worktree\n',
        },
      ],
      persistedState: {
        hunkDecisions: {},
        fileDecisions: {},
        hunkContextHashesByFile: {},
        reviewActionHistory: [],
        reviewRedoHistory: [
          {
            action,
            decisionSnapshot: { hunkDecisions: {}, fileDecisions: {} },
            hunkContextHashesByFile: {},
          },
        ],
      },
    });

    expect(result).toMatchObject({ success: false });
    expect(applier.saveEditedFile).not.toHaveBeenCalled();
    await expect(readFile(projectFile, 'utf8')).resolves.toBe('project\n');
    await expect(readFile(worktreeFile, 'utf8')).resolves.toBe('worktree\n');
    const { ReviewMutationJournalStore } =
      await import('@main/services/team/ReviewMutationJournalStore');
    await expect(
      new ReviewMutationJournalStore().list('safe-team', persistenceScope)
    ).resolves.toEqual([]);
  });

  it('blocks recovery when an applied Undo postimage drifted after a crash', async () => {
    const { ReviewMutationJournalStore } =
      await import('@main/services/team/ReviewMutationJournalStore');
    const journal = new ReviewMutationJournalStore();
    const persistenceScope = {
      scopeKey: 'agent-worker',
      scopeToken: 'agent:worker:content:applied-undo-drift',
    };
    await writeFile(projectFile, 'external-after-crash\n', 'utf8');
    await journal.prepare({
      teamName: 'safe-team',
      persistenceScope,
      reviewScope: { teamName: 'safe-team', memberName: 'worker' },
      kind: 'undo',
      decisions: [],
      fileContents: [],
      diskSteps: [
        {
          id: 'drifted-applied-step',
          type: 'write',
          filePath: projectFile,
          expectedContent: 'project\n',
          content: 'restored\n',
          status: 'applied',
        },
      ],
      persistedState: {
        hunkDecisions: {},
        fileDecisions: {},
        reviewActionHistory: [],
        reviewRedoHistory: [],
      },
      expectedDecisionRevision: 0,
    });
    applier.saveEditedFile.mockClear();

    const recovered = await ipcMain.invoke(
      REVIEW_LOAD_DECISIONS,
      'safe-team',
      persistenceScope.scopeKey,
      persistenceScope.scopeToken
    );

    expect(recovered).toMatchObject({ success: false });
    expect(applier.saveEditedFile).not.toHaveBeenCalled();
    await expect(readFile(projectFile, 'utf8')).resolves.toBe('external-after-crash\n');
    await expect(journal.list('safe-team', persistenceScope)).resolves.toMatchObject([
      { phase: 'prepared', blocked: true },
    ]);
  });

  it('blocks decision recovery when a checkpointed path postimage drifted', async () => {
    const { ReviewMutationJournalStore } =
      await import('@main/services/team/ReviewMutationJournalStore');
    const journal = new ReviewMutationJournalStore();
    const persistenceScope = {
      scopeKey: 'agent-worker',
      scopeToken: 'agent:worker:content:applied-decision-drift',
    };
    await writeFile(projectFile, 'external-after-crash\n', 'utf8');
    const prepared = await journal.prepare({
      teamName: 'safe-team',
      persistenceScope,
      reviewScope: { teamName: 'safe-team', memberName: 'worker' },
      kind: 'reject',
      decisions: [
        {
          filePath: projectFile,
          reviewKey: 'project-change',
          fileDecision: 'rejected',
          hunkDecisions: {},
        },
      ],
      fileContents: [
        {
          filePath: projectFile,
          relativePath: 'src/project.ts',
          snippets: [],
          linesAdded: 1,
          linesRemoved: 1,
          isNewFile: false,
          originalFullContent: 'before\n',
          modifiedFullContent: 'after\n',
          contentSource: 'ledger-exact',
        },
      ],
      persistedState: {
        hunkDecisions: {},
        fileDecisions: { 'project-change': 'rejected' },
        reviewActionHistory: [],
        reviewRedoHistory: [],
      },
      expectedDecisionRevision: 0,
    });
    await journal.checkpoint({
      ...prepared,
      decisionStatuses: ['applied'],
      decisionPostimages: [
        [
          {
            filePath: projectFile,
            sha256: createHash('sha256').update('expected-postimage\n').digest('hex'),
          },
        ],
      ],
    });
    applier.applyReviewDecisions.mockClear();

    const recovered = await ipcMain.invoke(
      REVIEW_LOAD_DECISIONS,
      'safe-team',
      persistenceScope.scopeKey,
      persistenceScope.scopeToken
    );

    expect(recovered).toMatchObject({ success: false });
    expect(applier.applyReviewDecisions).not.toHaveBeenCalled();
    await expect(readFile(projectFile, 'utf8')).resolves.toBe('external-after-crash\n');
    await expect(journal.list('safe-team', persistenceScope)).resolves.toMatchObject([
      { phase: 'prepared', blocked: true },
    ]);
  });

  it('does not increment revision twice after a crash following the decision commit', async () => {
    const { ReviewDecisionStore } = await import('@main/services/team/ReviewDecisionStore');
    const { ReviewMutationJournalStore } =
      await import('@main/services/team/ReviewMutationJournalStore');
    const journal = new ReviewMutationJournalStore();
    const store = new ReviewDecisionStore();
    const persistenceScope = {
      scopeKey: 'agent-worker',
      scopeToken: 'agent:worker:content:decision-commit-crash',
    };
    const persistedState = {
      hunkDecisions: { 'stable-change:0': 'accepted' as const },
      fileDecisions: {},
      hunkContextHashesByFile: {},
      reviewActionHistory: [],
      reviewRedoHistory: [],
    };
    await writeFile(projectFile, 'restored\n', 'utf8');
    const prepared = await journal.prepare({
      teamName: 'safe-team',
      persistenceScope,
      reviewScope: { teamName: 'safe-team', memberName: 'worker' },
      kind: 'undo',
      decisions: [],
      fileContents: [],
      diskSteps: [
        {
          id: 'already-applied:0',
          type: 'write',
          filePath: projectFile,
          expectedContent: 'project\n',
          content: 'restored\n',
          status: 'applied',
        },
      ],
      persistedState,
      expectedDecisionRevision: 0,
    });
    const diskApplied = await journal.transition(prepared, 'prepared', 'disk_applied');
    await store.save('safe-team', persistenceScope.scopeKey, {
      scopeToken: persistenceScope.scopeToken,
      ...persistedState,
      expectedRevision: 0,
      mutationId: diskApplied.id,
    });
    applier.saveEditedFile.mockClear();

    const recovered = await ipcMain.invoke(
      REVIEW_LOAD_DECISIONS,
      'safe-team',
      persistenceScope.scopeKey,
      persistenceScope.scopeToken
    );
    if (!recovered.success) throw new Error(recovered.error);

    expect(recovered).toMatchObject({
      success: true,
      data: { hunkDecisions: { 'stable-change:0': 'accepted' }, revision: 1 },
    });
    expect(applier.saveEditedFile).not.toHaveBeenCalled();
    await expect(journal.list('safe-team', persistenceScope)).resolves.toEqual([]);
  });

  it('allows content reads inside configured project and member worktree roots', async () => {
    const projectResult = await ipcMain.invoke(
      REVIEW_GET_FILE_CONTENT,
      'safe-team',
      'worker',
      projectFile,
      []
    );
    const worktreeResult = await ipcMain.invoke(
      REVIEW_GET_FILE_CONTENT,
      'safe-team',
      'worker',
      worktreeFile,
      []
    );

    expect(projectResult.success).toBe(true);
    expect(worktreeResult.success).toBe(true);
    expect(resolver.getFileContent).toHaveBeenNthCalledWith(
      1,
      'safe-team',
      'worker',
      projectFile,
      []
    );
    expect(resolver.getFileContent).toHaveBeenNthCalledWith(
      2,
      'safe-team',
      'worker',
      worktreeFile,
      []
    );
  });

  it('blocks traversal and symlink escapes before content resolution', async () => {
    const traversalResult = await ipcMain.invoke(
      REVIEW_GET_FILE_CONTENT,
      'safe-team',
      'worker',
      path.join(projectDir, '..', 'outside', 'outside.ts'),
      []
    );
    expect(traversalResult).toMatchObject({ success: false });
    if (process.platform !== 'win32') {
      const escapePath = path.join(projectDir, 'escape.ts');
      await symlink(outsideFile, escapePath);
      const symlinkResult = await ipcMain.invoke(
        REVIEW_GET_FILE_CONTENT,
        'safe-team',
        'worker',
        escapePath,
        []
      );
      expect(symlinkResult).toMatchObject({ success: false });
    }
    expect(resolver.getFileContent).not.toHaveBeenCalled();
  });

  it('blocks check, reject, and apply mutation paths outside authoritative roots', async () => {
    const scope = { teamName: 'safe-team', memberName: 'worker' };
    const results = await Promise.all([
      ipcMain.invoke(REVIEW_CHECK_CONFLICT, scope, outsideFile, 'outside\n'),
      ipcMain.invoke(REVIEW_REJECT_HUNKS, scope, outsideFile, [0]),
      ipcMain.invoke(REVIEW_REJECT_FILE, scope, outsideFile),
      ipcMain.invoke(REVIEW_APPLY_DECISIONS, {
        teamName: 'safe-team',
        memberName: 'worker',
        decisions: [
          {
            filePath: outsideFile,
            fileDecision: 'rejected',
            hunkDecisions: { 0: 'rejected' },
            snippets: [],
            originalFullContent: 'before\n',
            modifiedFullContent: 'after\n',
          },
        ],
      }),
    ]);

    expect(results.every((result) => result.success === false)).toBe(true);
    expect(applier.checkConflict).not.toHaveBeenCalled();
    expect(applier.rejectHunks).not.toHaveBeenCalled();
    expect(applier.rejectFile).not.toHaveBeenCalled();
    expect(applier.applyReviewDecisions).not.toHaveBeenCalled();
  });

  it('allows check, reject, and apply mutation paths inside the configured project', async () => {
    const scope = { teamName: 'safe-team', memberName: 'worker' };
    const contentSnapshotToken = await getDisplayedSnapshotToken(projectFile);
    const checkResult = await ipcMain.invoke(
      REVIEW_CHECK_CONFLICT,
      scope,
      projectFile,
      'project\n'
    );
    const rejectHunksResult = await ipcMain.invoke(REVIEW_REJECT_HUNKS, scope, projectFile, [0]);
    const rejectFileResult = await ipcMain.invoke(REVIEW_REJECT_FILE, scope, projectFile);
    const applyResult = await ipcMain.invoke(REVIEW_APPLY_DECISIONS, {
      teamName: 'safe-team',
      memberName: 'worker',
      decisions: [
        {
          filePath: projectFile,
          fileDecision: 'rejected',
          hunkDecisions: { 0: 'rejected' },
          contentSnapshotToken,
          snippets: [],
          originalFullContent: 'before\n',
          modifiedFullContent: 'project\n',
        },
      ],
    });

    expect(checkResult.success).toBe(true);
    expect(rejectHunksResult.success).toBe(true);
    expect(rejectFileResult.success).toBe(true);
    expect(applyResult.success).toBe(true);
    expect(applier.checkConflict).toHaveBeenCalledWith(projectFile, 'project\n');
    expect(applier.rejectHunks).toHaveBeenCalledWith(
      'safe-team',
      projectFile,
      'before\n',
      'after\n',
      [0],
      []
    );
    expect(applier.rejectFile).toHaveBeenCalledWith(
      'safe-team',
      projectFile,
      'before\n',
      'after\n'
    );
    expect(applier.applyReviewDecisions).toHaveBeenCalledTimes(1);
  });

  it('applies a non-ledger decision to the immutable displayed snapshot', async () => {
    const contentSnapshotToken = await getDisplayedSnapshotToken(projectFile);
    resolver.getFileContent.mockResolvedValueOnce({
      filePath: projectFile,
      relativePath: 'src/project.ts',
      snippets: [],
      linesAdded: 1,
      linesRemoved: 1,
      isNewFile: false,
      originalFullContent: 'polluted-before\n',
      modifiedFullContent: 'external-after-display\n',
      contentSource: 'snippet-reconstruction',
    });

    const result = await ipcMain.invoke(REVIEW_APPLY_DECISIONS, {
      teamName: 'safe-team',
      memberName: 'worker',
      decisions: [
        {
          filePath: projectFile,
          fileDecision: 'rejected',
          hunkDecisions: { 0: 'rejected' },
          contentSnapshotToken,
        },
      ],
    });

    expect(result).toMatchObject({ success: true });
    const [, fileContents] = applier.applyReviewDecisions.mock.calls.at(-1) as [
      unknown,
      Map<string, { originalFullContent: string | null; modifiedFullContent: string | null }>,
    ];
    expect(fileContents.get(projectFile)).toMatchObject({
      originalFullContent: 'before\n',
      modifiedFullContent: 'after\n',
    });
    expect(resolver.getFileContent).toHaveBeenCalledTimes(1);
  });

  it('journals a durable apply and immediately merges its exact file decision', async () => {
    const { ReviewMutationJournalStore } =
      await import('@main/services/team/ReviewMutationJournalStore');
    const contentSnapshotToken = await getDisplayedSnapshotToken(projectFile);
    const persistenceScope = {
      scopeKey: 'agent-worker',
      scopeToken: 'agent:worker:content:apply-test',
    };
    const file = {
      filePath: projectFile,
      relativePath: 'src/project.ts',
      snippets: [],
      linesAdded: 1,
      linesRemoved: 1,
      isNewFile: false,
    };
    const action = {
      id: 'apply-file-reject',
      createdAt: '2026-07-17T12:00:00.000Z',
      kind: 'disk' as const,
      descriptor: { intent: 'reject-file' as const, filePath: projectFile },
      action: {
        snapshot: { filePath: projectFile, beforeContent: 'project\n', afterContent: 'before\n', file },
        file,
        decisionSnapshot: { hunkDecisions: {}, fileDecisions: {} },
      },
    };
    applier.applyReviewDecisions.mockImplementationOnce(async (_request, _contents, hooks) => {
      await hooks?.checkpointDiskTransitions([
        { filePath: projectFile, beforeContent: 'project\n', afterContent: 'project\n' },
      ]);
      return { applied: 1, skipped: 0, conflicts: 0, errors: [] };
    });

    const result = await ipcMain.invoke(REVIEW_APPLY_DECISIONS, {
      teamName: 'safe-team',
      memberName: 'worker',
      decisionPersistenceScope: persistenceScope,
      expectedDecisionRevision: 0,
      persistedState: {
        hunkDecisions: {},
        fileDecisions: { [projectFile]: 'rejected' },
        hunkContextHashesByFile: {},
        reviewActionHistory: [action],
        reviewRedoHistory: [],
      },
      decisions: [
        {
          filePath: projectFile,
          reviewKey: projectFile,
          fileDecision: 'rejected',
          hunkDecisions: {},
          contentSnapshotToken,
        },
      ],
    });

    expect(result).toMatchObject({
      success: true,
      data: {
        applied: 1,
        errors: [],
        committedReviewAction: {
          id: action.id,
          descriptor: action.descriptor,
          action: {
            snapshot: {
              authoritativeBeforeSha256: createHash('sha256').update('project\n').digest('hex'),
            },
          },
        },
      },
    });
    const decisions = await ipcMain.invoke(
      REVIEW_LOAD_DECISIONS,
      'safe-team',
      persistenceScope.scopeKey,
      persistenceScope.scopeToken
    );
    expect(decisions).toMatchObject({
      success: true,
      data: {
        hunkDecisions: {},
        fileDecisions: { [projectFile]: 'rejected' },
      },
    });
    const journal = new ReviewMutationJournalStore();
    await expect(journal.list('safe-team', persistenceScope)).resolves.toEqual([]);
  });

  it('removes a clean conflict journal so the next Changes load is not blocked', async () => {
    const contentSnapshotToken = await getDisplayedSnapshotToken(projectFile);
    const persistenceScope = {
      scopeKey: 'agent-worker',
      scopeToken: 'agent:worker:content:clean-conflict',
    };
    const file = {
      filePath: projectFile,
      relativePath: 'src/project.ts',
      snippets: [],
      linesAdded: 1,
      linesRemoved: 1,
      isNewFile: false,
    };
    applier.applyReviewDecisions.mockResolvedValueOnce({
      applied: 0,
      skipped: 0,
      conflicts: 1,
      errors: [{ filePath: projectFile, error: 'external edit', code: 'conflict' }],
    });

    const result = await ipcMain.invoke(REVIEW_APPLY_DECISIONS, {
      teamName: 'safe-team',
      memberName: 'worker',
      decisionPersistenceScope: persistenceScope,
      expectedDecisionRevision: 0,
      persistedState: {
        hunkDecisions: {},
        fileDecisions: { [projectFile]: 'rejected' },
        hunkContextHashesByFile: {},
        reviewActionHistory: [
          {
            id: 'clean-conflict-action',
            createdAt: '2026-07-17T12:00:00.000Z',
            kind: 'disk',
            action: {
              snapshot: {
                filePath: projectFile,
                beforeContent: 'project\n',
                afterContent: 'before\n',
                file,
              },
              file,
              decisionSnapshot: { hunkDecisions: {}, fileDecisions: {} },
            },
          },
        ],
        reviewRedoHistory: [],
      },
      decisions: [
        {
          filePath: projectFile,
          reviewKey: projectFile,
          fileDecision: 'rejected',
          hunkDecisions: {},
          contentSnapshotToken,
        },
      ],
    });

    expect(result).toMatchObject({
      success: true,
      data: { applied: 0, conflicts: 1, errors: [{ error: 'external edit' }] },
    });
    const { ReviewMutationJournalStore } =
      await import('@main/services/team/ReviewMutationJournalStore');
    const journal = new ReviewMutationJournalStore();
    await expect(journal.list('safe-team', persistenceScope)).resolves.toEqual([]);
    await expect(
      ipcMain.invoke(
        REVIEW_LOAD_DECISIONS,
        'safe-team',
        persistenceScope.scopeKey,
        persistenceScope.scopeToken
      )
    ).resolves.toEqual({ success: true, data: null });
  });

  it('checkpoints each Bulk file and resumes from the first unfinished decision', async () => {
    const { ReviewMutationJournalStore } =
      await import('@main/services/team/ReviewMutationJournalStore');
    extractor.getAgentChanges.mockResolvedValue({
      files: [
        {
          filePath: projectFile,
          relativePath: 'src/project.ts',
          snippets: [],
          linesAdded: 1,
          linesRemoved: 1,
          isNewFile: false,
        },
        {
          filePath: worktreeFile,
          relativePath: 'src/worktree.ts',
          snippets: [],
          linesAdded: 1,
          linesRemoved: 1,
          isNewFile: false,
        },
      ],
    });
    const projectToken = await getDisplayedSnapshotToken(projectFile);
    const worktreeToken = await getDisplayedSnapshotToken(worktreeFile);
    const persistenceScope = {
      scopeKey: 'agent-worker',
      scopeToken: 'agent:worker:content:bulk-checkpoints',
    };
    const projectSummary = {
      filePath: projectFile,
      relativePath: 'src/project.ts',
      snippets: [],
      linesAdded: 1,
      linesRemoved: 1,
      isNewFile: false,
    };
    const worktreeSummary = {
      filePath: worktreeFile,
      relativePath: 'src/worktree.ts',
      snippets: [],
      linesAdded: 1,
      linesRemoved: 1,
      isNewFile: false,
    };
    const bulkAction = {
      id: 'bulk-reject-action',
      createdAt: '2026-07-17T12:00:00.000Z',
      kind: 'bulk' as const,
      decisionSnapshot: { hunkDecisions: {}, fileDecisions: {} },
      diskSnapshots: [
        {
          filePath: projectFile,
          beforeContent: 'project\n',
          afterContent: 'before\n',
          file: projectSummary,
        },
        {
          filePath: worktreeFile,
          beforeContent: 'worktree\n',
          afterContent: 'before\n',
          file: worktreeSummary,
        },
      ],
    };
    applier.applyReviewDecisions
      .mockImplementationOnce(async (_request, _contents, hooks) => {
        await hooks?.checkpointDiskTransitions([
          { filePath: projectFile, beforeContent: 'project\n', afterContent: 'project\n' },
        ]);
        return { applied: 1, skipped: 0, conflicts: 0, errors: [] };
      })
      .mockRejectedValueOnce(new Error('simulated process stop'));

    const result = await ipcMain.invoke(REVIEW_APPLY_DECISIONS, {
      teamName: 'safe-team',
      memberName: 'worker',
      decisionPersistenceScope: persistenceScope,
      expectedDecisionRevision: 0,
      persistedState: {
        hunkDecisions: {},
        fileDecisions: { [projectFile]: 'rejected', [worktreeFile]: 'rejected' },
        hunkContextHashesByFile: {},
        reviewActionHistory: [bulkAction],
        reviewRedoHistory: [],
      },
      decisions: [
        {
          filePath: projectFile,
          reviewKey: projectFile,
          fileDecision: 'rejected',
          hunkDecisions: {},
          contentSnapshotToken: projectToken,
        },
        {
          filePath: worktreeFile,
          reviewKey: worktreeFile,
          fileDecision: 'rejected',
          hunkDecisions: {},
          contentSnapshotToken: worktreeToken,
        },
      ],
    });

    expect(result).toMatchObject({ success: false, error: 'simulated process stop' });
    expect(applier.applyReviewDecisions).toHaveBeenCalledTimes(2);
    expect(applier.applyReviewDecisions.mock.calls[0]?.[0].decisions).toHaveLength(1);
    expect(applier.applyReviewDecisions.mock.calls[1]?.[0].decisions).toHaveLength(1);

    const journal = new ReviewMutationJournalStore();
    const [blocked] = await journal.list('safe-team', persistenceScope);
    expect(blocked).toMatchObject({
      phase: 'prepared',
      decisionStatuses: ['applied', 'pending'],
      blocked: true,
    });
    await journal.checkpoint({ ...blocked, blocked: undefined, failure: undefined });
    applier.applyReviewDecisions.mockClear();
    applier.applyReviewDecisions.mockResolvedValue({
      applied: 1,
      skipped: 0,
      conflicts: 0,
      errors: [],
    });

    const recovered = await ipcMain.invoke(
      REVIEW_LOAD_DECISIONS,
      'safe-team',
      persistenceScope.scopeKey,
      persistenceScope.scopeToken
    );

    if (!recovered.success) throw new Error(recovered.error);
    expect(recovered).toMatchObject({
      success: true,
      data: {
        fileDecisions: { [projectFile]: 'rejected', [worktreeFile]: 'rejected' },
      },
    });
    expect(applier.applyReviewDecisions).toHaveBeenCalledTimes(1);
    expect(applier.applyReviewDecisions.mock.calls[0]?.[0].decisions).toEqual([
      expect.objectContaining({ filePath: worktreeFile, reviewKey: worktreeFile }),
    ]);
    await expect(journal.list('safe-team', persistenceScope)).resolves.toEqual([]);
  });

  it('commits the actual disk postimage into durable Undo history', async () => {
    const contentSnapshotToken = await getDisplayedSnapshotToken(projectFile);
    const persistenceScope = {
      scopeKey: 'agent-worker',
      scopeToken: 'agent:worker:content:actual-postimage',
    };
    const action = {
      id: 'reject-action-with-postimage',
      createdAt: '2026-07-17T12:00:00.000Z',
      kind: 'disk' as const,
      action: {
        snapshot: {
          filePath: projectFile,
          beforeContent: 'project\n',
          afterContent: 'renderer-prediction\n',
        },
        originalIndex: 0,
      },
    };
    applier.applyReviewDecisions.mockImplementationOnce(async (_request, _contents, hooks) => {
      await hooks?.checkpointDiskTransitions([
        {
          filePath: projectFile,
          beforeContent: 'project\n',
          afterContent: 'actual-three-way-result\n',
        },
      ]);
      await writeFile(projectFile, 'actual-three-way-result\n', 'utf8');
      return { applied: 1, skipped: 0, conflicts: 0, errors: [] };
    });

    const result = await ipcMain.invoke(REVIEW_APPLY_DECISIONS, {
      teamName: 'safe-team',
      memberName: 'worker',
      decisionPersistenceScope: persistenceScope,
      expectedDecisionRevision: 0,
      persistedState: {
        hunkDecisions: { [`${projectFile}:0`]: 'rejected' },
        fileDecisions: {},
        hunkContextHashesByFile: {},
        reviewActionHistory: [action],
      },
      decisions: [
        {
          filePath: projectFile,
          reviewKey: projectFile,
          fileDecision: 'pending',
          hunkDecisions: { 0: 'rejected' },
          contentSnapshotToken,
        },
      ],
    });

    expect(result).toMatchObject({ success: true, data: { applied: 1, errors: [] } });
    const loaded = await ipcMain.invoke(
      REVIEW_LOAD_DECISIONS,
      'safe-team',
      persistenceScope.scopeKey,
      persistenceScope.scopeToken
    );
    expect(loaded).toMatchObject({
      success: true,
      data: {
        reviewActionHistory: [
          {
            id: action.id,
            action: { snapshot: { afterContent: 'actual-three-way-result\n' } },
          },
        ],
      },
    });
  });

  it('does not reintroduce agent bytes after an exact-postimage external race', async () => {
    const originalContent = 'header\nbase\n';
    const modifiedContent = 'header\nagent\n';
    const concurrentRejectedContent = 'external\nheader\nbase\n';
    const expectedUndoContent = concurrentRejectedContent;
    await writeFile(projectFile, modifiedContent, 'utf8');
    resolver.getFileContent.mockResolvedValueOnce({
      filePath: projectFile,
      relativePath: 'src/project.ts',
      snippets: [],
      linesAdded: 1,
      linesRemoved: 1,
      isNewFile: false,
      originalFullContent: originalContent,
      modifiedFullContent: modifiedContent,
      contentSource: 'ledger-exact',
    });
    const contentSnapshotToken = await getDisplayedSnapshotToken(projectFile);
    const persistenceScope = {
      scopeKey: 'agent-worker',
      scopeToken: 'agent:worker:content:concurrent-reject',
    };
    const file = {
      filePath: projectFile,
      relativePath: 'src/project.ts',
      snippets: [],
      linesAdded: 1,
      linesRemoved: 1,
      isNewFile: false,
    };
    const action = {
      id: 'reject-file-with-concurrent-edit',
      createdAt: '2026-07-17T12:00:00.000Z',
      kind: 'disk' as const,
      action: {
        snapshot: {
          filePath: projectFile,
          beforeContent: 'untrusted-renderer-preimage\n',
          afterContent: 'untrusted-renderer-postimage\n',
          file,
        },
        file,
        decisionSnapshot: { hunkDecisions: {}, fileDecisions: {} },
      },
    };
    applier.applyReviewDecisions.mockImplementationOnce(async (_request, _contents, hooks) => {
      // Simulate a write landing after main captured its preimage but before the
      // applier acquired the per-file lock. It exactly equals the Reject result,
      // so the applier must persist a no-op R -> R transition rather than stale M.
      await writeFile(projectFile, concurrentRejectedContent, 'utf8');
      await hooks?.checkpointDiskTransitions([
        {
          filePath: projectFile,
          beforeContent: concurrentRejectedContent,
          afterContent: concurrentRejectedContent,
        },
      ]);
      return { applied: 1, skipped: 0, conflicts: 0, errors: [] };
    });

    const rejected = await ipcMain.invoke(REVIEW_APPLY_DECISIONS, {
      teamName: 'safe-team',
      memberName: 'worker',
      decisionPersistenceScope: persistenceScope,
      expectedDecisionRevision: 0,
      persistedState: {
        hunkDecisions: {},
        fileDecisions: { [projectFile]: 'rejected' },
        hunkContextHashesByFile: {},
        reviewActionHistory: [action],
        reviewRedoHistory: [],
      },
      decisions: [
        {
          filePath: projectFile,
          reviewKey: projectFile,
          fileDecision: 'rejected',
          hunkDecisions: {},
          contentSnapshotToken,
        },
      ],
    });

    expect(rejected).toMatchObject({ success: true, data: { applied: 1, errors: [] } });
    const storedAfterReject = await new ReviewDecisionStore().load(
      'safe-team',
      persistenceScope.scopeKey,
      persistenceScope.scopeToken
    );
    expect(storedAfterReject).not.toBeNull();
    const durableAction = storedAfterReject?.reviewActionHistory.at(-1);
    expect(durableAction).toMatchObject({
      id: action.id,
      kind: 'disk',
      action: {
        snapshot: {
          beforeContent: expectedUndoContent,
          afterContent: concurrentRejectedContent,
          authoritativeBeforeSha256: createHash('sha256')
            .update(expectedUndoContent)
            .digest('hex'),
        },
      },
    });
    if (!storedAfterReject || !durableAction) throw new Error('Durable action was not committed');

    const undone = await ipcMain.invoke(REVIEW_EXECUTE_MUTATION, {
      scope: { teamName: 'safe-team', memberName: 'worker' },
      decisionPersistenceScope: persistenceScope,
      kind: 'undo',
      expectedTopActionId: durableAction.id,
      expectedDecisionRevision: storedAfterReject.revision,
      diskSteps: [
        {
          id: `${durableAction.id}:0`,
          type: 'write',
          filePath: projectFile,
          expectedContent: concurrentRejectedContent,
          content: expectedUndoContent,
        },
      ],
      persistedState: {
        hunkDecisions: {},
        fileDecisions: {},
        hunkContextHashesByFile: {},
        reviewActionHistory: [],
        reviewRedoHistory: [
          {
            action: durableAction,
            decisionSnapshot: {
              hunkDecisions: storedAfterReject.hunkDecisions,
              fileDecisions: storedAfterReject.fileDecisions,
            },
            hunkContextHashesByFile: {},
          },
        ],
      },
    });

    expect(undone).toEqual({ success: true, data: { decisionRevision: 2 } });
    await expect(readFile(projectFile, 'utf8')).resolves.toBe(expectedUndoContent);
  });

  it('blocks Undo when an externally-deleted new file made Reject an unproven no-op', async () => {
    const newFileSnippet = {
      toolUseId: 'new-file-noop',
      filePath: projectFile,
      toolName: 'Write' as const,
      type: 'write-new' as const,
      oldString: '',
      newString: 'project\n',
      replaceAll: false,
      timestamp: '2026-07-17T12:00:00.000Z',
      isError: false,
    };
    const file = {
      filePath: projectFile,
      relativePath: 'src/project.ts',
      snippets: [newFileSnippet],
      linesAdded: 1,
      linesRemoved: 0,
      isNewFile: true,
    };
    extractor.getAgentChanges.mockResolvedValue({ files: [file] });
    resolver.getFileContent.mockResolvedValue({
      filePath: projectFile,
      relativePath: 'src/project.ts',
      snippets: [newFileSnippet],
      linesAdded: 1,
      linesRemoved: 0,
      isNewFile: true,
      originalFullContent: '',
      modifiedFullContent: 'project\n',
      contentSource: 'ledger-exact',
    });
    const contentSnapshotToken = await getDisplayedSnapshotToken(projectFile, [newFileSnippet]);
    const persistenceScope = {
      scopeKey: 'agent-worker',
      scopeToken: 'agent:worker:content:new-file-noop',
    };
    applier.applyReviewDecisions.mockImplementationOnce(async (_request, _contents, hooks) => {
      await rm(projectFile);
      await hooks?.checkpointDiskTransitions([
        { filePath: projectFile, beforeContent: null, afterContent: null },
      ]);
      return { applied: 1, skipped: 0, conflicts: 0, errors: [] };
    });

    const rejected = await ipcMain.invoke(REVIEW_APPLY_DECISIONS, {
      teamName: 'safe-team',
      memberName: 'worker',
      decisionPersistenceScope: persistenceScope,
      expectedDecisionRevision: 0,
      persistedState: {
        hunkDecisions: {},
        fileDecisions: { [projectFile]: 'rejected' },
        hunkContextHashesByFile: {},
        reviewActionHistory: [
          {
            id: 'new-file-noop-action',
            createdAt: '2026-07-17T12:00:00.000Z',
            kind: 'disk',
            action: {
              snapshot: {
                filePath: projectFile,
                beforeContent: 'untrusted\n',
                afterContent: null,
                restoreMode: 'create-file',
                file,
              },
              file,
              decisionSnapshot: { hunkDecisions: {}, fileDecisions: {} },
            },
          },
        ],
        reviewRedoHistory: [],
      },
      decisions: [
        {
          filePath: projectFile,
          reviewKey: projectFile,
          fileDecision: 'rejected',
          hunkDecisions: {},
          contentSnapshotToken,
        },
      ],
    });

    if (!rejected.success) throw new Error(rejected.error);
    expect(rejected).toMatchObject({ success: true, data: { applied: 1 } });
    const stored = await new ReviewDecisionStore().load(
      'safe-team',
      persistenceScope.scopeKey,
      persistenceScope.scopeToken
    );
    const action = stored?.reviewActionHistory.at(-1);
    expect(action).toMatchObject({
      kind: 'disk',
      action: { snapshot: { restoreConflict: expect.stringContaining('did not prove') } },
    });
    if (!stored || !action || action.kind !== 'disk') throw new Error('Missing durable action');

    const undone = await ipcMain.invoke(REVIEW_EXECUTE_MUTATION, {
      scope: { teamName: 'safe-team', memberName: 'worker' },
      decisionPersistenceScope: persistenceScope,
      kind: 'undo',
      expectedTopActionId: action.id,
      expectedDecisionRevision: stored.revision,
      diskSteps: [
        {
          id: `${action.id}:0`,
          type: 'write',
          filePath: projectFile,
          expectedContent: null,
          content: action.action.snapshot.beforeContent,
        },
      ],
      persistedState: {
        hunkDecisions: {},
        fileDecisions: {},
        hunkContextHashesByFile: {},
        reviewActionHistory: [],
        reviewRedoHistory: [
          {
            action,
            decisionSnapshot: {
              hunkDecisions: stored.hunkDecisions,
              fileDecisions: stored.fileDecisions,
            },
            hunkContextHashesByFile: stored.hunkContextHashesByFile ?? {},
          },
        ],
      },
    });

    expect(undone).toMatchObject({ success: false, error: expect.stringContaining('did not prove') });
    expect(applier.saveEditedFile).not.toHaveBeenCalled();
  });

  it('blocks Undo when an externally-restored deleted file made Reject an unproven no-op', async () => {
    const deletedFileSnippet = {
      toolUseId: 'deleted-file-noop',
      filePath: projectFile,
      toolName: 'Bash' as const,
      type: 'shell-snapshot' as const,
      oldString: 'project\n',
      newString: '',
      replaceAll: false,
      timestamp: '2026-07-17T12:00:00.000Z',
      isError: false,
      ledger: {
        eventId: 'deleted-file-noop',
        source: 'ledger-snapshot' as const,
        confidence: 'high' as const,
        originalFullContent: 'project\n',
        modifiedFullContent: null,
        beforeHash: null,
        afterHash: null,
        operation: 'delete' as const,
      },
    };
    const file = {
      filePath: projectFile,
      relativePath: 'src/project.ts',
      snippets: [deletedFileSnippet],
      linesAdded: 0,
      linesRemoved: 1,
      isNewFile: false,
    };
    extractor.getAgentChanges.mockResolvedValue({ files: [file] });
    resolver.getFileContent.mockResolvedValue({
      ...file,
      originalFullContent: 'project\n',
      modifiedFullContent: null,
      contentSource: 'ledger-exact',
    });
    const contentSnapshotToken = await getDisplayedSnapshotToken(projectFile, [deletedFileSnippet]);
    const persistenceScope = {
      scopeKey: 'agent-worker',
      scopeToken: 'agent:worker:content:deleted-file-noop',
    };
    applier.applyReviewDecisions.mockImplementationOnce(async (_request, _contents, hooks) => {
      await hooks?.checkpointDiskTransitions([
        { filePath: projectFile, beforeContent: 'project\n', afterContent: 'project\n' },
      ]);
      return { applied: 1, skipped: 0, conflicts: 0, errors: [] };
    });

    const rejected = await ipcMain.invoke(REVIEW_APPLY_DECISIONS, {
      teamName: 'safe-team',
      memberName: 'worker',
      decisionPersistenceScope: persistenceScope,
      expectedDecisionRevision: 0,
      persistedState: {
        hunkDecisions: {},
        fileDecisions: { [projectFile]: 'rejected' },
        hunkContextHashesByFile: {},
        reviewActionHistory: [
          {
            id: 'deleted-file-noop-action',
            createdAt: '2026-07-17T12:00:00.000Z',
            kind: 'disk',
            action: {
              snapshot: {
                filePath: projectFile,
                beforeContent: 'untrusted\n',
                afterContent: 'untrusted\n',
                restoreMode: 'delete-file',
                file,
              },
              file,
              decisionSnapshot: { hunkDecisions: {}, fileDecisions: {} },
            },
          },
        ],
        reviewRedoHistory: [],
      },
      decisions: [
        {
          filePath: projectFile,
          reviewKey: projectFile,
          fileDecision: 'rejected',
          hunkDecisions: {},
          contentSnapshotToken,
        },
      ],
    });

    if (!rejected.success) throw new Error(rejected.error);
    const stored = await new ReviewDecisionStore().load(
      'safe-team',
      persistenceScope.scopeKey,
      persistenceScope.scopeToken
    );
    const action = stored?.reviewActionHistory.at(-1);
    expect(action).toMatchObject({
      kind: 'disk',
      action: { snapshot: { restoreConflict: expect.stringContaining('did not prove') } },
    });
    if (!stored || !action || action.kind !== 'disk') throw new Error('Missing durable action');

    const undone = await ipcMain.invoke(REVIEW_EXECUTE_MUTATION, {
      scope: { teamName: 'safe-team', memberName: 'worker' },
      decisionPersistenceScope: persistenceScope,
      kind: 'undo',
      expectedTopActionId: action.id,
      expectedDecisionRevision: stored.revision,
      diskSteps: [],
      persistedState: {
        hunkDecisions: {},
        fileDecisions: {},
        hunkContextHashesByFile: {},
        reviewActionHistory: [],
        reviewRedoHistory: [
          {
            action,
            decisionSnapshot: {
              hunkDecisions: stored.hunkDecisions,
              fileDecisions: stored.fileDecisions,
            },
            hunkContextHashesByFile: stored.hunkContextHashesByFile ?? {},
          },
        ],
      },
    });

    expect(undone).toMatchObject({ success: false, error: expect.stringContaining('did not prove') });
    expect(applier.saveEditedFile).not.toHaveBeenCalled();
  });

  it('blocks rename recovery when Reject has no published move provenance', async () => {
    const oldFile = path.join(projectDir, 'src', 'old-noop.ts');
    const relation = { kind: 'rename' as const, oldPath: oldFile, newPath: projectFile };
    const expectation = {
      eventId: 'rename-noop-old',
      beforeHash: null,
      afterHash: null,
      relation,
    };
    const snippets = [
      {
        toolUseId: 'rename-noop-old',
        filePath: oldFile,
        toolName: 'Bash' as const,
        type: 'shell-snapshot' as const,
        oldString: 'before\n',
        newString: '',
        replaceAll: false,
        timestamp: '2026-07-17T12:00:00.000Z',
        isError: false,
        ledger: {
          eventId: 'rename-noop-old',
          source: 'ledger-snapshot' as const,
          confidence: 'high' as const,
          originalFullContent: 'before\n',
          modifiedFullContent: null,
          beforeHash: null,
          afterHash: null,
          operation: 'delete' as const,
          relation,
        },
      },
      {
        toolUseId: 'rename-noop-new',
        filePath: projectFile,
        toolName: 'Bash' as const,
        type: 'shell-snapshot' as const,
        oldString: '',
        newString: 'after\n',
        replaceAll: false,
        timestamp: '2026-07-17T12:00:01.000Z',
        isError: false,
        ledger: {
          eventId: 'rename-noop-new',
          source: 'ledger-snapshot' as const,
          confidence: 'high' as const,
          originalFullContent: null,
          modifiedFullContent: 'after\n',
          beforeHash: null,
          afterHash: null,
          operation: 'create' as const,
          relation,
        },
      },
    ];
    const file = {
      filePath: projectFile,
      relativePath: 'src/project.ts',
      snippets,
      linesAdded: 1,
      linesRemoved: 1,
      isNewFile: false,
    };
    extractor.getAgentChanges.mockResolvedValue({ files: [file] });
    resolver.getFileContent.mockResolvedValue({
      ...file,
      originalFullContent: 'before\n',
      modifiedFullContent: 'after\n',
      contentSource: 'ledger-snapshot',
    });
    const contentSnapshotToken = await getDisplayedSnapshotToken(projectFile, snippets);
    await rm(projectFile);
    await writeFile(oldFile, 'before\n', 'utf8');
    const persistenceScope = {
      scopeKey: 'agent-worker',
      scopeToken: 'agent:worker:content:rename-noop',
    };
    applier.applyReviewDecisions.mockImplementationOnce(async () => ({
      applied: 1,
      skipped: 0,
      conflicts: 0,
      errors: [],
    }));

    const rejected = await ipcMain.invoke(REVIEW_APPLY_DECISIONS, {
      teamName: 'safe-team',
      memberName: 'worker',
      decisionPersistenceScope: persistenceScope,
      expectedDecisionRevision: 0,
      persistedState: {
        hunkDecisions: {},
        fileDecisions: { [projectFile]: 'rejected' },
        hunkContextHashesByFile: {},
        reviewActionHistory: [
          {
            id: 'rename-noop-action',
            createdAt: '2026-07-17T12:00:00.000Z',
            kind: 'disk',
            action: {
              snapshot: {
                filePath: projectFile,
                beforeContent: 'untrusted\n',
                afterContent: null,
                restoreMode: 'restore-rejected-rename',
                renameExpectation: expectation,
                file,
              },
              file,
              decisionSnapshot: { hunkDecisions: {}, fileDecisions: {} },
            },
          },
        ],
        reviewRedoHistory: [],
      },
      decisions: [
        {
          filePath: projectFile,
          reviewKey: projectFile,
          fileDecision: 'rejected',
          hunkDecisions: {},
          contentSnapshotToken,
        },
      ],
    });

    if (!rejected.success) throw new Error(rejected.error);
    const stored = await new ReviewDecisionStore().load(
      'safe-team',
      persistenceScope.scopeKey,
      persistenceScope.scopeToken
    );
    const action = stored?.reviewActionHistory.at(-1);
    expect(action).toMatchObject({
      kind: 'disk',
      action: { snapshot: { restoreConflict: expect.stringContaining('provenance') } },
    });
    await expect(readFile(oldFile, 'utf8')).resolves.toBe('before\n');
    await expect(readFile(projectFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a renderer-forged durable reviewKey before touching disk', async () => {
    const contentSnapshotToken = await getDisplayedSnapshotToken(projectFile);
    const result = await ipcMain.invoke(REVIEW_APPLY_DECISIONS, {
      teamName: 'safe-team',
      memberName: 'worker',
      decisionPersistenceScope: {
        scopeKey: 'agent-worker',
        scopeToken: 'agent:worker:content:forged-review-key',
      },
      expectedDecisionRevision: 0,
      persistedState: {
        hunkDecisions: { 'forged-key:0': 'rejected' },
        fileDecisions: {},
        hunkContextHashesByFile: {},
        reviewActionHistory: [],
        reviewRedoHistory: [],
      },
      decisions: [
        {
          filePath: projectFile,
          reviewKey: 'forged-key',
          fileDecision: 'pending',
          hunkDecisions: { 0: 'rejected' },
          contentSnapshotToken,
        },
      ],
    });

    expect(result).toEqual({
      success: false,
      error: 'Durable reviewKey does not match the authoritative review identity',
    });
    expect(applier.applyReviewDecisions).not.toHaveBeenCalled();
  });

  it('rejects duplicate canonical files in one Apply batch before touching disk', async () => {
    const contentSnapshotToken = await getDisplayedSnapshotToken(projectFile);
    const decision = {
      filePath: projectFile,
      reviewKey: projectFile,
      fileDecision: 'rejected' as const,
      hunkDecisions: { 0: 'rejected' as const },
      contentSnapshotToken,
    };

    const result = await ipcMain.invoke(REVIEW_APPLY_DECISIONS, {
      teamName: 'safe-team',
      memberName: 'worker',
      decisions: [decision, { ...decision }],
    });

    expect(result).toEqual({
      success: false,
      error: 'Duplicate reviewed file in Apply decisions',
    });
    expect(applier.applyReviewDecisions).not.toHaveBeenCalled();
  });

  it('rejects a hunk history index that does not match the decision delta', async () => {
    const contentSnapshotToken = await getDisplayedSnapshotToken(projectFile);
    const result = await ipcMain.invoke(REVIEW_APPLY_DECISIONS, {
      teamName: 'safe-team',
      memberName: 'worker',
      decisionPersistenceScope: {
        scopeKey: 'agent-worker',
        scopeToken: 'agent:worker:content:forged-hunk-index',
      },
      expectedDecisionRevision: 0,
      persistedState: {
        hunkDecisions: { [`${projectFile}:0`]: 'rejected' },
        fileDecisions: {},
        hunkContextHashesByFile: {},
        reviewActionHistory: [
          {
            id: 'forged-hunk-index-action',
            createdAt: '2026-07-17T12:00:00.000Z',
            kind: 'disk',
            action: {
              snapshot: {
                filePath: projectFile,
                beforeContent: 'project\n',
                afterContent: 'before\n',
              },
              originalIndex: 1,
            },
          },
        ],
        reviewRedoHistory: [],
      },
      decisions: [
        {
          filePath: projectFile,
          reviewKey: projectFile,
          fileDecision: 'pending',
          hunkDecisions: { 0: 'rejected' },
          contentSnapshotToken,
        },
      ],
    });

    expect(result).toEqual({
      success: false,
      error: 'Durable hunk Reject history index does not match the decision transition',
    });
    expect(applier.applyReviewDecisions).not.toHaveBeenCalled();
  });

  it('rejects a durable Reject descriptor that claims a Restore intent', async () => {
    const contentSnapshotToken = await getDisplayedSnapshotToken(projectFile);
    const result = await ipcMain.invoke(REVIEW_APPLY_DECISIONS, {
      teamName: 'safe-team',
      memberName: 'worker',
      decisionPersistenceScope: {
        scopeKey: 'agent-worker',
        scopeToken: 'agent:worker:content:forged-reject-descriptor',
      },
      expectedDecisionRevision: 0,
      persistedState: {
        hunkDecisions: {},
        fileDecisions: { [projectFile]: 'rejected' },
        hunkContextHashesByFile: {},
        reviewActionHistory: [
          {
            id: 'forged-reject-descriptor-action',
            createdAt: '2026-07-18T12:00:00.000Z',
            kind: 'disk',
            descriptor: { intent: 'restore-file', filePath: projectFile },
            action: {
              snapshot: {
                filePath: projectFile,
                beforeContent: 'project\n',
                afterContent: 'before\n',
              },
              decisionSnapshot: { hunkDecisions: {}, fileDecisions: {} },
            },
          },
        ],
        reviewRedoHistory: [],
      },
      decisions: [
        {
          filePath: projectFile,
          reviewKey: projectFile,
          fileDecision: 'rejected',
          hunkDecisions: {},
          contentSnapshotToken,
        },
      ],
    });

    expect(result).toEqual({
      success: false,
      error: 'Durable Reject history descriptor does not match the decision transition',
    });
    expect(applier.applyReviewDecisions).not.toHaveBeenCalled();
  });

  it('does not let a new Reject rewrite a previously trusted disk action', async () => {
    const persistenceScope = {
      scopeKey: 'agent-worker',
      scopeToken: 'agent:worker:content:reused-action',
    };
    const file = {
      filePath: projectFile,
      relativePath: 'src/project.ts',
      snippets: [],
      linesAdded: 1,
      linesRemoved: 1,
      isNewFile: false,
    };
    const action = {
      id: 'already-trusted-action',
      createdAt: '2026-07-17T12:00:00.000Z',
      kind: 'disk' as const,
      action: {
        snapshot: {
          filePath: projectFile,
          beforeContent: 'project\n',
          afterContent: 'project\n',
          authoritativeBeforeSha256: createHash('sha256').update('project\n').digest('hex'),
          file,
        },
        file,
        decisionSnapshot: { hunkDecisions: {}, fileDecisions: {} },
      },
    };
    await new ReviewDecisionStore().save('safe-team', persistenceScope.scopeKey, {
      scopeToken: persistenceScope.scopeToken,
      hunkDecisions: {},
      fileDecisions: {},
      hunkContextHashesByFile: {},
      reviewActionHistory: [action],
      reviewRedoHistory: [],
      expectedRevision: 0,
    });
    const contentSnapshotToken = await getDisplayedSnapshotToken(projectFile);

    const result = await ipcMain.invoke(REVIEW_APPLY_DECISIONS, {
      teamName: 'safe-team',
      memberName: 'worker',
      decisionPersistenceScope: persistenceScope,
      expectedDecisionRevision: 1,
      persistedState: {
        hunkDecisions: {},
        fileDecisions: { [projectFile]: 'rejected' },
        hunkContextHashesByFile: {},
        reviewActionHistory: [action],
        reviewRedoHistory: [],
      },
      decisions: [
        {
          filePath: projectFile,
          reviewKey: projectFile,
          fileDecision: 'rejected',
          hunkDecisions: {},
          contentSnapshotToken,
        },
      ],
    });

    expect(result).toEqual({
      success: false,
      error: 'Durable Reject requires exactly one new disk history action',
    });
    expect(applier.applyReviewDecisions).not.toHaveBeenCalled();
  });

  it('rejects a durable decision scope that does not match the authoritative review identity', async () => {
    const contentSnapshotToken = await getDisplayedSnapshotToken(projectFile);
    const result = await ipcMain.invoke(REVIEW_APPLY_DECISIONS, {
      teamName: 'safe-team',
      memberName: 'worker',
      decisionPersistenceScope: {
        scopeKey: 'task-task-1',
        scopeToken: 'wrong-scope',
      },
      decisions: [
        {
          filePath: projectFile,
          reviewKey: projectFile,
          fileDecision: 'rejected',
          hunkDecisions: { 0: 'rejected' },
          contentSnapshotToken,
        },
      ],
    });

    expect(result).toMatchObject({
      success: false,
      error: 'Decision persistence scope does not match the authoritative review',
    });
    expect(applier.applyReviewDecisions).not.toHaveBeenCalled();
  });

  it('fails closed when a non-ledger reject has no displayed snapshot token', async () => {
    const result = await ipcMain.invoke(REVIEW_APPLY_DECISIONS, {
      teamName: 'safe-team',
      memberName: 'worker',
      decisions: [
        {
          filePath: projectFile,
          fileDecision: 'rejected',
          hunkDecisions: { 0: 'rejected' },
        },
      ],
    });

    expect(result).toMatchObject({
      success: false,
      error: 'Displayed review snapshot is unavailable; reload Changes before rejecting.',
    });
    expect(applier.applyReviewDecisions).not.toHaveBeenCalled();
  });

  it('requires task-scoped mutations to target a file in that reviewed task', async () => {
    const result = await ipcMain.invoke(REVIEW_APPLY_DECISIONS, {
      teamName: 'safe-team',
      taskId: 'task-1',
      decisions: [
        {
          filePath: worktreeFile,
          fileDecision: 'rejected',
          hunkDecisions: { 0: 'rejected' },
          snippets: [],
          originalFullContent: 'before\n',
          modifiedFullContent: 'after\n',
        },
      ],
    });

    expect(result).toMatchObject({
      success: false,
      error: 'File is not part of the reviewed scope',
    });
    expect(extractor.getTaskChanges).toHaveBeenCalledWith('safe-team', 'task-1');
    expect(applier.applyReviewDecisions).not.toHaveBeenCalled();
  });

  it('rejects malformed review request shapes before invoking services', async () => {
    const result = await ipcMain.invoke(REVIEW_APPLY_DECISIONS, {
      teamName: 'safe-team',
      memberName: 'worker',
      decisions: [
        {
          filePath: projectFile,
          fileDecision: 'rejected',
          hunkDecisions: { nope: 'rejected' },
          snippets: [],
        },
      ],
    });

    expect(result).toMatchObject({ success: false, error: 'Invalid hunk decision' });
    expect(applier.applyReviewDecisions).not.toHaveBeenCalled();
  });

  it('blocks authoritative ledger relations whose secondary path is not a reviewed member', async () => {
    extractor.getTaskChanges.mockResolvedValueOnce({
      files: [
        {
          filePath: projectFile,
          isNewFile: false,
          snippets: [
            {
              toolUseId: 'rename-1',
              filePath: projectFile,
              toolName: 'Bash',
              type: 'shell-snapshot',
              oldString: 'project\n',
              newString: 'project\n',
              replaceAll: false,
              timestamp: '2026-07-16T00:00:00.000Z',
              isError: false,
              ledger: {
                relation: {
                  kind: 'rename',
                  oldPath: 'src/project.ts',
                  newPath: 'src/unrelated.ts',
                },
              },
            },
          ],
        },
      ],
      scope: { memberName: 'worker' },
    });
    const result = await ipcMain.invoke(REVIEW_APPLY_DECISIONS, {
      teamName: 'safe-team',
      taskId: 'task-1',
      decisions: [
        {
          filePath: projectFile,
          fileDecision: 'rejected',
          hunkDecisions: { 0: 'rejected' },
        },
      ],
    });

    expect(result).toMatchObject({ success: false });
    expect(applier.applyReviewDecisions).not.toHaveBeenCalled();
  });

  it('allows an authoritative relation when both paths are exact reviewed members', async () => {
    const oldPath = path.join(projectDir, 'src', 'old.ts');
    const relation = {
      kind: 'rename' as const,
      oldPath: 'src/old.ts',
      newPath: 'src/project.ts',
    };
    extractor.getTaskChanges.mockResolvedValueOnce({
      files: [
        {
          filePath: projectFile,
          isNewFile: false,
          snippets: [
            {
              toolUseId: 'rename-new',
              filePath: projectFile,
              toolName: 'Bash',
              type: 'shell-snapshot',
              oldString: 'before\n',
              newString: 'after\n',
              replaceAll: false,
              timestamp: '2026-07-16T00:00:00.000Z',
              isError: false,
              ledger: { relation },
            },
            {
              toolUseId: 'rename-old',
              filePath: oldPath,
              toolName: 'Bash',
              type: 'shell-snapshot',
              oldString: 'before\n',
              newString: '',
              replaceAll: false,
              timestamp: '2026-07-16T00:00:00.000Z',
              isError: false,
            },
          ],
        },
      ],
      scope: { memberName: 'worker' },
    });

    const result = await ipcMain.invoke(REVIEW_APPLY_DECISIONS, {
      teamName: 'safe-team',
      taskId: 'task-1',
      decisions: [
        {
          filePath: projectFile,
          fileDecision: 'rejected',
          hunkDecisions: { 0: 'rejected' },
        },
      ],
    });

    expect(result).toMatchObject({ success: true });
    expect(applier.applyReviewDecisions).toHaveBeenCalledTimes(1);
  });

  it('ignores renderer-forged lifecycle, contents, and relation metadata', async () => {
    const contentSnapshotToken = await getDisplayedSnapshotToken(projectFile);
    const result = await ipcMain.invoke(REVIEW_APPLY_DECISIONS, {
      teamName: 'safe-team',
      memberName: 'worker',
      decisions: [
        {
          filePath: projectFile,
          fileDecision: 'rejected',
          hunkDecisions: { 0: 'rejected' },
          contentSnapshotToken,
          isNewFile: true,
          originalFullContent: '',
          modifiedFullContent: 'forged\n',
          snippets: [
            {
              toolUseId: 'forged-create',
              filePath: projectFile,
              toolName: 'Write',
              type: 'write-new',
              oldString: '',
              newString: 'forged\n',
              replaceAll: false,
              timestamp: '2026-07-16T00:00:00.000Z',
              isError: false,
              ledger: {
                relation: {
                  kind: 'rename',
                  oldPath: 'src/project.ts',
                  newPath: 'src/unrelated.ts',
                },
              },
            },
          ],
        },
      ],
    });

    expect(result).toMatchObject({ success: true });
    const [, fileContents] = applier.applyReviewDecisions.mock.calls[0] as [
      unknown,
      Map<string, { isNewFile: boolean; snippets: unknown[]; originalFullContent: string | null }>,
    ];
    expect(fileContents.get(projectFile)).toMatchObject({
      isNewFile: false,
      snippets: [],
      originalFullContent: 'before\n',
    });
  });

  it('uses resolver lifecycle evidence instead of the summary isNewFile flag', async () => {
    resolver.getFileContent.mockResolvedValueOnce({
      filePath: projectFile,
      relativePath: 'src/project.ts',
      snippets: [],
      linesAdded: 1,
      linesRemoved: 0,
      isNewFile: true,
      originalFullContent: '',
      modifiedFullContent: 'created\n',
      contentSource: 'ledger-exact',
    });
    const contentSnapshotToken = await getDisplayedSnapshotToken(projectFile);

    const result = await ipcMain.invoke(REVIEW_APPLY_DECISIONS, {
      teamName: 'safe-team',
      memberName: 'worker',
      decisions: [
        {
          filePath: projectFile,
          fileDecision: 'rejected',
          hunkDecisions: { 0: 'rejected' },
          contentSnapshotToken,
        },
      ],
    });

    expect(result).toMatchObject({ success: true });
    const [, fileContents] = applier.applyReviewDecisions.mock.calls[0] as [
      unknown,
      Map<string, { isNewFile: boolean }>,
    ];
    expect(fileContents.get(projectFile)?.isNewFile).toBe(true);
  });

  it('requires a task or member identity for every mutation scope', async () => {
    const scope = { teamName: 'safe-team' };
    const results = await Promise.all([
      ipcMain.invoke(REVIEW_CHECK_CONFLICT, scope, projectFile, 'project\n'),
      ipcMain.invoke(REVIEW_REJECT_HUNKS, scope, projectFile, [0]),
      ipcMain.invoke(REVIEW_REJECT_FILE, scope, projectFile),
      ipcMain.invoke(REVIEW_APPLY_DECISIONS, {
        ...scope,
        decisions: [
          {
            filePath: projectFile,
            fileDecision: 'rejected',
            hunkDecisions: { 0: 'rejected' },
          },
        ],
      }),
      ipcMain.invoke(REVIEW_SAVE_EDITED_FILE, scope, projectFile, 'forged\n', 'project\n'),
    ]);

    expect(results).toHaveLength(5);
    for (const result of results) {
      expect(result).toMatchObject({
        success: false,
        error: 'Review mutation requires taskId or memberName',
      });
    }
  });

  it('does not trust forged project roots or allow unrelated files inside configured roots', async () => {
    const forgedRoot = await ipcMain.invoke(
      REVIEW_SAVE_EDITED_FILE,
      { teamName: 'safe-team', memberName: 'worker', projectPath: outsideDir },
      outsideFile,
      'forged\n',
      'outside\n'
    );
    const unrelated = await ipcMain.invoke(
      REVIEW_SAVE_EDITED_FILE,
      { teamName: 'safe-team', memberName: 'worker' },
      worktreeFile,
      'unrelated\n',
      'worktree\n'
    );

    expect(forgedRoot).toMatchObject({
      success: false,
      error: 'File is not part of the reviewed scope',
    });
    expect(unrelated).toMatchObject({
      success: false,
      error: 'File is not part of the reviewed scope',
    });
    expect(applier.saveEditedFile).not.toHaveBeenCalled();
  });

  it('rejects a renderer member that conflicts with the authoritative task scope', async () => {
    const result = await ipcMain.invoke(
      REVIEW_SAVE_EDITED_FILE,
      {
        teamName: 'safe-team',
        taskId: 'task-1',
        memberName: 'other-worker',
      },
      projectFile,
      'forged\n',
      'project\n'
    );

    expect(result).toMatchObject({
      success: false,
      error: 'Review memberName does not match the authoritative task scope',
    });
    expect(applier.saveEditedFile).not.toHaveBeenCalled();
  });

  it('uses expectedCurrentContent as a compare-and-set guard for edited saves', async () => {
    const scope = { teamName: 'safe-team', memberName: 'worker' };
    const allowed = await ipcMain.invoke(
      REVIEW_SAVE_EDITED_FILE,
      scope,
      projectFile,
      'restored\n',
      'project\n'
    );
    const conflict = await ipcMain.invoke(
      REVIEW_SAVE_EDITED_FILE,
      scope,
      projectFile,
      'stale restore\n',
      'different\n'
    );
    const missingFile = path.join(projectDir, 'src', 'missing.ts');
    const restoreMissing = await ipcMain.invoke(
      REVIEW_SAVE_EDITED_FILE,
      scope,
      missingFile,
      'created\n',
      null
    );
    let symlinkEscape: IpcResult<unknown> | null = null;
    if (process.platform !== 'win32') {
      const escapeDir = path.join(projectDir, 'escape-dir');
      await symlink(outsideDir, escapeDir);
      symlinkEscape = await ipcMain.invoke(
        REVIEW_SAVE_EDITED_FILE,
        scope,
        path.join(escapeDir, 'missing.ts'),
        'escaped\n',
        null
      );
    }

    expect(allowed).toMatchObject({ success: true });
    expect(conflict).toMatchObject({
      success: false,
      error: 'File changed since review update; refusing to overwrite',
    });
    expect(restoreMissing).toMatchObject({ success: true });
    if (symlinkEscape) {
      expect(symlinkEscape).toMatchObject({ success: false });
    }
    expect(applier.saveEditedFile).toHaveBeenCalledTimes(3);
    expect(applier.saveEditedFile).toHaveBeenNthCalledWith(
      1,
      projectFile,
      'restored\n',
      'project\n'
    );
    expect(applier.saveEditedFile).toHaveBeenNthCalledWith(
      2,
      projectFile,
      'stale restore\n',
      'different\n'
    );
    expect(applier.saveEditedFile).toHaveBeenNthCalledWith(3, missingFile, 'created\n', null);
  });

  it('refuses to mutate a multiply-linked review path', async () => {
    if (process.platform === 'win32') return;
    const hardlinkPath = path.join(projectDir, 'src', 'hardlink.ts');
    await link(outsideFile, hardlinkPath);
    extractor.getAgentChanges.mockResolvedValueOnce({
      files: [{ filePath: hardlinkPath, snippets: [], isNewFile: false }],
    });

    const result = await ipcMain.invoke(
      REVIEW_SAVE_EDITED_FILE,
      { teamName: 'safe-team', memberName: 'worker' },
      hardlinkPath,
      'mutated\n',
      'outside\n'
    );

    expect(result).toMatchObject({
      success: false,
      error: 'Review mutation refuses symbolic or multiply-linked files',
    });
    await expect(readFile(outsideFile, 'utf8')).resolves.toBe('outside\n');
    expect(applier.saveEditedFile).not.toHaveBeenCalled();
  });

  it('recovers an app-owned crash-left atomic-create link before mutation', async () => {
    if (process.platform === 'win32') return;
    const crashTemp = path.join(
      path.dirname(projectFile),
      '.review-create.00000000-0000-0000-0000-000000000000.tmp'
    );
    await link(projectFile, crashTemp);

    const result = await ipcMain.invoke(
      REVIEW_SAVE_EDITED_FILE,
      { teamName: 'safe-team', memberName: 'worker' },
      projectFile,
      'restored\n',
      'project\n'
    );

    expect(result).toMatchObject({ success: true });
    await expect(readFile(crashTemp, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(applier.saveEditedFile).toHaveBeenCalledWith(projectFile, 'restored\n', 'project\n');
  });

  it('does not clean hardlinks until the target is authorized inside a review root', async () => {
    if (process.platform === 'win32') return;
    const outsideCrashTemp = path.join(
      outsideDir,
      '.review-create.11111111-1111-1111-1111-111111111111.tmp'
    );
    await link(outsideFile, outsideCrashTemp);
    extractor.getAgentChanges.mockResolvedValueOnce({
      files: [{ filePath: outsideFile, snippets: [], isNewFile: false }],
    });

    const result = await ipcMain.invoke(
      REVIEW_SAVE_EDITED_FILE,
      { teamName: 'safe-team', memberName: 'worker' },
      outsideFile,
      'mutated\n',
      'outside\n'
    );

    expect(result).toMatchObject({ success: false });
    await expect(readFile(outsideCrashTemp, 'utf8')).resolves.toBe('outside\n');
    expect(applier.saveEditedFile).not.toHaveBeenCalled();
  });

  it('confines guarded Undo deletion to an authoritative reviewed file', async () => {
    const scope = { teamName: 'safe-team', memberName: 'worker' };
    const allowed = await ipcMain.invoke(
      REVIEW_DELETE_EDITED_FILE,
      scope,
      projectFile,
      'restored\n'
    );
    const unrelated = await ipcMain.invoke(
      REVIEW_DELETE_EDITED_FILE,
      scope,
      worktreeFile,
      'restored\n'
    );
    const invalid = await ipcMain.invoke(REVIEW_DELETE_EDITED_FILE, scope, projectFile, null);

    expect(allowed).toEqual({ success: true, data: { success: true } });
    expect(unrelated).toMatchObject({
      success: false,
      error: 'File is not part of the reviewed scope',
    });
    expect(invalid).toEqual({ success: false, error: 'Invalid parameters' });
    expect(applier.deleteEditedFile).toHaveBeenCalledTimes(1);
    expect(applier.deleteEditedFile).toHaveBeenCalledWith(projectFile, 'restored\n');
  });

  it('restores a rejected rename only from authoritative review metadata', async () => {
    const oldFile = path.join(projectDir, 'src', 'old.ts');
    const relation = { kind: 'rename' as const, oldPath: oldFile, newPath: projectFile };
    const expectation = {
      eventId: 'rename-old',
      beforeHash: null,
      afterHash: null,
      relation,
    };
    const snippets = [
      {
        toolUseId: 'rename-old',
        filePath: oldFile,
        toolName: 'Bash' as const,
        type: 'shell-snapshot' as const,
        oldString: 'before\n',
        newString: '',
        replaceAll: false,
        timestamp: '2026-07-17T10:00:00.000Z',
        isError: false,
        ledger: {
          eventId: 'rename-old',
          source: 'ledger-snapshot' as const,
          confidence: 'high' as const,
          originalFullContent: 'before\n',
          modifiedFullContent: null,
          beforeHash: null,
          afterHash: null,
          operation: 'delete' as const,
          relation,
        },
      },
      {
        toolUseId: 'rename-new',
        filePath: projectFile,
        toolName: 'Bash' as const,
        type: 'shell-snapshot' as const,
        oldString: '',
        newString: 'after\n',
        replaceAll: false,
        timestamp: '2026-07-17T10:00:01.000Z',
        isError: false,
        ledger: {
          eventId: 'rename-new',
          source: 'ledger-snapshot' as const,
          confidence: 'high' as const,
          originalFullContent: null,
          modifiedFullContent: 'after\n',
          beforeHash: null,
          afterHash: null,
          operation: 'create' as const,
          relation,
        },
      },
    ];
    extractor.getAgentChanges.mockResolvedValueOnce({
      files: [{ filePath: projectFile, snippets, isNewFile: false }],
    });
    resolver.getFileContent.mockResolvedValueOnce({
      filePath: projectFile,
      relativePath: 'src/project.ts',
      snippets,
      linesAdded: 1,
      linesRemoved: 1,
      isNewFile: false,
      originalFullContent: 'before\n',
      modifiedFullContent: 'after\n',
      contentSource: 'ledger-snapshot',
    });

    const result = await ipcMain.invoke(
      REVIEW_RESTORE_REJECTED_RENAME,
      { teamName: 'safe-team', memberName: 'worker' },
      projectFile,
      expectation
    );

    expect(result).toEqual({ success: true, data: { success: true } });
    expect(applier.restoreRejectedRename).toHaveBeenCalledWith(
      projectFile,
      'before\n',
      'after\n',
      snippets
    );
    expect(resolver.invalidateFile).toHaveBeenCalledWith(oldFile);
    expect(resolver.invalidateFile).toHaveBeenCalledWith(projectFile);

    applier.restoreRejectedRename.mockClear();
    extractor.getAgentChanges.mockResolvedValueOnce({
      files: [{ filePath: projectFile, snippets, isNewFile: false }],
    });
    const stale = await ipcMain.invoke(
      REVIEW_RESTORE_REJECTED_RENAME,
      { teamName: 'safe-team', memberName: 'worker' },
      projectFile,
      { ...expectation, eventId: 'stale-event' }
    );

    expect(stale).toEqual({
      success: false,
      error: 'Review changes were updated; refusing stale rename recovery',
    });
    expect(applier.restoreRejectedRename).not.toHaveBeenCalled();

    applier.restoreRejectedRename.mockRejectedValueOnce(new Error('rollback incomplete'));
    resolver.invalidateFile.mockClear();
    extractor.getAgentChanges.mockResolvedValueOnce({
      files: [{ filePath: projectFile, snippets, isNewFile: false }],
    });
    const failed = await ipcMain.invoke(
      REVIEW_RESTORE_REJECTED_RENAME,
      { teamName: 'safe-team', memberName: 'worker' },
      projectFile,
      expectation
    );

    expect(failed).toEqual({ success: false, error: 'rollback incomplete' });
    expect(resolver.invalidateFile).toHaveBeenCalledWith(oldFile);
    expect(resolver.invalidateFile).toHaveBeenCalledWith(projectFile);
  });
});
