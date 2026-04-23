import React, { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getStoredCreateTeamMemberRuntimePreferences } from '@renderer/services/createTeamPreferences';

const { loadSnapshotMock, saveSnapshotMock, deleteSnapshotMock } = vi.hoisted(() => ({
  loadSnapshotMock: vi.fn(),
  saveSnapshotMock: vi.fn(),
  deleteSnapshotMock: vi.fn(),
}));

vi.mock('@renderer/services/createTeamDraftStorage', () => ({
  createTeamDraftStorage: {
    loadSnapshot: loadSnapshotMock,
    saveSnapshot: saveSnapshotMock,
    deleteSnapshot: deleteSnapshotMock,
  },
}));

import { useCreateTeamDraft } from './useCreateTeamDraft';

function HookProbe({ onLoaded }: { onLoaded: () => void }): React.JSX.Element | null {
  const draft = useCreateTeamDraft();

  useEffect(() => {
    if (draft.isLoaded) {
      onLoaded();
    }
  }, [draft.isLoaded, onLoaded]);

  return null;
}

function HookProbeWithDraft({
  onLoaded,
}: {
  onLoaded: (draft: ReturnType<typeof useCreateTeamDraft>) => void;
}): React.JSX.Element | null {
  const draft = useCreateTeamDraft();

  useEffect(() => {
    if (draft.isLoaded) {
      onLoaded(draft);
    }
  }, [draft, onLoaded]);

  return null;
}

describe('useCreateTeamDraft', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    loadSnapshotMock.mockReset();
    saveSnapshotMock.mockReset();
    deleteSnapshotMock.mockReset();
    localStorage.clear();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
  });

  it('migrates stored sync=false snapshots into create-team preferences', async () => {
    loadSnapshotMock.mockResolvedValue({
      version: 1,
      teamName: 'team-alpha',
      members: [
        {
          id: 'member-1',
          name: 'alice',
          roleSelection: 'developer',
          customRole: '',
          providerId: 'codex',
          model: 'gpt-5',
          effort: 'high',
        },
      ],
      syncModelsWithLead: false,
      teammateWorktreeDefault: false,
      cwdMode: 'project',
      selectedProjectPath: '',
      customCwd: '',
      soloTeam: false,
      launchTeam: true,
      teamColor: '',
      updatedAt: Date.now(),
    });

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onLoaded = vi.fn();

    await act(async () => {
      root.render(React.createElement(HookProbe, { onLoaded }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onLoaded).toHaveBeenCalled();
    expect(localStorage.getItem('createTeam:lastSyncModelsWithLead')).toBe('false');
    expect(getStoredCreateTeamMemberRuntimePreferences()).toEqual([
      { name: 'alice', providerId: 'codex', model: 'gpt-5', effort: 'high' },
    ]);

    act(() => {
      root.unmount();
    });
  });

  it('can update sync state without mutating the saved create-team default', async () => {
    loadSnapshotMock.mockResolvedValue(null);
    localStorage.setItem('createTeam:lastSyncModelsWithLead', 'true');

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    let loadedDraft: ReturnType<typeof useCreateTeamDraft> | null = null;

    await act(async () => {
      root.render(
        React.createElement(HookProbeWithDraft, {
          onLoaded: (draft) => {
            loadedDraft = draft;
          },
        })
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(loadedDraft).not.toBeNull();

    act(() => {
      loadedDraft?.setSyncModelsWithLead(false, { persistStoredPreference: false });
    });

    expect(localStorage.getItem('createTeam:lastSyncModelsWithLead')).toBe('true');

    act(() => {
      root.unmount();
    });
  });
});
