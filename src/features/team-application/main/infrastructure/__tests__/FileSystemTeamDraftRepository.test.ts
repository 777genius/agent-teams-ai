import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FileSystemTeamDraftRepository } from '../FileSystemTeamDraftRepository';

const tempRoots: string[] = [];

async function createTempRoot(): Promise<string> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'team-draft-repository-'));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.promises.rm(root, { recursive: true })));
});

describe('FileSystemTeamDraftRepository', () => {
  it('classifies a team without config.json as a draft', async () => {
    const root = await createTempRoot();
    const repository = new FileSystemTeamDraftRepository({
      getTeamsBasePath: () => root,
      permanentlyDeleteTeam: vi.fn(),
    });

    await expect(repository.getDraftState('team-a')).resolves.toBe('draft');
  });

  it('classifies a team with config.json as materialized', async () => {
    const root = await createTempRoot();
    await fs.promises.mkdir(path.join(root, 'team-a'), { recursive: true });
    await fs.promises.writeFile(path.join(root, 'team-a', 'config.json'), '{}');
    const repository = new FileSystemTeamDraftRepository({
      getTeamsBasePath: () => root,
      permanentlyDeleteTeam: vi.fn(),
    });

    await expect(repository.getDraftState('team-a')).resolves.toBe('materialized');
  });

  it('delegates permanent deletion to the backend team service', async () => {
    const permanentlyDeleteTeam = vi.fn(async () => undefined);
    const repository = new FileSystemTeamDraftRepository({
      getTeamsBasePath: () => '/tmp/unused',
      permanentlyDeleteTeam,
    });

    await repository.permanentlyDeleteTeam('team-a');

    expect(permanentlyDeleteTeam).toHaveBeenCalledWith('team-a');
  });

  it.each(['../outside', ''])(
    'rejects unsafe team paths before filesystem checks or delete delegation: %s',
    async (teamName) => {
      const root = await createTempRoot();
      const permanentlyDeleteTeam = vi.fn(async () => undefined);
      const repository = new FileSystemTeamDraftRepository({
        getTeamsBasePath: () => root,
        permanentlyDeleteTeam,
      });

      await expect(repository.getDraftState(teamName)).rejects.toThrow('Unsafe team draft path');
      await expect(repository.permanentlyDeleteTeam(teamName)).rejects.toThrow(
        'Unsafe team draft path'
      );
      expect(permanentlyDeleteTeam).not.toHaveBeenCalled();
    }
  );
});
