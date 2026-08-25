import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { useChangeReviewExternalChangeController } from '@features/change-review/renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  ChangeReviewExternalChangeController,
  ChangeReviewExternalChangePolicy,
  ChangeReviewExternalChangeStatePort,
  ChangeReviewExternalFileWatcherPort,
} from '@features/change-review/renderer';
import type { ReviewDraftHistoryEntry } from '@features/change-review-history/contracts';
import type { EditorFileChangeEvent } from '@shared/types';

interface Harness {
  listener: ((event: EditorFileChangeEvent) => void) | null;
  snapshot: ReturnType<ChangeReviewExternalChangeStatePort['getSnapshot']>;
  statePort: ChangeReviewExternalChangeStatePort;
  watcherPort: ChangeReviewExternalFileWatcherPort;
  policy: ChangeReviewExternalChangePolicy;
}

function makeEntry(filePath: string): ReviewDraftHistoryEntry {
  return {
    filePath,
    codec: 'codemirror-history-v1',
    revision: 1,
    generation: 'generation-1',
    diskBaseline: 'disk',
    editorState: { doc: 'durable draft', history: { done: [], undone: [] } },
    updatedAt: '2026-07-24T00:00:00.000Z',
  };
}

function createHarness(): Harness {
  let listener: ((event: EditorFileChangeEvent) => void) | null = null;
  const snapshot: Harness['snapshot'] = {
    activeChangeSet: { files: [{ filePath: '/repo/a.ts' }] },
    editedContents: {},
    reviewExternalChangesByFile: {},
  };
  const statePort: ChangeReviewExternalChangeStatePort = {
    getSnapshot: () => snapshot,
    restoreDraft: vi.fn(),
    markExternalChange: vi.fn(),
    reportError: vi.fn(),
  };
  const watcherPort: ChangeReviewExternalFileWatcherPort = {
    checkConflict: vi.fn(() =>
      Promise.resolve({
        hasConflict: false,
        conflictContent: null,
        currentContent: 'after',
        originalContent: 'before',
      })
    ),
    subscribe: vi.fn((nextListener: (event: EditorFileChangeEvent) => void) => {
      listener = nextListener;
      return vi.fn();
    }),
    watchFiles: vi.fn(() => Promise.resolve()),
    unwatchFiles: vi.fn(() => Promise.resolve()),
  };
  const policy: ChangeReviewExternalChangePolicy = {
    hasUnresolvedExternalChange: (filePath, changes) => filePath in changes,
  };
  return {
    get listener() {
      return listener;
    },
    set listener(nextListener) {
      listener = nextListener;
    },
    snapshot,
    statePort,
    watcherPort,
    policy,
  };
}

let latest: ChangeReviewExternalChangeController | null = null;

function Probe({ harness }: Readonly<{ harness: Harness }>): React.JSX.Element {
  latest = useChangeReviewExternalChangeController({
    open: true,
    enabled: true,
    projectPath: '/repo',
    watchedFilePathsKey: '/repo/a.ts',
    reviewScope: { teamName: 'team' },
    externalChangesByFile: {},
    recentWritesRef: { current: new Map() },
    isMutationInFlight: () => false,
    getDraftHistoryEntry: (filePath) =>
      filePath === '/repo/a.ts' ? makeEntry(filePath) : undefined,
    statePort: harness.statePort,
    policy: harness.policy,
    watcherPort: harness.watcherPort,
  });
  return <div />;
}

describe('useChangeReviewExternalChangeController', () => {
  afterEach(() => {
    latest = null;
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('restores a durable draft and blocks mutations using the live external-change map', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const harness = createHarness();
    const root = createRoot(document.body.appendChild(document.createElement('div')));

    await act(async () => {
      root.render(<Probe harness={harness} />);
      await Promise.resolve();
    });
    expect(latest!.reviewMutationBlockedByExternalChange).toBe(false);

    const subscribedListener = harness.listener!;
    harness.snapshot.activeChangeSet = { files: [{ filePath: '/repo/b.ts' }] };
    act(() => subscribedListener({ type: 'create', path: '/repo/a.ts' }));
    expect(harness.statePort.restoreDraft).not.toHaveBeenCalled();
    expect(harness.statePort.markExternalChange).not.toHaveBeenCalled();

    harness.snapshot.activeChangeSet = { files: [{ filePath: '/repo/a.ts' }] };
    act(() => harness.listener?.({ type: 'create', path: '/repo/a.ts' }));

    expect(harness.statePort.restoreDraft).toHaveBeenCalledWith('/repo/a.ts', 'durable draft');
    expect(harness.statePort.markExternalChange).toHaveBeenCalledWith('/repo/a.ts', 'add');
    expect(harness.statePort.reportError).toHaveBeenCalledWith(
      'A reviewed file changed outside Changes. Reload it from disk before continuing review actions.'
    );

    harness.snapshot.reviewExternalChangesByFile = { '/repo/a.ts': { type: 'add' } };
    expect(latest!.blockReviewMutationForExternalChange('/repo/a.ts')).toBe(true);
    expect(harness.statePort.reportError).toHaveBeenLastCalledWith(
      'Reload files changed outside Changes before continuing review actions.'
    );

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    vi.mocked(harness.statePort.markExternalChange).mockClear();
    act(() => subscribedListener({ type: 'delete', path: '/repo/a.ts' }));
    expect(harness.statePort.markExternalChange).not.toHaveBeenCalled();
  });
});
