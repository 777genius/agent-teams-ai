import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { useChangeReviewDialogViewState } from '@features/change-review/renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  ChangeReviewCollapsedFilesStoragePort,
  ChangeReviewDialogViewStatePolicy,
} from '@features/change-review/renderer';
import type { AgentChangeSet, FileChangeSummary, ReviewUndoAction } from '@shared/types';

const files: FileChangeSummary[] = [
  {
    filePath: '/repo/b.ts',
    relativePath: 'b.ts',
    snippets: [],
    linesAdded: 1,
    linesRemoved: 0,
    isNewFile: false,
  },
  {
    filePath: '/repo/a.ts',
    relativePath: 'a.ts',
    snippets: [],
    linesAdded: 1,
    linesRemoved: 0,
    isNewFile: false,
  },
];
const changeSet: AgentChangeSet = {
  teamName: 'team',
  memberName: 'alice',
  files,
  totalLinesAdded: 2,
  totalLinesRemoved: 0,
  totalFiles: 2,
  computedAt: '2026-07-24T00:00:00.000Z',
};
const action = {} as ReviewUndoAction;

let latestResult: ReturnType<typeof useChangeReviewDialogViewState> | null = null;

function Probe({
  storage,
  policy,
  reportError,
}: Readonly<{
  storage: ChangeReviewCollapsedFilesStoragePort;
  policy: ChangeReviewDialogViewStatePolicy;
  reportError: (message: string) => void;
}>): React.JSX.Element {
  latestResult = useChangeReviewDialogViewState({
    open: true,
    hasData: true,
    teamName: 'team',
    scopeKey: 'scope',
    collapseStorageKey: 'collapsed',
    initialFilePath: undefined,
    activeChangeSet: changeSet,
    fileContents: {},
    fileContentsLoading: {},
    storage,
    policy,
    reportError,
  });
  return <div />;
}

describe('useChangeReviewDialogViewState', () => {
  afterEach(() => {
    latestResult = null;
    document.body.innerHTML = '';
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('owns sorted navigation and pruned collapse persistence', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers();
    const storage: ChangeReviewCollapsedFilesStoragePort = {
      read: vi.fn(() => new Set(['/repo/b.ts', '/repo/stale.ts'])),
      write: vi.fn(),
    };
    let requestedHistoryPath = '/repo/b.ts';
    const policy: ChangeReviewDialogViewStatePolicy = {
      buildInitialScrollKey: () => null,
      getHistoryActionFilePath: () => requestedHistoryPath,
      resolveFilePath: (candidates, requestedPath) =>
        candidates.find((candidate) => candidate.filePath === requestedPath)?.filePath ?? null,
    };
    const reportError = vi.fn();
    const root = createRoot(document.body.appendChild(document.createElement('div')));

    act(() => root.render(<Probe storage={storage} policy={policy} reportError={reportError} />));
    expect(latestResult?.sortedFiles.map((candidate) => candidate.filePath)).toEqual([
      '/repo/a.ts',
      '/repo/b.ts',
    ]);
    expect(latestResult?.collapsedFiles).toEqual(new Set(['/repo/b.ts']));

    act(() => latestResult?.handleHistoryActionNavigation(action));
    expect(latestResult?.activeFilePath).toBe('/repo/b.ts');

    requestedHistoryPath = '/repo/missing.ts';
    act(() => latestResult?.handleHistoryActionNavigation(action));
    expect(reportError).toHaveBeenCalledWith(
      'The file from this review action is no longer in the current change set.'
    );

    act(() => latestResult?.toggleCollapsedFile('/repo/b.ts'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(storage.write).toHaveBeenLastCalledWith('collapsed', new Set());
    act(() => root.unmount());
  });
});
