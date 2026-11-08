import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadSnapshot: vi.fn(),
  loadDraft: vi.fn(),
}));

vi.mock('@renderer/services/createTeamDraftStorage', () => ({
  createTeamDraftStorage: { loadSnapshot: mocks.loadSnapshot },
}));
vi.mock('@renderer/services/draftStorage', () => ({
  draftStorage: { loadDraft: mocks.loadDraft },
}));

import { hasUnfinishedCreateTeamDraft } from './useCreateTeamDraftAvailability';

describe('unfinished team creation detection', () => {
  beforeEach(() => {
    mocks.loadSnapshot.mockReset().mockResolvedValue(null);
    mocks.loadDraft.mockReset().mockResolvedValue(null);
  });

  it('detects an unfinished description-only draft', async () => {
    mocks.loadDraft.mockImplementation(async (key: string) =>
      key === 'createTeam:description' ? 'Important team notes' : null
    );
    await expect(hasUnfinishedCreateTeamDraft()).resolves.toBe(true);
  });

  it('detects prompt chips even with an empty form snapshot', async () => {
    mocks.loadDraft.mockImplementation(async (key: string) =>
      key === 'createTeam:prompt:chips' ? '[{"id":"chip"}]' : null
    );
    await expect(hasUnfinishedCreateTeamDraft()).resolves.toBe(true);
  });

  it('does not treat empty content or an empty chip array as an unfinished draft', async () => {
    mocks.loadDraft.mockImplementation(async (key: string) =>
      key === 'createTeam:prompt:chips' ? '[]' : '  '
    );
    await expect(hasUnfinishedCreateTeamDraft()).resolves.toBe(false);
  });

  it('detects form-only input without a name or members', async () => {
    mocks.loadSnapshot.mockResolvedValue({ teamName: '', members: [], teamColor: 'blue' });
    await expect(hasUnfinishedCreateTeamDraft()).resolves.toBe(true);
  });

  it('preserves project-only and config-only settings without a team name', async () => {
    mocks.loadSnapshot.mockResolvedValue({
      teamName: '',
      members: [],
      selectedProjectPath: '/sandbox/important-project',
    });
    await expect(hasUnfinishedCreateTeamDraft()).resolves.toBe(true);
    mocks.loadSnapshot.mockResolvedValue({
      teamName: '',
      members: [],
      launchTeam: false,
    });
    await expect(hasUnfinishedCreateTeamDraft()).resolves.toBe(true);
  });
});
