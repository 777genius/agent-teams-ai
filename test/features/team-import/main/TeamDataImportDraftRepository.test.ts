import { TeamDataImportDraftRepository } from '@features/team-import/main/infrastructure/TeamDataImportDraftRepository';
import { describe, expect, it, vi } from 'vitest';

import type { TeamDataService } from '@main/services/team/TeamDataService';

describe('TeamDataImportDraftRepository', () => {
  it('resumes lifecycle only after the imported draft is created', async () => {
    const createTeamConfig = vi.fn(() => Promise.resolve());
    const onTeamCreated = vi.fn();
    const repository = new TeamDataImportDraftRepository(
      { createTeamConfig } as unknown as TeamDataService,
      onTeamCreated
    );

    await repository.createDraft('imported-team', {
      projectPath: '/tmp/sandbox-project',
      members: [],
      prompt: 'Imported prompt',
    } as never);

    expect(createTeamConfig).toHaveBeenCalledOnce();
    expect(onTeamCreated).toHaveBeenCalledWith('imported-team');
    expect(createTeamConfig.mock.invocationCallOrder[0]).toBeLessThan(
      onTeamCreated.mock.invocationCallOrder[0]!
    );
  });

  it('keeps lifecycle fenced when draft creation fails', async () => {
    const onTeamCreated = vi.fn();
    const repository = new TeamDataImportDraftRepository(
      {
        createTeamConfig: vi.fn(() => Promise.reject(new Error('create failed'))),
      } as unknown as TeamDataService,
      onTeamCreated
    );

    await expect(
      repository.createDraft('imported-team', {
        projectPath: '/tmp/sandbox-project',
        members: [],
        prompt: 'Imported prompt',
      } as never)
    ).rejects.toThrow('create failed');
    expect(onTeamCreated).not.toHaveBeenCalled();
  });
});
