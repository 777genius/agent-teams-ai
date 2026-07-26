import React, { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ContinuousScrollView } from '../../../../../src/renderer/components/team/review/ContinuousScrollView';

import type { EditorView } from '@codemirror/view';
import type { FileChangeSummary, FileChangeWithContent, HunkDecision } from '@shared/types';

const replaySpies = vi.hoisted(() => ({
  acceptAllChunks: vi.fn(),
  rejectAllChunks: vi.fn(),
  replayHunkDecisionsSmart: vi.fn(),
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
  }: {
    discardCounter: number;
    file: FileChangeSummary;
    onEditorViewReady: (filePath: string, view: EditorView | null) => void;
  }) => {
    useEffect(() => {
      const view = { state: {} } as EditorView;
      onEditorViewReady(file.filePath, view);
      return () => onEditorViewReady(file.filePath, null);
    }, [discardCounter, file.filePath, onEditorViewReady]);
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
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
  });

  it.each([
    { decision: 'accepted' as const, replay: replaySpies.acceptAllChunks },
    { decision: 'rejected' as const, replay: replaySpies.rejectAllChunks },
  ])('does not replay the previous $decision decision after a restore remount', async (testCase) => {
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

    await act(async () =>
      root.render(renderView({ [file.filePath]: testCase.decision }, 0))
    );
    expect(testCase.replay).toHaveBeenCalledTimes(1);
    vi.clearAllMocks();

    await act(async () => root.render(renderView({}, 1)));

    expect(testCase.replay).not.toHaveBeenCalled();
    await act(async () => root.unmount());
    container.remove();
  });
});
