import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ContinuousScrollView } from '../../../../../src/renderer/components/team/review/ContinuousScrollView';
import { ReviewFileTree } from '../../../../../src/renderer/components/team/review/ReviewFileTree';
import { TooltipProvider } from '../../../../../src/renderer/components/ui/tooltip';

import type { FileChangeSummary } from '@shared/types/review';

const hoisted = vi.hoisted(() => ({
  lazyPaths: [] as string[],
}));

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@renderer/store', () => ({
  useStore: (selector: (state: unknown) => unknown) =>
    selector({
      setFileChunkCount: vi.fn(),
      fileChunkCounts: {},
      hunkDecisions: {},
      fileDecisions: {},
    }),
}));
vi.mock('@renderer/hooks/useLazyFileContent', () => ({
  useLazyFileContent: (options: { filePaths: string[] }) => {
    hoisted.lazyPaths = options.filePaths;
    return { registerLazyRef: () => () => undefined };
  },
}));
vi.mock('@renderer/hooks/useVisibleFileSection', () => ({
  useVisibleFileSection: () => ({ registerFileSectionRef: () => () => undefined }),
}));
vi.mock('@renderer/components/team/review/FileSectionDiff', () => ({
  FileSectionDiff: ({
    file,
    fileContent,
    onHunkRejected,
  }: {
    file: { filePath: string };
    fileContent?: { modifiedFullContent?: string };
    onHunkRejected: (
      filePath: string,
      index: number,
      before: string,
      after: string
    ) => boolean | void;
  }) => (
    <div data-review-content>
      <span data-review-text>{fileContent?.modifiedFullContent}</span>
      <button
        data-test-hunk-reject
        onClick={() => onHunkRejected(file.filePath, 0, 'before', 'after')}
      >
        Reject hunk
      </button>
    </div>
  ),
}));

const filePath = '/repo/new.ts';
const files: FileChangeSummary[] = [
  {
    filePath,
    relativePath: 'new.ts',
    changeKey: 'rename:/repo/old.ts->/repo/new.ts',
    snippets: [],
    linesAdded: 1,
    linesRemoved: 1,
    isNewFile: false,
  },
  {
    filePath,
    relativePath: 'new.ts',
    changeKey: 'path:/repo/new.ts',
    snippets: [],
    linesAdded: 1,
    linesRemoved: 1,
    isNewFile: false,
  },
];
for (const [index, file] of files.entries()) {
  file.snippets.push({
    toolUseId: `event-${index}`,
    filePath,
    toolName: 'Edit',
    type: 'edit',
    oldString: 'old',
    newString: 'new',
    replaceAll: false,
    timestamp: '2026-09-28T00:00:00Z',
    isError: false,
    ledger: {
      eventId: `event-${index}`,
      source: 'ledger-exact',
      confidence: 'exact',
      originalFullContent: 'old',
      modifiedFullContent: 'new',
      beforeHash: null,
      afterHash: null,
    },
  });
}

describe('duplicate review entries', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    vi.unstubAllGlobals();
  });

  it('shows separate content slots and sends each file action through its change key', () => {
    const root = createRoot(container);
    const onAcceptFile = vi.fn();
    const onRejectFile = vi.fn();
    const onHunkRejected = vi.fn();
    act(() =>
      root.render(
        <TooltipProvider>
          <ContinuousScrollView
            files={files}
            fileContents={{
              [files[0].changeKey!]: {
                ...files[0],
                originalFullContent: 'old',
                modifiedFullContent: 'renamed',
                contentSource: 'ledger-exact',
              },
              [files[1].changeKey!]: {
                ...files[1],
                originalFullContent: 'renamed',
                modifiedFullContent: 'edited',
                contentSource: 'ledger-exact',
              },
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
            onHunkAccepted={vi.fn()}
            onHunkRejected={onHunkRejected}
            onFullyViewed={vi.fn()}
            onContentChanged={vi.fn()}
            onSerializedStateChanged={vi.fn()}
            onSerializedStateRestoreError={vi.fn()}
            onDiscard={vi.fn()}
            onSave={vi.fn()}
            onReloadFromDisk={vi.fn()}
            onKeepDraft={vi.fn()}
            onAcceptFile={onAcceptFile}
            onRejectFile={onRejectFile}
            onVisibleFileChange={vi.fn()}
            scrollContainerRef={{ current: null }}
            editorViewMapRef={{ current: new Map() }}
            isProgrammaticScroll={{ current: false }}
            teamName="team-a"
            memberName="alice"
            fetchFileContent={vi.fn()}
          />
        </TooltipProvider>
      )
    );

    expect(hoisted.lazyPaths).toEqual(files.map((file) => file.changeKey));
    expect(
      [...container.querySelectorAll('[data-review-text]')].map((node) => node.textContent)
    ).toEqual(['renamed', 'edited']);
    const accepts = [...container.querySelectorAll<HTMLButtonElement>('button')].filter((button) =>
      button.textContent?.includes('review.fileHeader.actions.accept')
    );
    const rejects = [...container.querySelectorAll<HTMLButtonElement>('button')].filter((button) =>
      button.textContent?.includes('review.fileHeader.actions.reject')
    );
    expect(accepts).toHaveLength(2);
    act(() => {
      accepts[0].click();
      accepts[1].click();
      rejects[1].click();
    });
    expect(onAcceptFile.mock.calls).toEqual([[files[0].changeKey], [files[1].changeKey]]);
    expect(onRejectFile).toHaveBeenCalledWith(files[1].changeKey);
    act(() => container.querySelector<HTMLButtonElement>('[data-test-hunk-reject]')?.click());
    expect(onHunkRejected).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it('keeps both tree leaves selectable despite an identical destination path', () => {
    const root = createRoot(container);
    const onSelectFile = vi.fn();
    act(() =>
      root.render(
        <TooltipProvider>
          <ReviewFileTree files={files} selectedFilePath={null} onSelectFile={onSelectFile} />
        </TooltipProvider>
      )
    );
    const leaves = [...container.querySelectorAll<HTMLButtonElement>('[data-tree-file]')];
    expect(leaves.map((leaf) => leaf.dataset.treeFile)).toEqual(
      files.map((file) => file.changeKey)
    );
    act(() => {
      leaves[0].click();
      leaves[1].click();
    });
    expect(onSelectFile.mock.calls).toEqual([[files[0].changeKey], [files[1].changeKey]]);
    act(() => root.unmount());
  });
});
