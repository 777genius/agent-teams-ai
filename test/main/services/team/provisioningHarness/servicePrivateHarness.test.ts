import { describe, expect, it, vi } from 'vitest';

import {
  memberLifecycleControllerHarness,
  memberLifecycleHostHarness,
  outputRecoveryFacadeHarness,
  privateHarness,
  providerRuntimeHarness,
  provisioningConfigFacadeHarness,
  runtimeResourceSamplingHarness,
  stubMemberLifecyclePersistedRuntimeMembers,
  stubProvisioningConfigProjectPath,
  verificationProbePortsHarness,
} from './index';

import type { TeamProvisioningConfigFacade } from '@main/services/team/provisioning/TeamProvisioningConfigFacade';
import type { TeamProvisioningService } from '@main/services/team/TeamProvisioningService';

describe('team provisioning private harness seams', () => {
  it('returns service facade seams without cloning or constructing runtime services', () => {
    const serviceSeams = {
      aliveRunByTeam: new Map([['team-a', 'run-1']]),
      configFacade: { marker: 'config' },
      memberLifecycleController: { marker: 'controller' },
      memberLifecycleHost: { marker: 'host' },
      outputRecoveryFacade: { marker: 'output' },
      providerRuntime: { marker: 'provider' },
      runtimeResourceSampling: { marker: 'sampling' },
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

  it('stubs persisted member and project-path seams with vi mocks', () => {
    const runtimeMembers: ReturnType<
      TeamProvisioningConfigFacade['readPersistedRuntimeMembers']
    > = [{ name: 'alice', agentId: 'alice@team-a' }];
    const service = {
      configFacade: {},
      memberLifecycleHost: {},
    } as unknown as TeamProvisioningService;

    stubMemberLifecyclePersistedRuntimeMembers(service, runtimeMembers);
    stubProvisioningConfigProjectPath(service, '/tmp/harness-project');

    expect(memberLifecycleHostHarness(service).readPersistedRuntimeMembers('team-a')).toBe(
      runtimeMembers
    );
    expect(provisioningConfigFacadeHarness(service).readPersistedTeamProjectPath('team-a')).toBe(
      '/tmp/harness-project'
    );
    expect(
      vi.isMockFunction(memberLifecycleHostHarness(service).readPersistedRuntimeMembers)
    ).toBe(true);
    expect(
      vi.isMockFunction(provisioningConfigFacadeHarness(service).readPersistedTeamProjectPath)
    ).toBe(true);
  });
});
