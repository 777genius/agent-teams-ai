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
] as const satisfies readonly (keyof TeamProvisioningServiceComposition)[];

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
});
