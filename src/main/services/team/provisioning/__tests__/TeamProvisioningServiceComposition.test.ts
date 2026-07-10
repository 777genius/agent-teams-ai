import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { TeamProvisioningService } from '../../TeamProvisioningService';

import type { TeamProvisioningServiceComposition } from '../TeamProvisioningServiceComposition';

const { cleanupStaleAnthropicTeamApiKeyHelpersMock } = vi.hoisted(() => ({
  cleanupStaleAnthropicTeamApiKeyHelpersMock: vi.fn(async () => undefined),
}));

vi.mock('../../../runtime/anthropicTeamApiKeyHelper', async (importOriginal) => ({
  ...(await importOriginal()),
  cleanupStaleAnthropicTeamApiKeyHelpers: cleanupStaleAnthropicTeamApiKeyHelpersMock,
}));

const COMPOSITION_INSTALLED_KEYS = [
  'configFacade',
  'liveRuntimeMetadataPorts',
  'runtimeSnapshotFacade',
  'openCodeRuntimeDeliveryBoundaryHost',
  'launchStateStoreBoundary',
  'persistenceReconcileFacade',
  'launchStateCompatibilityBoundary',
  'configTaskActivityBoundary',
  'toolApprovalFacade',
  'idlePromptInjectionBoundary',
  'providerRuntime',
  'providerRuntimeCompatibility',
  'openCodeRuntimeRecoveryFacade',
  'openCodePromptDeliveryWatchdogScheduler',
  'compatibilityDelegation',
  'outputRecoveryFacade',
  'deterministicLaunchFlowBoundary',
  'deterministicCreateSpawnFlowBoundary',
  'verificationProbePorts',
  'processExitPorts',
  'prepareFacade',
  'memberMcpLaunchConfigProvisioner',
  'openCodeVisibleReplyProofService',
  'openCodePromptDeliveryWatchdogCoordinator',
  'bootstrapTranscriptFacade',
  'bootstrapEvidenceFacade',
  'leadInboxRelayFacade',
  'cleanupRunPorts',
  'transientRunState',
  'requestAdmissionBoundary',
  'openCodeRuntimeControlApi',
] as const satisfies readonly (keyof TeamProvisioningServiceComposition)[];

const COMPOSITION_OWNED_FACTORY_MARKERS = [
  'createTeamProvisioningRequestAdmissionBoundary',
  'createTeamRuntimeControlCompatibilityApiFromService',
] as const;

type CreateTeamRequestInput = Parameters<TeamProvisioningService['createTeam']>[0];
type LaunchTeamRequestInput = Parameters<TeamProvisioningService['launchTeam']>[0];

const SERVICE_SOURCE_PATH = resolve(
  process.cwd(),
  'src/main/services/team/TeamProvisioningService.ts'
);
const COMPOSITION_SOURCE_PATH = resolve(
  process.cwd(),
  'src/main/services/team/provisioning/TeamProvisioningServiceComposition.ts'
);

describe('TeamProvisioningServiceComposition', () => {
  it('installs every composition facade on a constructed service under its compatibility key', () => {
    const service = new TeamProvisioningService();

    for (const key of COMPOSITION_INSTALLED_KEYS) {
      expect(Object.hasOwn(service, key)).toBe(true);
      expect(Reflect.get(service, key)).toBeDefined();
    }
    expect(
      Reflect.get(
        Reflect.get(service, 'compatibilityDelegation') as Record<PropertyKey, unknown>,
        'configFacade'
      )
    ).toBe(Reflect.get(service, 'configFacade'));
    expect(cleanupStaleAnthropicTeamApiKeyHelpersMock).toHaveBeenCalledTimes(1);
  });

  it('keeps moved boundary factories in composition instead of the compatibility facade', () => {
    const serviceSource = readFileSync(SERVICE_SOURCE_PATH, 'utf8');
    const compositionSource = readFileSync(COMPOSITION_SOURCE_PATH, 'utf8');

    for (const factoryName of COMPOSITION_OWNED_FACTORY_MARKERS) {
      expect(serviceSource).not.toContain(`${factoryName}(`);
      expect(compositionSource).toContain(`${factoryName}(`);
    }
  });

  it('routes public create and launch entrypoints through the installed admission boundary', async () => {
    const service = new TeamProvisioningService();
    const onProgress = vi.fn();
    const createRequest = { teamName: 'alpha' } as CreateTeamRequestInput;
    const launchRequest = { teamName: 'alpha' } as LaunchTeamRequestInput;
    const createResponse = { runId: 'create-run' };
    const launchResponse = { runId: 'launch-run' };
    const requestAdmissionBoundary = {
      createTeam: vi.fn(async () => createResponse),
      launchTeam: vi.fn(async () => launchResponse),
    };

    Reflect.set(service, 'requestAdmissionBoundary', requestAdmissionBoundary);

    await expect(service.createTeam(createRequest, onProgress)).resolves.toBe(createResponse);
    await expect(service.launchTeam(launchRequest, onProgress)).resolves.toBe(launchResponse);
    expect(requestAdmissionBoundary.createTeam).toHaveBeenCalledWith(createRequest, onProgress);
    expect(requestAdmissionBoundary.launchTeam).toHaveBeenCalledWith(launchRequest, onProgress);
  });

  it('routes runtime-control compatibility methods through the installed boundary', async () => {
    const service = new TeamProvisioningService();
    const raw = { teamName: 'alpha' };
    const ack = {
      ok: true,
      providerId: 'opencode',
      teamName: 'alpha',
      runId: 'run-1',
      state: 'accepted',
      diagnostics: [],
      observedAt: '2026-01-01T00:00:00.000Z',
    };
    const openCodeRuntimeControlApi = {
      recordOpenCodeRuntimeBootstrapCheckin: vi.fn(async () => ack),
      deliverOpenCodeRuntimeMessage: vi.fn(async () => ack),
      recordOpenCodeRuntimeTaskEvent: vi.fn(async () => ack),
      recordOpenCodeRuntimeHeartbeat: vi.fn(async () => ack),
      answerOpenCodeRuntimePermission: vi.fn(async () => ack),
    };

    Reflect.set(service, 'openCodeRuntimeControlApi', openCodeRuntimeControlApi);

    await expect(service.recordOpenCodeRuntimeHeartbeat(raw)).resolves.toBe(ack);
    expect(openCodeRuntimeControlApi.recordOpenCodeRuntimeHeartbeat).toHaveBeenCalledWith(raw);
  });
});
