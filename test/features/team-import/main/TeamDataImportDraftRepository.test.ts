import { TeamDataImportDraftRepository } from '@features/team-import/main/infrastructure/TeamDataImportDraftRepository';
import { TeamDataService } from '@main/services/team/TeamDataService';
import { setClaudeBasePathOverride } from '@main/utils/pathDecoder';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const tempPaths: string[] = [];

async function createRepository(onTeamCreated = vi.fn()) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'team-import-draft-provenance-'));
  tempPaths.push(root);
  setClaudeBasePathOverride(root);
  const service = new TeamDataService();
  return { root, service, repository: new TeamDataImportDraftRepository(service, onTeamCreated) };
}

afterEach(async () => {
  setClaudeBasePathOverride(null);
  await Promise.all(
    tempPaths.splice(0).map((entry) => fs.rm(entry, { recursive: true, force: true }))
  );
});

describe('TeamDataImportDraftRepository', () => {
  it('materializes generated import intent through strict draft admission', async () => {
    const onTeamCreated = vi.fn();
    const { service, repository } = await createRepository(onTeamCreated);

    await repository.createDraft('imported-team', {
      reviewId: 'review-1',
      suggestedTeamName: 'imported-team',
      projectPath: '/tmp/sandbox-project',
      members: [{ name: 'builder', role: 'member' }],
      prompt: 'Imported prompt',
      skillsFound: [],
      warnings: [],
      blockingErrors: [],
    });

    await expect(service.getSavedRequest('imported-team')).resolves.toMatchObject({
      leadRuntimeSelectionProvenance: {
        version: 1,
        providerBackendId: 'default',
        model: 'default',
        effort: 'default',
      },
      members: [
        {
          name: 'builder',
          runtimeSelectionProvenance: {
            version: 1,
            providerBackendId: 'inherited',
            model: 'inherited',
            effort: 'inherited',
          },
        },
      ],
    });
    expect(onTeamCreated).toHaveBeenCalledWith('imported-team');
  });

  it('preserves supplied member provenance and concrete explicit selections', async () => {
    const { service, repository } = await createRepository();

    await repository.createDraft('explicit-import', {
      reviewId: 'review-2',
      suggestedTeamName: 'explicit-import',
      projectPath: '/tmp/sandbox-project',
      members: [
        {
          name: 'builder',
          providerId: 'codex',
          providerBackendId: 'codex-native',
          model: 'gpt-5.4',
          effort: 'high',
          runtimeSelectionProvenance: {
            version: 1,
            providerBackendId: 'explicit',
            model: 'explicit',
            effort: 'explicit',
          },
        },
      ],
      skillsFound: [],
      warnings: [],
      blockingErrors: [],
    });

    await expect(service.getSavedRequest('explicit-import')).resolves.toMatchObject({
      members: [
        {
          providerBackendId: 'codex-native',
          model: 'gpt-5.4',
          effort: 'high',
          runtimeSelectionProvenance: {
            providerBackendId: 'explicit',
            model: 'explicit',
            effort: 'explicit',
          },
        },
      ],
    });
  });

  it.each([
    {
      label: 'legacy concrete selection without provenance',
      member: { name: 'builder', providerId: 'codex' as const, model: 'gpt-5.4' },
      message: 'provenance is required and must be resolved',
    },
    {
      label: 'invalid supplied provenance',
      member: {
        name: 'builder',
        runtimeSelectionProvenance: { version: 1, model: 'explicit' },
      },
      message: 'provenance is required and must be resolved',
    },
  ])('fails closed for $label and keeps lifecycle fenced', async ({ member, message }) => {
    const onTeamCreated = vi.fn();
    const { root, repository } = await createRepository(onTeamCreated);

    await expect(
      repository.createDraft('rejected-import', {
        reviewId: 'review-rejected',
        suggestedTeamName: 'rejected-import',
        projectPath: '/tmp/sandbox-project',
        members: [member] as never,
        skillsFound: [],
        warnings: [],
        blockingErrors: [],
      })
    ).rejects.toThrow(message);
    expect(onTeamCreated).not.toHaveBeenCalled();
    await expect(fs.access(path.join(root, 'teams', 'rejected-import'))).rejects.toThrow();
  });
});
