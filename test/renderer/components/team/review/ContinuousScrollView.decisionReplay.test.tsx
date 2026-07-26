import React, { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ContinuousScrollView } from '../../../../../src/renderer/components/team/review/ContinuousScrollView';

import type { EditorView } from '@codemirror/view';
import type { FileChangeSummary, FileChangeWithContent, HunkDecision } from '@shared/types';
import type { EditorSelectionInfo } from '@shared/types/editor';

const replaySpies = vi.hoisted(() => ({
  acceptAllChunks: vi.fn(),
  rejectAllChunks: vi.fn(),
  replayHunkDecisionsSmart: vi.fn(),
  selectionCallbacks: new Map<string, (info: EditorSelectionInfo | null) => void>(),
  setFileChunkCount: vi.fn(),
}));

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@renderer/hooks/useLazyFileContent', () => ({
  useLazyFileContent: () => ({ registerLazyRef: () => () => undefined }),
}));

vi.mock('@renderer/hooks/useVisibleFileSection', () => ({
  useVisibleFileSection: () => ({ registerFileSectionRef: () => () => undefined }),
}));

vi.mock('@renderer/store', () => ({
  useStore: (
    selector: (state: {
      fileChunkCounts: Record<string, number>;
      setFileChunkCount: typeof replaySpies.setFileChunkCount;
    }) => unknown
  ) =>
    selector({
      fileChunkCounts: {},
      setFileChunkCount: replaySpies.setFileChunkCount,
    }),
}));

vi.mock('../../../../../src/renderer/components/team/review/CodeMirrorDiffUtils', () => ({
  acceptAllChunks: replaySpies.acceptAllChunks,
  getChunks: () => ({ chunks: [] }),
  rejectAllChunks: replaySpies.rejectAllChunks,
  replayHunkDecisionsSmart: replaySpies.replayHunkDecisionsSmart,
}));

vi.mock('../../../../../src/renderer/components/team/review/FileSectionHeader', () => ({
  FileSectionHeader: () => null,
}));

vi.mock('../../../../../src/renderer/components/team/review/FullDiffLoadingBanner', () => ({
  FullDiffLoadingBanner: () => null,
}));

vi.mock('../../../../../src/renderer/components/team/review/FileSectionDiff', () => ({
  FileSectionDiff: ({
    discardCounter,
    file,
    onEditorViewReady,
    onSelectionChange,
  }: {
    discardCounter: number;
    file: FileChangeSummary;
    onEditorViewReady: (filePath: string, view: EditorView | null) => void;
    onSelectionChange?: (info: EditorSelectionInfo | null) => void;
  }) => {
    if (onSelectionChange) replaySpies.selectionCallbacks.set(file.filePath, onSelectionChange);
    useEffect(() => {
      const view = { state: {} } as EditorView;
      onEditorViewReady(file.filePath, view);
      return () => {
        onEditorViewReady(file.filePath, null);
        if (replaySpies.selectionCallbacks.get(file.filePath) === onSelectionChange) {
          replaySpies.selectionCallbacks.delete(file.filePath);
        }
      };
    }, [discardCounter, file.filePath, onEditorViewReady, onSelectionChange]);
    return null;
  },
}));

const file: FileChangeSummary = {
  filePath: '/repo/file.ts',
  relativePath: 'file.ts',
  snippets: [],
  linesAdded: 1,
  linesRemoved: 0,
  isNewFile: false,
};

const fileContent: FileChangeWithContent = {
  ...file,
  originalFullContent: 'before',
  modifiedFullContent: 'after',
  contentSource: 'ledger-exact',
};

const noop = () => undefined;

describe('ContinuousScrollView decision replay', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    replaySpies.selectionCallbacks.clear();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    { decision: 'accepted' as const, replay: replaySpies.acceptAllChunks },
    { decision: 'rejected' as const, replay: replaySpies.rejectAllChunks },
  ])(
    'does not replay the previous $decision decision after a restore remount',
    async (testCase) => {
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      const scrollContainerRef = React.createRef<HTMLDivElement>();
      const editorViewMapRef = { current: new Map<string, EditorView>() };
      const isProgrammaticScroll = { current: false };

      const renderView = (
        fileDecisions: Record<string, HunkDecision>,
        discardCounter: number
      ): React.ReactElement => (
        <ContinuousScrollView
          files={[file]}
          fileContents={{ [file.filePath]: fileContent }}
          fileContentsLoading={{}}
          reviewExternalChangesByFile={{}}
          viewedSet={new Set()}
          editedContents={{}}
          draftHistoryEntries={{}}
          hunkDecisions={{}}
          fileDecisions={fileDecisions}
          hunkContextHashesByFile={{}}
          collapseUnchanged={false}
          applying={false}
          autoViewed={false}
          discardCounters={{ [file.filePath]: discardCounter }}
          onHunkAccepted={noop}
          onHunkRejected={noop}
          onFullyViewed={noop}
          onContentChanged={noop}
          onSerializedStateChanged={noop}
          onSerializedStateRestoreError={noop}
          onDiscard={noop}
          onSave={noop}
          onReloadFromDisk={noop}
          onKeepDraft={noop}
          onAcceptFile={noop}
          onRejectFile={noop}
          onVisibleFileChange={noop}
          scrollContainerRef={scrollContainerRef}
          editorViewMapRef={editorViewMapRef}
          isProgrammaticScroll={isProgrammaticScroll}
          teamName="test-team"
          memberName="test-member"
          fetchFileContent={async () => undefined}
        />
      );

      await act(async () => root.render(renderView({ [file.filePath]: testCase.decision }, 0)));
      expect(testCase.replay).toHaveBeenCalledTimes(1);
      vi.clearAllMocks();

      await act(async () => root.render(renderView({}, 1)));

      expect(testCase.replay).not.toHaveBeenCalled();
      await act(async () => root.unmount());
      container.remove();
    }
  );

  it('uses current hunk, hash, and draft state for each remounted editor', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const scrollContainerRef = React.createRef<HTMLDivElement>();
    const editorViewMapRef = { current: new Map<string, EditorView>() };
    const isProgrammaticScroll = { current: false };
    const renderView = (
      state: {
        editedContents?: Record<string, string>;
        fileDecisions?: Record<string, HunkDecision>;
        hunkContextHashesByFile?: Record<string, Record<number, string>>;
        hunkDecisions?: Record<string, HunkDecision>;
      },
      discardCounter: number
    ): React.ReactElement => (
      <ContinuousScrollView
        files={[file]}
        fileContents={{ [file.filePath]: fileContent }}
        fileContentsLoading={{}}
        reviewExternalChangesByFile={{}}
        viewedSet={new Set()}
        editedContents={state.editedContents ?? {}}
        draftHistoryEntries={{}}
        hunkDecisions={state.hunkDecisions ?? {}}
        fileDecisions={state.fileDecisions ?? {}}
        hunkContextHashesByFile={state.hunkContextHashesByFile ?? {}}
        collapseUnchanged={false}
        applying={false}
        autoViewed={false}
        discardCounters={{ [file.filePath]: discardCounter }}
        onHunkAccepted={noop}
        onHunkRejected={noop}
        onFullyViewed={noop}
        onContentChanged={noop}
        onSerializedStateChanged={noop}
        onSerializedStateRestoreError={noop}
        onDiscard={noop}
        onSave={noop}
        onReloadFromDisk={noop}
        onKeepDraft={noop}
        onAcceptFile={noop}
        onRejectFile={noop}
        onVisibleFileChange={noop}
        scrollContainerRef={scrollContainerRef}
        editorViewMapRef={editorViewMapRef}
        isProgrammaticScroll={isProgrammaticScroll}
        teamName="test-team"
        memberName="test-member"
        fetchFileContent={async () => undefined}
      />
    );
    const hunkKey = `${file.filePath}:0`;

    await act(async () =>
      root.render(
        renderView(
          {
            hunkDecisions: { [hunkKey]: 'accepted' },
            hunkContextHashesByFile: { [file.filePath]: { 0: 'old-hash' } },
          },
          0
        )
      )
    );
    expect(replaySpies.replayHunkDecisionsSmart).toHaveBeenLastCalledWith(
      expect.anything(),
      file.filePath,
      { [hunkKey]: 'accepted' },
      { 0: 'old-hash' }
    );

    vi.clearAllMocks();
    await act(async () => root.render(renderView({}, 1)));
    expect(replaySpies.replayHunkDecisionsSmart).toHaveBeenLastCalledWith(
      expect.anything(),
      file.filePath,
      {},
      undefined
    );

    vi.clearAllMocks();
    await act(async () =>
      root.render(
        renderView(
          {
            editedContents: { [file.filePath]: 'draft' },
            fileDecisions: { [file.filePath]: 'accepted' },
          },
          2
        )
      )
    );
    expect(replaySpies.acceptAllChunks).not.toHaveBeenCalled();

    await act(async () =>
      root.render(renderView({ fileDecisions: { [file.filePath]: 'accepted' } }, 3))
    );
    expect(replaySpies.acceptAllChunks).toHaveBeenCalledTimes(1);

    await act(async () => root.unmount());
    container.remove();
  });

  it('ignores stale selection cleanup from a different file editor', async () => {
    const secondFile: FileChangeSummary = {
      ...file,
      filePath: '/repo/second.ts',
      relativePath: 'second.ts',
    };
    const secondContent: FileChangeWithContent = { ...fileContent, ...secondFile };
    const onSelectionChange = vi.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () =>
      root.render(
        <ContinuousScrollView
          files={[file, secondFile]}
          fileContents={{
            [file.filePath]: fileContent,
            [secondFile.filePath]: secondContent,
          }}
          fileContentsLoading={{}}
          reviewExternalChangesByFile={{}}
          viewedSet={new Set()}
          editedContents={{}}
          draftHistoryEntries={{}}
          hunkDecisions={{}}
          fileDecisions={{}}
          hunkContextHashesByFile={{}}
          collapseUnchanged={false}
          applying={false}
          autoViewed={false}
          discardCounters={{}}
          onHunkAccepted={noop}
          onHunkRejected={noop}
          onFullyViewed={noop}
          onContentChanged={noop}
          onSerializedStateChanged={noop}
          onSerializedStateRestoreError={noop}
          onDiscard={noop}
          onSave={noop}
          onReloadFromDisk={noop}
          onKeepDraft={noop}
          onAcceptFile={noop}
          onRejectFile={noop}
          onVisibleFileChange={noop}
          scrollContainerRef={React.createRef<HTMLDivElement>()}
          editorViewMapRef={{ current: new Map<string, EditorView>() }}
          isProgrammaticScroll={{ current: false }}
          teamName="test-team"
          memberName="test-member"
          fetchFileContent={async () => undefined}
          onSelectionChange={onSelectionChange}
        />
      )
    );

    const firstSelection: EditorSelectionInfo = {
      text: 'first',
      filePath: file.filePath,
      fromLine: 1,
      toLine: 1,
      screenRect: { top: 1, right: 2, bottom: 3 },
    };
    const secondSelection: EditorSelectionInfo = {
      ...firstSelection,
      text: 'second',
      filePath: secondFile.filePath,
    };
    act(() => replaySpies.selectionCallbacks.get(file.filePath)?.(firstSelection));
    act(() => replaySpies.selectionCallbacks.get(secondFile.filePath)?.(secondSelection));
    act(() => replaySpies.selectionCallbacks.get(file.filePath)?.(null));

    expect(onSelectionChange).toHaveBeenCalledTimes(2);
    expect(onSelectionChange).toHaveBeenLastCalledWith(secondSelection);

    act(() => replaySpies.selectionCallbacks.get(secondFile.filePath)?.(null));
    expect(onSelectionChange).toHaveBeenLastCalledWith(null);

    await act(async () => root.unmount());
    container.remove();
  });
});
