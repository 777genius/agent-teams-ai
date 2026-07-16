import { TeamProvisioningService } from '@main/services/team/TeamProvisioningService';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getRegisteredProvisioningRunId,
  markTeamRunAlive,
  memberLifecycleControllerHarness,
  memberLifecycleHostHarness,
  memberLifecycleUseCasesHarness,
  outputRecoveryFacadeHarness,
  privateHarness,
  providerRuntimeHarness,
  provisioningConfigFacadeHarness,
  registerActiveProvisioningRun,
  registerAliveRun,
  registerProvisioningRun,
  runtimeResourceSamplingHarness,
  stubMemberLifecycleHostOptionalSeam,
  stubMemberLifecyclePersistedRuntimeMembers,
  stubProvisioningConfigProjectPath,
  verificationProbePortsHarness,
} from './servicePrivateHarness';

import type { TeamProvisioningConfigFacade } from '@main/services/team/provisioning/TeamProvisioningConfigFacade';
import type { TeamProvisioningMemberLifecycleServiceUseCases } from '@main/services/team/provisioning/TeamProvisioningMemberLifecycleServiceUseCases';

const { cleanupStaleAnthropicTeamApiKeyHelpersMock } = vi.hoisted(() => ({
  cleanupStaleAnthropicTeamApiKeyHelpersMock: vi.fn(() => Promise.resolve(undefined)),
}));

vi.mock('@main/services/runtime/anthropicTeamApiKeyHelper', async (importOriginal) => ({
  ...(await importOriginal()),
  cleanupStaleAnthropicTeamApiKeyHelpers: cleanupStaleAnthropicTeamApiKeyHelpersMock,
}));

const MEMBER_LIFECYCLE_SERVICE_USE_CASE_KEYS = [
  'appendDirectProcessRuntimeEvent',
  'hasOpenCodeMemberRuntimeEvidenceForControlledRelaunch',
  'persistOpenCodeMemberRestartSystemMessage',
  'preparePrimaryOwnedMemberRestartRuntime',
  'readOpenCodeSecondaryRetryOutcome',
  'resolveDirectRestartRuntimeCwd',
  'stopPrimaryOwnedRosterRuntime',
  'updateDirectTmuxRestartMemberConfig',
] as const satisfies readonly (keyof TeamProvisioningMemberLifecycleServiceUseCases)[];

describe('team provisioning private harness seams', () => {
  beforeEach(() => {
    cleanupStaleAnthropicTeamApiKeyHelpersMock.mockClear();
  });

  it('returns service facade seams without cloning or constructing runtime services', () => {
    const serviceSeams = {
      aliveRunByTeam: new Map([['team-a', 'run-1']]),
      configFacade: { marker: 'config' },
      memberLifecycleController: { marker: 'controller' },
      memberLifecycleHost: { marker: 'host' },
      outputRecoveryFacade: { marker: 'output' },
      provisioningRunByTeam: new Map(),
      providerRuntime: { marker: 'provider' },
      runtimeResourceSampling: { marker: 'sampling' },
      runtimeAdapterProgressByRunId: new Map(),
      runs: new Map(),
      verificationProbePorts: { marker: 'probe' },
    };
    const service = serviceSeams as unknown as TeamProvisioningService;

    expect(privateHarness(service).aliveRunByTeam.get('team-a')).toBe('run-1');
    expect(provisioningConfigFacadeHarness(service)).toBe(serviceSeams.configFacade);
    expect(memberLifecycleControllerHarness(service)).toBe(
      serviceSeams.memberLifecycleController
    );
    expect(memberLifecycleHostHarness(service)).toBe(serviceSeams.memberLifecycleHost);
    expect(outputRecoveryFacadeHarness(service)).toBe(serviceSeams.outputRecoveryFacade);
    expect(providerRuntimeHarness(service)).toBe(serviceSeams.providerRuntime);
    expect(runtimeResourceSamplingHarness(service)).toBe(serviceSeams.runtimeResourceSampling);
    expect(verificationProbePortsHarness(service)).toBe(serviceSeams.verificationProbePorts);
  });

  it('registers run-tracking state through narrow typed helpers', () => {
    const serviceSeams = {
      aliveRunByTeam: new Map<string, string>(),
      provisioningRunByTeam: new Map<string, string>(),
      runtimeAdapterProgressByRunId: new Map<string, { runId: string; state: 'spawning' }>(),
      runs: new Map(),
    };
    const service = serviceSeams as unknown as TeamProvisioningService;
    const aliveRun = {
      runId: 'alive-run-1',
      teamName: 'team-a',
      request: { cwd: '/workspace/project' },
      child: null,
      processKilled: false,
      cancelRequested: false,
      progress: { state: 'ready' as const },
    };
    const activeProvisioningRun = {
      runId: 'active-provisioning-run-1',
      teamName: 'team-b',
      request: {},
      child: null,
      processKilled: false,
      cancelRequested: false,
      progress: { state: 'spawning' as const },
    };

    registerAliveRun(service, aliveRun);
    markTeamRunAlive(service, 'team-c', 'alive-run-id-only');
    registerActiveProvisioningRun(service, activeProvisioningRun);
    registerProvisioningRun(service, 'team-a', 'runtime-adapter-run-1', {
      runtimeAdapterProgressState: 'spawning',
    });

    expect(serviceSeams.runs.get(aliveRun.runId)).toBe(aliveRun);
    expect(serviceSeams.runs.get(activeProvisioningRun.runId)).toBe(activeProvisioningRun);
    expect(serviceSeams.aliveRunByTeam.get('team-a')).toBe(aliveRun.runId);
    expect(serviceSeams.aliveRunByTeam.get('team-c')).toBe('alive-run-id-only');
    expect(serviceSeams.runs.has('alive-run-id-only')).toBe(false);
    expect(getRegisteredProvisioningRunId(service, 'team-b')).toBe(
      activeProvisioningRun.runId
    );
    expect(getRegisteredProvisioningRunId(service, 'team-a')).toBe('runtime-adapter-run-1');
    expect(serviceSeams.runtimeAdapterProgressByRunId.get('runtime-adapter-run-1')).toEqual({
      runId: 'runtime-adapter-run-1',
      state: 'spawning',
    });
  });

  it('stubs persisted member and project-path seams with vi mocks', () => {
    const runtimeMembers: ReturnType<
      TeamProvisioningConfigFacade['readPersistedRuntimeMembers']
    > = [{ name: 'alice', agentId: 'alice@team-a' }];
    const service = {
      configFacade: {},
      memberLifecycleHost: {},
    } as unknown as TeamProvisioningService;

    stubMemberLifecyclePersistedRuntimeMembers(service, runtimeMembers);
    stubProvisioningConfigProjectPath(service, '/workspace/harness-project');

    expect(memberLifecycleHostHarness(service).readPersistedRuntimeMembers('team-a')).toBe(
      runtimeMembers
    );
    expect(provisioningConfigFacadeHarness(service).readPersistedTeamProjectPath('team-a')).toBe(
      '/workspace/harness-project'
    );
    expect(
      vi.isMockFunction(memberLifecycleHostHarness(service).readPersistedRuntimeMembers)
    ).toBe(true);
    expect(
      vi.isMockFunction(provisioningConfigFacadeHarness(service).readPersistedTeamProjectPath)
    ).toBe(true);
  });

  it('stubs current lifecycle optional seams on their owning facade surface', () => {
    const enqueueDirectRestartPrompt = vi.fn();
    const updateDirectTmuxRestartMemberConfig = vi.fn(() => Promise.resolve());
    const service = {
      memberLifecycleHost: {},
      memberLifecycleUseCases: {},
    } as unknown as TeamProvisioningService;

    expect(
      stubMemberLifecycleHostOptionalSeam(
        service,
        'enqueueDirectRestartPrompt',
        enqueueDirectRestartPrompt
      )
    ).toBe(enqueueDirectRestartPrompt);
    expect(
      stubMemberLifecycleHostOptionalSeam(
        service,
        'updateDirectTmuxRestartMemberConfig',
        updateDirectTmuxRestartMemberConfig
      )
    ).toBe(updateDirectTmuxRestartMemberConfig);

    expect(memberLifecycleHostHarness(service).enqueueDirectRestartPrompt).toBe(
      enqueueDirectRestartPrompt
    );
    expect(memberLifecycleUseCasesHarness(service).updateDirectTmuxRestartMemberConfig).toBe(
      updateDirectTmuxRestartMemberConfig
    );
  });

  it('exposes the service-owned lifecycle use cases wired into restart and retry controller seams', () => {
    const service = new TeamProvisioningService();
    const useCases = memberLifecycleUseCasesHarness(service);
    const controller = memberLifecycleControllerHarness(service);

    expect(Object.keys(useCases).sort((a, b) => a.localeCompare(b))).toEqual([
      ...MEMBER_LIFECYCLE_SERVICE_USE_CASE_KEYS,
    ]);
    expect(Reflect.get(controller, 'restartUseCases')).toBe(useCases);
    expect(Reflect.get(controller, 'openCodeRetryUseCases')).toBe(useCases);
    expect(Reflect.get(controller, 'actionUseCases')).toEqual({});
    expect(cleanupStaleAnthropicTeamApiKeyHelpersMock).toHaveBeenCalledTimes(1);
  });
});
