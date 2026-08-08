import { createTeamProvisioningPreparationTransport } from '@renderer/composition/team/createTeamProvisioningPreparationTransport';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TeamProvisioningPrepareResult } from '@shared/types';

const mocks = vi.hoisted(() => ({
  teams: {} as { prepareProvisioning?: ReturnType<typeof vi.fn> },
  workspaceTrust: {} as { getProjectStatus?: ReturnType<typeof vi.fn> },
}));

vi.mock('@renderer/api', () => ({
  api: {
    teams: mocks.teams,
    workspaceTrust: mocks.workspaceTrust,
  },
}));

describe('createTeamProvisioningPreparationTransport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.teams.prepareProvisioning = vi.fn();
    mocks.workspaceTrust.getProjectStatus = vi.fn();
  });

  it('preserves the exact seven-argument preparation order and result', async () => {
    const result: TeamProvisioningPrepareResult = {
      ready: true,
      message: 'ready',
    };
    mocks.teams.prepareProvisioning?.mockResolvedValueOnce(result);
    const transport = createTeamProvisioningPreparationTransport();
    const selectedModelChecks = [{ providerId: 'codex' as const, model: 'gpt-5.4' }];

    await expect(
      transport.prepareProvisioning?.(
        '/sandbox/project',
        'codex',
        ['codex', 'opencode'],
        ['gpt-5.4'],
        true,
        'deep',
        selectedModelChecks
      )
    ).resolves.toBe(result);
    expect(mocks.teams.prepareProvisioning).toHaveBeenCalledWith(
      '/sandbox/project',
      'codex',
      ['codex', 'opencode'],
      ['gpt-5.4'],
      true,
      'deep',
      selectedModelChecks
    );
  });

  it('keeps the preparation capability absent for an older preload', () => {
    delete mocks.teams.prepareProvisioning;

    expect(createTeamProvisioningPreparationTransport().prepareProvisioning).toBeUndefined();
  });

  it('binds workspace trust status through the renderer composition boundary', async () => {
    const result = { status: 'trusted' as const };
    mocks.workspaceTrust.getProjectStatus?.mockResolvedValueOnce(result);

    const transport = createTeamProvisioningPreparationTransport();

    await expect(
      transport.getWorkspaceTrustProjectStatus?.({ projectPath: '/sandbox/project' })
    ).resolves.toBe(result);
    expect(mocks.workspaceTrust.getProjectStatus).toHaveBeenCalledWith({
      projectPath: '/sandbox/project',
    });
  });

  it('keeps workspace trust status absent for an older preload', () => {
    delete mocks.workspaceTrust.getProjectStatus;

    expect(
      createTeamProvisioningPreparationTransport().getWorkspaceTrustProjectStatus
    ).toBeUndefined();
  });

  it('preserves preparation failures for the dialogs to classify', async () => {
    const failure = new Error('preparation failed');
    mocks.teams.prepareProvisioning?.mockRejectedValueOnce(failure);
    const transport = createTeamProvisioningPreparationTransport();

    await expect(transport.prepareProvisioning?.('/sandbox/project')).rejects.toBe(failure);
  });
});
