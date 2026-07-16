import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { TeamProvisioningService } from '../../TeamProvisioningService';
import {
  TEAM_PROVISIONING_SERVICE_COMPOSITION_KEYS,
  TEAM_PROVISIONING_SERVICE_COMPOSITION_KEYS_ARE_EXHAUSTIVE,
  TEAM_PROVISIONING_SERVICE_COMPOSITION_KEYS_ARE_UNIQUE,
} from '../TeamProvisioningServiceComposition';

const { cleanupStaleAnthropicTeamApiKeyHelpersMock } = vi.hoisted(() => ({
  cleanupStaleAnthropicTeamApiKeyHelpersMock: vi.fn(async () => undefined),
}));

vi.mock('../../../runtime/anthropicTeamApiKeyHelper', async (importOriginal) => ({
  ...(await importOriginal()),
  cleanupStaleAnthropicTeamApiKeyHelpers: cleanupStaleAnthropicTeamApiKeyHelpersMock,
}));

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

    expect(TEAM_PROVISIONING_SERVICE_COMPOSITION_KEYS_ARE_EXHAUSTIVE).toBe(true);
    expect(TEAM_PROVISIONING_SERVICE_COMPOSITION_KEYS_ARE_UNIQUE).toBe(true);
    expect(new Set(TEAM_PROVISIONING_SERVICE_COMPOSITION_KEYS).size).toBe(
      TEAM_PROVISIONING_SERVICE_COMPOSITION_KEYS.length
    );
    for (const key of TEAM_PROVISIONING_SERVICE_COMPOSITION_KEYS) {
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

  it('keeps composition wiring behind narrow host adapters without a whole-service unknown cast', () => {
    const compositionSource = readFileSync(COMPOSITION_SOURCE_PATH, 'utf8');

    expect(compositionSource).toContain('TeamProvisioningServiceCompositionHostAdapters');
    expect(compositionSource).not.toContain('service: unknown');
    expect(compositionSource).not.toContain('TeamProvisioningServiceCompositionHost =');
  });

  it('shares the composed watchdog scheduler with the runtime delivery host', () => {
    const service = new TeamProvisioningService();
    const scheduler = Reflect.get(service, 'openCodePromptDeliveryWatchdogScheduler');
    const deliveryHost = Reflect.get(service, 'openCodeRuntimeDeliveryBoundaryHost') as {
      openCodePromptDeliveryWatchdogScheduler?: unknown;
    };

    expect(deliveryHost.openCodePromptDeliveryWatchdogScheduler).toBe(scheduler);
  });

  it('runs the production admission closures for public create and launch entrypoints', async () => {
    const service = new TeamProvisioningService();
    const onProgress = vi.fn();
    const createRequest = { teamName: 'alpha' } as CreateTeamRequestInput;
    const launchRequest = { teamName: 'alpha' } as LaunchTeamRequestInput;
    const existingRunId = 'existing-run';
    const provisioningRunByTeam = Reflect.get(service, 'provisioningRunByTeam') as Map<
      string,
      string
    >;
    const runs = Reflect.get(service, 'runs') as Map<string, object>;
    provisioningRunByTeam.set('alpha', existingRunId);
    // Real runs always carry progress; run tracking reads progress.state to clear terminal runs.
    runs.set(existingRunId, { progress: { state: 'spawning' } });

    await expect(service.createTeam(createRequest, onProgress)).resolves.toEqual({
      runId: existingRunId,
      launchStatus: 'already_launching',
      alreadyLaunching: true,
    });
    await expect(service.launchTeam(launchRequest, onProgress)).resolves.toEqual({
      runId: existingRunId,
      launchStatus: 'already_launching',
      alreadyLaunching: true,
    });
    expect(onProgress).not.toHaveBeenCalled();
  });

  it('runs the production runtime-control closure and validates its ingress payload', async () => {
    const service = new TeamProvisioningService();

    await expect(service.recordOpenCodeRuntimeHeartbeat({ teamName: 'alpha' })).rejects.toThrow(
      'OpenCode runtime payload missing runId'
    );
  });
});
