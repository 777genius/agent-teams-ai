import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ContinuousScrollView } from '../../../../../src/renderer/components/team/review/ContinuousScrollView';

import type { EditorView } from '@codemirror/view';
import type { FileChangeSummary } from '@shared/types/review';

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@renderer/store', () => ({
  useStore: (selector: (state: unknown) => unknown) =>
    selector({ setFileChunkCount: vi.fn(), fileChunkCounts: {} }),
}));
vi.mock('@renderer/hooks/useLazyFileContent', () => ({
  useLazyFileContent: () => ({ registerLazyRef: () => () => undefined }),
}));
vi.mock('@renderer/hooks/useVisibleFileSection', () => ({
  useVisibleFileSection: () => ({ registerFileSectionRef: () => () => undefined }),
}));
vi.mock('@renderer/components/team/review/FileSectionHeader', () => ({
  FileSectionHeader: () => null,
}));
vi.mock('@renderer/components/team/review/CodeMirrorDiffUtils', () => ({
  getChunks: () => null,
  acceptAllChunks: () => undefined,
  rejectAllChunks: (view: EditorView) =>
    (view as EditorView & { replaceDocument: (value: string) => void }).replaceDocument(
      'original baseline'
    ),
  replayHunkDecisionsSmart: () => undefined,
}));
vi.mock('@renderer/components/team/review/FileSectionDiff', async () => {
  const React = await import('react');
  return {
    FileSectionDiff: ({
      file,
      draftContent,
      onEditorViewReady,
    }: {
      file: FileChangeSummary;
      draftContent?: string;
      onEditorViewReady: (filePath: string, view: EditorView | null) => void;
    }) => {
      const [document, setDocument] = React.useState(draftContent ?? 'reviewed content');
      const view = React.useMemo(
        () => ({ state: {}, replaceDocument: setDocument }) as unknown as EditorView,
        []
      );
      React.useEffect(() => {
        onEditorViewReady(file.filePath, view);
        return () => onEditorViewReady(file.filePath, null);
      }, [file.filePath, onEditorViewReady, view]);
      React.useEffect(() => {
        if (draftContent !== undefined) setDocument(draftContent);
      }, [draftContent]);
      return <span data-editor-entry={file.changeKey}>{document}</span>;
    },
  };
});

const filePath = '/TEST/review/new.ts';
const files: FileChangeSummary[] = [
  {
    filePath,
    changeKey: 'rename:/TEST/review/old.ts->/TEST/review/new.ts',
    relativePath: 'new.ts',
    snippets: [],
    linesAdded: 1,
    linesRemoved: 1,
    isNewFile: false,
  },
  {
    filePath,
    changeKey: 'path:/TEST/review/new.ts',
    relativePath: 'new.ts',
    snippets: [],
    linesAdded: 1,
    linesRemoved: 1,
    isNewFile: false,
  },
];

describe('duplicate review editor remount', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let frames: FrameRequestCallback[];
  const editorViewMapRef = { current: new Map<string, EditorView>() };

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    frames = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    editorViewMapRef.current.clear();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  function render(collapsed: boolean, editedContents: Record<string, string>): void {
    act(() =>
      root.render(
        <ContinuousScrollView
          files={files}
          fileContents={{}}
          fileContentsLoading={{}}
          reviewExternalChangesByFile={{}}
          viewedSet={new Set()}
          editedContents={editedContents}
          draftHistoryEntries={{}}
          hunkDecisions={{}}
          fileDecisions={{ [files[1].changeKey!]: 'rejected' }}
          hunkContextHashesByFile={{}}
          collapseUnchanged={false}
          applying={false}
          autoViewed={false}
          discardCounters={{}}
          onHunkAccepted={vi.fn()}
          onHunkRejected={vi.fn()}
          onFullyViewed={vi.fn()}
          onContentChanged={vi.fn()}
          onSerializedStateChanged={vi.fn()}
          onSerializedStateRestoreError={vi.fn()}
          onDiscard={vi.fn()}
          onSave={vi.fn()}
          onReloadFromDisk={vi.fn()}
          onKeepDraft={vi.fn()}
          onAcceptFile={vi.fn()}
          onRejectFile={vi.fn()}
          onVisibleFileChange={vi.fn()}
          scrollContainerRef={{ current: null }}
          editorViewMapRef={editorViewMapRef}
          isProgrammaticScroll={{ current: false }}
          teamName="test-team"
          memberName="test-member"
          fetchFileContent={vi.fn()}
          collapsedFiles={collapsed ? new Set([filePath]) : new Set()}
        />
      )
    );
  }

  function flushFrames(): void {
    act(() => {
      for (const frame of frames.splice(0)) frame(0);
    });
  }

  function editedEntryText(): string | null {
    return (
      container.querySelector(`[data-editor-entry="${files[1].changeKey}"]`)?.textContent ?? null
    );
  }

  it('preserves the physical-path draft when a duplicate entry is reopened', () => {
    render(false, { [filePath]: 'manual draft' });
    render(true, { [filePath]: 'manual draft' });
    render(false, { [filePath]: 'manual draft' });
    flushFrames();
    expect(editedEntryText()).toBe('manual draft');
  });

  it('does not replay a queued reject after a draft appears', () => {
    render(false, {});
    render(false, { [filePath]: 'manual draft' });
    flushFrames();
    expect(editedEntryText()).toBe('manual draft');
  });
});
