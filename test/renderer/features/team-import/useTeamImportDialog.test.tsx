import React, { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';

import { useTeamImportDialog } from '@features/team-import/renderer/hooks/useTeamImportDialog';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TeamImportPreview } from '@features/team-import/contracts';

const apiMock = vi.hoisted(() => ({
  teamImport: {
    chooseFolderAndPreview: vi.fn(),
    createDraft: vi.fn(),
  },
}));

vi.mock('@renderer/api', () => ({ api: apiMock }));

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function preview(reviewId: string, teamName: string): TeamImportPreview {
  return {
    reviewId,
    suggestedTeamName: teamName,
    projectPath: `/tmp/${teamName}`,
    members: [{ name: 'writer', workflow: `workflow-${teamName}` }],
    prompt: `prompt-${teamName}`,
    skillsFound: [],
    warnings: [],
    blockingErrors: [],
  };
}

function HookProbe({
  open,
  onState,
  onClose,
  onImported,
}: {
  open: boolean;
  onState: (state: ReturnType<typeof useTeamImportDialog>) => void;
  onClose: () => void;
  onImported: (teamName: string) => void;
}): null {
  const state = useTeamImportDialog({
    open,
    onClose,
    onImported,
    inspectErrorFallback: 'inspect failed',
    createErrorFallback: 'create failed',
  });
  useEffect(() => onState(state), [onState, state]);
  return null;
}

describe('useTeamImportDialog', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    apiMock.teamImport.chooseFolderAndPreview.mockReset();
    apiMock.teamImport.createDraft.mockReset();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('keeps only the latest folder preview when requests resolve out of order', async () => {
    const first = createDeferred<TeamImportPreview | null>();
    const second = createDeferred<TeamImportPreview | null>();
    apiMock.teamImport.chooseFolderAndPreview
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const host = document.createElement('div');
    const root = createRoot(host);
    let state!: ReturnType<typeof useTeamImportDialog>;

    await act(async () => {
      root.render(
        <HookProbe
          open
          onState={(next) => {
            state = next;
          }}
          onClose={vi.fn()}
          onImported={vi.fn()}
        />
      );
      await Promise.resolve();
    });
    await act(async () => {
      void state.chooseFolder();
      void state.chooseFolder();
      second.resolve(preview('second', 'second-team'));
      await second.promise;
    });
    await act(async () => {
      first.resolve(preview('first', 'first-team'));
      await first.promise;
    });

    expect(state.preview?.reviewId).toBe('second');
    expect(state.teamName).toBe('second-team');
    act(() => root.unmount());
  });

  it('guards create against double submission and closes only after success', async () => {
    apiMock.teamImport.chooseFolderAndPreview.mockResolvedValue(preview('review-1', 'demo'));
    const create = createDeferred<{ teamName: string }>();
    apiMock.teamImport.createDraft.mockReturnValue(create.promise);
    const onClose = vi.fn();
    const onImported = vi.fn();
    const host = document.createElement('div');
    const root = createRoot(host);
    let state!: ReturnType<typeof useTeamImportDialog>;

    await act(async () => {
      root.render(
        <HookProbe
          open
          onState={(next) => {
            state = next;
          }}
          onClose={onClose}
          onImported={onImported}
        />
      );
      await Promise.resolve();
    });
    await act(async () => {
      await state.chooseFolder();
    });
    await act(async () => {
      void state.createDraft();
      void state.createDraft();
      await Promise.resolve();
    });

    expect(apiMock.teamImport.createDraft).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      create.resolve({ teamName: 'demo' });
      await create.promise;
    });
    expect(onImported).toHaveBeenCalledWith('demo');
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
  });
});
