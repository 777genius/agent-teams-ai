import {
  initializeReviewHandlers,
  registerReviewHandlers,
  removeReviewHandlers,
} from '@main/ipc/review';
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
            snippets: [],
            isNewFile: false,
          },
        ],
        scope: { memberName: 'worker' },
      }),
      getAgentChanges: vi.fn().mockResolvedValue({
        files: [
          {
            filePath: projectFile,
            snippets: [],
            isNewFile: false,
          },
          {
            filePath: path.join(projectDir, 'src', 'missing.ts'),
            snippets: [],
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
    await ipcMain.invoke(
      REVIEW_SAVE_DECISIONS,
      'safe-team',
      persistenceScope.scopeKey,
      persistenceScope.scopeToken,
      { [`${projectFile}:0`]: 'rejected' },
      {},
      null,
      [action],
      0
    );

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
    const action = {
      id: 'stale-clear-action',
      createdAt: '2026-07-17T12:00:00.000Z',
      kind: 'disk' as const,
      action: {
        snapshot: {
          filePath: projectFile,
          beforeContent: 'restored\n',
          afterContent: 'project\n',
        },
      },
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
        { filePath: projectFile, snippets: [], isNewFile: false },
        { filePath: worktreeFile, snippets: [], isNewFile: false },
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

    const result = await ipcMain.invoke(REVIEW_APPLY_DECISIONS, {
      teamName: 'safe-team',
      memberName: 'worker',
      decisionPersistenceScope: persistenceScope,
      expectedDecisionRevision: 0,
      persistedState: {
        hunkDecisions: { 'stable-change-key:0': 'rejected' },
        fileDecisions: { 'stable-change-key': 'rejected' },
        hunkContextHashesByFile: {},
        reviewActionHistory: [],
      },
      decisions: [
        {
          filePath: projectFile,
          reviewKey: 'stable-change-key',
          fileDecision: 'rejected',
          hunkDecisions: { 0: 'rejected' },
          contentSnapshotToken,
        },
      ],
    });

    expect(result).toMatchObject({ success: true, data: { applied: 1, errors: [] } });
    const decisions = await ipcMain.invoke(
      REVIEW_LOAD_DECISIONS,
      'safe-team',
      persistenceScope.scopeKey,
      persistenceScope.scopeToken
    );
    expect(decisions).toMatchObject({
      success: true,
      data: {
        hunkDecisions: { 'stable-change-key:0': 'rejected' },
        fileDecisions: { 'stable-change-key': 'rejected' },
      },
    });
    const journal = new ReviewMutationJournalStore();
    await expect(journal.list('safe-team', persistenceScope)).resolves.toEqual([]);
  });

  it('checkpoints each Bulk file and resumes from the first unfinished decision', async () => {
    const { ReviewMutationJournalStore } =
      await import('@main/services/team/ReviewMutationJournalStore');
    extractor.getAgentChanges.mockResolvedValue({
      files: [
        { filePath: projectFile, snippets: [], isNewFile: false },
        { filePath: worktreeFile, snippets: [], isNewFile: false },
      ],
    });
    const projectToken = await getDisplayedSnapshotToken(projectFile);
    const worktreeToken = await getDisplayedSnapshotToken(worktreeFile);
    const persistenceScope = {
      scopeKey: 'agent-worker',
      scopeToken: 'agent:worker:content:bulk-checkpoints',
    };
    applier.applyReviewDecisions
      .mockResolvedValueOnce({ applied: 1, skipped: 0, conflicts: 0, errors: [] })
      .mockRejectedValueOnce(new Error('simulated process stop'));

    const result = await ipcMain.invoke(REVIEW_APPLY_DECISIONS, {
      teamName: 'safe-team',
      memberName: 'worker',
      decisionPersistenceScope: persistenceScope,
      expectedDecisionRevision: 0,
      persistedState: {
        hunkDecisions: {},
        fileDecisions: { 'project-change': 'rejected', 'worktree-change': 'rejected' },
        hunkContextHashesByFile: {},
        reviewActionHistory: [],
      },
      decisions: [
        {
          filePath: projectFile,
          reviewKey: 'project-change',
          fileDecision: 'rejected',
          hunkDecisions: {},
          contentSnapshotToken: projectToken,
        },
        {
          filePath: worktreeFile,
          reviewKey: 'worktree-change',
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

    expect(recovered).toMatchObject({
      success: true,
      data: {
        fileDecisions: { 'project-change': 'rejected', 'worktree-change': 'rejected' },
      },
    });
    expect(applier.applyReviewDecisions).toHaveBeenCalledTimes(1);
    expect(applier.applyReviewDecisions.mock.calls[0]?.[0].decisions).toEqual([
      expect.objectContaining({ filePath: worktreeFile, reviewKey: 'worktree-change' }),
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
    applier.applyReviewDecisions.mockImplementationOnce(async () => {
      await writeFile(projectFile, 'actual-three-way-result\n', 'utf8');
      return { applied: 1, skipped: 0, conflicts: 0, errors: [] };
    });

    const result = await ipcMain.invoke(REVIEW_APPLY_DECISIONS, {
      teamName: 'safe-team',
      memberName: 'worker',
      decisionPersistenceScope: persistenceScope,
      expectedDecisionRevision: 0,
      persistedState: {
        hunkDecisions: { 'stable-change-key:0': 'rejected' },
        fileDecisions: {},
        hunkContextHashesByFile: {},
        reviewActionHistory: [action],
      },
      decisions: [
        {
          filePath: projectFile,
          reviewKey: 'stable-change-key',
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
