import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { ContinuousScrollView } from '@renderer/components/team/review/ContinuousScrollView';
import { getReviewEntryKey } from '@renderer/utils/reviewKey';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EditorView } from '@codemirror/view';
import type { FileChangeWithContent } from '@shared/types';
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

function makeFile(filePath: string, changeKey: string, relativePath = 'new.ts'): FileChangeSummary {
  return {
    filePath,
    changeKey,
    relativePath,
    snippets: [],
    linesAdded: 1,
    linesRemoved: 1,
    isNewFile: false,
  };
}

function makeContents(files: FileChangeSummary[]): Record<string, FileChangeWithContent> {
  return Object.fromEntries(
    files.map((file) => [
      getReviewEntryKey(files, file),
      {
        ...file,
        originalFullContent: 'before\n',
        modifiedFullContent: 'after\n',
        contentSource: 'ledger-exact',
      },
    ])
  );
}

describe('duplicate review editable owner', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let editorViewMapRef: { current: Map<string, EditorView> };

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    editorViewMapRef = { current: new Map() };
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  function mount(
    files: FileChangeSummary[],
    sourceFiles: FileChangeSummary[],
    onContentChanged: (filePath: string, content: string) => void,
    editedContents: Record<string, string> = {}
  ): void {
    act(() =>
      root.render(
        <ContinuousScrollView
          files={files}
          sourceFiles={sourceFiles}
          fileContents={makeContents(files)}
          fileContentsLoading={{}}
          reviewExternalChangesByFile={{}}
          viewedSet={new Set()}
          editedContents={editedContents}
          draftHistoryEntries={{}}
          hunkDecisions={{}}
          fileDecisions={{}}
          hunkContextHashesByFile={{}}
          collapseUnchanged={false}
          applying={false}
          autoViewed={false}
          discardCounters={{}}
          onHunkAccepted={vi.fn()}
          onHunkRejected={vi.fn()}
          onFullyViewed={vi.fn()}
          onContentChanged={onContentChanged}
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
        />
      )
    );
  }

  it('keeps the latest source entry editable even when visual order is reversed', () => {
    const diskPath = '/sandbox/review/new.ts';
    const copy = makeFile(
      diskPath,
      'copy:/sandbox/review/source.ts->/sandbox/review/new.ts',
      'z/new.ts'
    );
    const edit = makeFile(diskPath, 'path:/sandbox/review/new.ts', 'a/new.ts');
    let sharedDraft: string | undefined;
    const onContentChanged = vi.fn((_path: string, content: string) => {
      sharedDraft = content;
    });

    mount([edit, copy], [copy, edit], onContentChanged);
    const editView = editorViewMapRef.current.get(edit.changeKey!);
    const copyView = editorViewMapRef.current.get(copy.changeKey!);
    expect(editView).toBeDefined();
    expect(copyView).toBeDefined();
    expect(editView!.state.readOnly).toBe(false);
    expect(copyView!.state.readOnly).toBe(true);
    expect(container.textContent).toContain('latest change for this file');

    act(() => editView!.dispatch({ changes: { from: editView!.state.doc.length, insert: 'A' } }));
    expect(sharedDraft).toBe('after\nA');
    expect(onContentChanged).toHaveBeenCalledTimes(1);
    mount([edit, copy], [copy, edit], onContentChanged, { [diskPath]: sharedDraft! });
    expect(editorViewMapRef.current.get(copy.changeKey!)?.state.doc.toString()).toBe('after\n');

    // Programmatic updates still reach a mounted CodeMirror; the inactive sibling
    // must never publish that document into the shared physical-path draft.
    act(() => copyView!.dispatch({ changes: { from: copyView!.state.doc.length, insert: 'B' } }));
    expect(sharedDraft).toBe('after\nA');
    expect(onContentChanged).toHaveBeenCalledTimes(1);
  });

  it('keeps separate case-distinct paths editable', () => {
    const upper = makeFile('C:/sandbox/Foo.ts', 'path:C:/sandbox/Foo.ts', 'Foo.ts');
    const lower = makeFile('C:/sandbox/foo.ts', 'path:C:/sandbox/foo.ts', 'foo.ts');
    const onContentChanged = vi.fn();

    mount([upper, lower], [upper, lower], onContentChanged);
    expect(editorViewMapRef.current.get(upper.filePath)?.state.readOnly).toBe(false);
    expect(editorViewMapRef.current.get(lower.filePath)?.state.readOnly).toBe(false);
    const lowerView = editorViewMapRef.current.get(lower.filePath)!;
    act(() =>
      lowerView.dispatch({ changes: { from: lowerView.state.doc.length, insert: 'edit' } })
    );
    expect(onContentChanged).toHaveBeenCalledWith(lower.filePath, 'after\nedit', 'after\n');
  });
});
