import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { useChangeReviewExternalFileWatcher } from '@features/change-review/renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  ChangeReviewExternalFileWatcherPort,
  ChangeReviewRecentWrite,
} from '@features/change-review/renderer';
import type { EditorFileChangeEvent } from '@shared/types';

interface Harness {
  listener: ((event: EditorFileChangeEvent) => void) | null;
  mutationInFlight: boolean;
  recentWritesRef: { current: Map<string, ChangeReviewRecentWrite> };
  processExternalChange: ReturnType<typeof vi.fn>;
  unsubscribe: ReturnType<typeof vi.fn>;
  port: ChangeReviewExternalFileWatcherPort;
}

function createHarness(): Harness {
  const harness = {
    listener: null,
    mutationInFlight: false,
    recentWritesRef: { current: new Map<string, ChangeReviewRecentWrite>() },
    processExternalChange: vi.fn(),
    unsubscribe: vi.fn(),
  } as Harness;
  harness.port = {
    checkConflict: vi.fn(() =>
      Promise.resolve({
        hasConflict: false,
        conflictContent: null,
        currentContent: 'after',
        originalContent: 'before',
      })
    ),
    subscribe: vi.fn((listener: (event: EditorFileChangeEvent) => void) => {
      harness.listener = listener;
      return harness.unsubscribe;
    }),
    watchFiles: vi.fn(() => Promise.resolve()),
    unwatchFiles: vi.fn(() => Promise.resolve()),
  };
  return harness;
}

function Probe({ harness }: Readonly<{ harness: Harness }>): React.JSX.Element {
  useChangeReviewExternalFileWatcher({
    open: true,
    enabled: true,
    projectPath: '/repo',
    watchedFilePathsKey: '/repo/a.ts\0/repo/b.ts',
    reviewScope: { teamName: 'team' },
    recentWritesRef: harness.recentWritesRef,
    isMutationInFlight: () => harness.mutationInFlight,
    processExternalChange: harness.processExternalChange,
    port: harness.port,
  });
  return <div />;
}

async function flushAsyncWork(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('useChangeReviewExternalFileWatcher', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('watches exact paths and suppresses verified local writes', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.setSystemTime(3000);
    const harness = createHarness();
    harness.recentWritesRef.current.set('/repo/a.ts', {
      at: 2500,
      expectedContent: 'after',
    });
    const root = createRoot(document.body.appendChild(document.createElement('div')));

    act(() => root.render(<Probe harness={harness} />));
    expect(harness.port.watchFiles).toHaveBeenCalledWith('/repo', ['/repo/a.ts', '/repo/b.ts']);

    act(() => harness.listener?.({ type: 'change', path: '/repo/a.ts' }));
    await flushAsyncWork();

    expect(harness.port.checkConflict).toHaveBeenCalledWith(
      { teamName: 'team' },
      '/repo/a.ts',
      'after'
    );
    expect(harness.processExternalChange).not.toHaveBeenCalled();
    expect(harness.recentWritesRef.current.has('/repo/a.ts')).toBe(true);

    act(() => root.unmount());
    expect(harness.unsubscribe).toHaveBeenCalledOnce();
    expect(harness.port.unwatchFiles).toHaveBeenCalledOnce();
  });

  it('retries busy writes and reports a mismatched external change', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers();
    vi.setSystemTime(3000);
    const harness = createHarness();
    harness.mutationInFlight = true;
    harness.recentWritesRef.current.set('/repo/a.ts', {
      at: 2500,
      expectedContent: 'after',
    });
    vi.mocked(harness.port.checkConflict).mockResolvedValue({
      hasConflict: true,
      conflictContent: 'external',
      currentContent: 'external',
      originalContent: 'before',
    });
    const root = createRoot(document.body.appendChild(document.createElement('div')));

    act(() => root.render(<Probe harness={harness} />));
    act(() => harness.listener?.({ type: 'change', path: '/repo/a.ts' }));
    expect(harness.port.checkConflict).not.toHaveBeenCalled();

    harness.mutationInFlight = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(25);
    });
    await flushAsyncWork();

    expect(harness.processExternalChange).toHaveBeenCalledWith({
      type: 'change',
      path: '/repo/a.ts',
    });
    expect(harness.recentWritesRef.current.has('/repo/a.ts')).toBe(false);
    act(() => root.unmount());
  });
});
