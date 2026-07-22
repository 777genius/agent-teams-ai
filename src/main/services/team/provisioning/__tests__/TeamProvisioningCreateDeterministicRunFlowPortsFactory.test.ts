import { describe, expect, it, vi } from 'vitest';

import { createAnthropicApiKeyHelperCleanupRetryOwner } from '../TeamProvisioningAnthropicApiKeyHelperLease';
import {
  createTeamProvisioningCreateDeterministicRunFlowPortsFromService,
  type TeamProvisioningCreateDeterministicRunFlowServiceHost,
} from '../TeamProvisioningCreateDeterministicRunFlowPortsFactory';
import { type ProvisioningRun } from '../TeamProvisioningRunModel';

import type { TeamCreateRequest } from '@shared/types';

function createHost(): TeamProvisioningCreateDeterministicRunFlowServiceHost {
  return {
    anthropicApiKeyHelperCleanupRetryOwner: createAnthropicApiKeyHelperCleanupRetryOwner(),
    runs: new Map(),
    provisioningRunByTeam: new Map(),
    resetTeamScopedTransientStateForNewRun: vi.fn(),
    workspaceTrustPreSpawnBoundary: {
      prepareWorkspaceTrustForDeterministicRun: vi.fn(async () => undefined),
    },
    clearPersistedLaunchState: vi.fn(async () => undefined),
  };
}

describe('TeamProvisioningCreateDeterministicRunFlowPortsFactory', () => {
  it('creates deterministic provisioning runs with the service run shape', () => {
    const host = createHost();
    const ports = createTeamProvisioningCreateDeterministicRunFlowPortsFromService(host);
    const onProgress = vi.fn();

    const run = ports.createProvisioningRun({
      runId: 'run-1',
      teamName: 'alpha',
      request: {
        teamName: 'alpha',
        cwd: '/workspace',
        members: [],
      } as TeamCreateRequest,
      startedAt: '2026-07-08T00:00:00.000Z',
      onProgress,
      teamsBasePathsToProbe: [],
      effectiveMemberSpecs: [],
      allEffectiveMemberSpecs: [],
      launchIdentity: null,
      mixedSecondaryLanes: [],
      workspaceTrustFullPlan: null,
      largeTeamWarning: null,
      anthropicApiKeyHelper: null,
      createInitialMemberSpawnStatusEntry: ports.createInitialMemberSpawnStatusEntry,
    });

    expect(run.runId).toBe('run-1');
    expect(run.teamName).toBe('alpha');
    expect(run.progress.state).toBe('validating');
    expect(run.onProgress).toBe(onProgress);
  });

  it('writes run registrations and delegates mutable service operations', async () => {
    const host = createHost();
    const ports = createTeamProvisioningCreateDeterministicRunFlowPortsFromService(host);
    const run = {
      runId: 'run-1',
      teamName: 'alpha',
    } as ProvisioningRun;

    ports.registerRun('run-1', run);
    ports.setProvisioningRunByTeam('alpha', 'run-1');
    ports.resetTeamScopedTransientStateForNewRun('alpha');
    await ports.clearPersistedLaunchState('alpha', { expectedRunId: 'run-1' });
    await ports.prepareWorkspaceTrustForDeterministicRun({
      mode: 'create',
      run,
      claudePath: '/bin/claude',
      shellEnv: {},
      stopAllGenerationAtStart: 0,
      workspaceTrustPlan: null,
      featureFlags: {
        enabled: false,
        claudePty: false,
        codexArgs: false,
        retry: false,
        fileLock: false,
      },
      provisioningEnv: {
        env: {},
        authSource: 'none',
        geminiRuntimeAuth: null,
      },
    });

    expect(host.runs.get('run-1')).toBe(run);
    expect(host.provisioningRunByTeam.get('alpha')).toBe('run-1');
    expect(host.resetTeamScopedTransientStateForNewRun).toHaveBeenCalledWith('alpha');
    expect(host.clearPersistedLaunchState).toHaveBeenCalledWith('alpha', {
      expectedRunId: 'run-1',
    });
    expect(
      host.workspaceTrustPreSpawnBoundary.prepareWorkspaceTrustForDeterministicRun
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'create',
        run,
        claudePath: '/bin/claude',
      })
    );
  });
});
