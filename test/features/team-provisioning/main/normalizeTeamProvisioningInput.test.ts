import { ProvisionTeam } from '@features/team-provisioning/core/application/use-cases/ProvisionTeam';
import {
  normalizeCreateTeamRequest,
  normalizeLaunchTeamRequest,
} from '@features/team-provisioning/main/adapters/input/ipc/normalizeTeamProvisioningInput';
import { describe, expect, it, vi } from 'vitest';

import type {
  TeamLaunchMetadata,
  TeamProvisioningWorkspacePort,
} from '@features/team-provisioning/core/application/ports/TeamProvisioningPorts';
import type { TeamCreateRequest, TeamLaunchRequest } from '@shared/types';

const workspace: TeamProvisioningWorkspacePort = {
  ensureDirectory: async () => true,
  getDirectoryStatus: async () => 'directory',
  isAbsolute: (value) => value.startsWith('/'),
  hasTeamConfig: async () => true,
  getMetadata: async () => null,
};

function createRequest(allowExperimentalLocalModels: boolean | undefined): TeamCreateRequest {
  return {
    teamName: 'test-team',
    members: [],
    cwd: '/tmp/test-team',
    allowExperimentalLocalModels,
  };
}

function launchRequest(allowExperimentalLocalModels: boolean | undefined): TeamLaunchRequest {
  return {
    teamName: 'test-team',
    cwd: '/tmp/test-team',
    allowExperimentalLocalModels,
  };
}

function createProvisionTeamHarness(
  savedRequest: TeamCreateRequest,
  metadata: TeamLaunchMetadata | null = null
) {
  const createTeam = vi.fn(async () => ({ runId: 'create-run' }));
  const launchTeam = vi.fn(async () => ({ runId: 'launch-run' }));
  const useCase = new ProvisionTeam({
    start: { createTeam, launchTeam },
    repository: {
      getSavedRequest: async () => savedRequest,
    },
    workspace: {
      ...workspace,
      getMetadata: async () => metadata,
    },
    effects: {
      addBreadcrumb: vi.fn(),
      noteLaunchIntent: vi.fn(),
      markTeamEngaged: vi.fn(),
      noteProgress: vi.fn(),
      noteFailureBeforeProgress: vi.fn(),
      invalidateRosterSnapshots: vi.fn(),
    },
  });
  return { createTeam, launchTeam, useCase };
}

describe('team provisioning IPC normalization', () => {
  it.each([true, false])(
    'validates and forwards allowExperimentalLocalModels=%s for create requests',
    async (allowExperimentalLocalModels) => {
      const result = await normalizeCreateTeamRequest(
        createRequest(allowExperimentalLocalModels),
        workspace
      );

      expect(result).toMatchObject({
        valid: true,
        value: { allowExperimentalLocalModels },
      });
    }
  );

  it('rejects a non-boolean allowExperimentalLocalModels value for create requests', async () => {
    const result = await normalizeCreateTeamRequest(
      { ...createRequest(undefined), allowExperimentalLocalModels: 'true' },
      workspace
    );

    expect(result).toEqual({
      valid: false,
      error: 'allowExperimentalLocalModels must be a boolean',
    });
  });

  it.each([true, false])(
    'validates and forwards allowExperimentalLocalModels=%s for launch requests',
    async (allowExperimentalLocalModels) => {
      const result = await normalizeLaunchTeamRequest(
        launchRequest(allowExperimentalLocalModels),
        workspace
      );

      expect(result).toMatchObject({
        valid: true,
        value: {
          payload: { allowExperimentalLocalModels },
        },
      });
    }
  );

  it('rejects a non-boolean allowExperimentalLocalModels value for launch requests', async () => {
    const result = await normalizeLaunchTeamRequest(
      { ...launchRequest(undefined), allowExperimentalLocalModels: 'true' },
      workspace
    );

    expect(result).toEqual({
      valid: false,
      error: 'allowExperimentalLocalModels must be a boolean',
    });
  });

  it('preserves the validated flag when a draft launch becomes a create request', async () => {
    const normalized = await normalizeLaunchTeamRequest(launchRequest(true), workspace);
    expect(normalized.valid).toBe(true);
    if (!normalized.valid) return;
    const { createTeam, useCase } = createProvisionTeamHarness(createRequest(undefined));

    await useCase.launch(normalized.value, vi.fn(), 'draft');

    expect(createTeam).toHaveBeenCalledWith(
      expect.objectContaining({ allowExperimentalLocalModels: true }),
      expect.any(Function)
    );
  });

  it('preserves an explicit false flag in an existing-team launch request', async () => {
    const normalized = await normalizeLaunchTeamRequest(launchRequest(false), workspace);
    expect(normalized.valid).toBe(true);
    if (!normalized.valid) return;
    const { launchTeam, useCase } = createProvisionTeamHarness(createRequest(undefined));

    await useCase.launch(normalized.value, vi.fn(), 'existing');

    expect(launchTeam).toHaveBeenCalledWith(
      expect.objectContaining({ allowExperimentalLocalModels: false }),
      expect.any(Function)
    );
  });
});
