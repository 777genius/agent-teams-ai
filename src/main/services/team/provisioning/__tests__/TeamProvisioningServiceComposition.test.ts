import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { createTeamProvisioningApplicationFeature } from '@features/team-provisioning/main';
import {
  createCompositeRuntimePlan,
  parseExecutionUnitId,
  parseLaneId,
  parseRuntimeBackendBindingId,
  parseRuntimeBinaryId,
} from '@features/team-runtime-control';
import { planTeamRuntimeLanes } from '@features/team-runtime-lanes';
import {
  parseLegacyMemberKey,
  parseMemberId,
  parseRunId,
  parseTeamId,
  parseWorkspaceId,
} from '@shared/contracts/hosted';
import { describe, expect, it, vi } from 'vitest';

import { TeamProvisioningService } from '../../TeamProvisioningService';
import {
  createTeamProvisioningServiceComposition,
  TEAM_PROVISIONING_SERVICE_COMPOSITION_KEYS,
  TEAM_PROVISIONING_SERVICE_COMPOSITION_KEYS_ARE_EXHAUSTIVE,
  TEAM_PROVISIONING_SERVICE_COMPOSITION_KEYS_ARE_UNIQUE,
} from '../TeamProvisioningServiceComposition';

import type {
  RuntimeDeliveryStatus,
  RuntimeMessageDeliveryAck,
} from '@features/team-provisioning/contracts';
import type { TeamAgentRuntimeSnapshot, ToolApprovalSettings } from '@shared/types';

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
const STANDALONE_SOURCE_PATH = resolve(process.cwd(), 'src/main/standalone.ts');

function authoritativePlan(binaryHashCharacter = 'e') {
  const laneId = parseLaneId('primary');
  return createCompositeRuntimePlan({
    teamId: parseTeamId(`team_${'a'.repeat(32)}`),
    runId: parseRunId(`run_${'b'.repeat(32)}`),
    generation: 1,
    leadProviderId: 'anthropic',
    lanePlanResult: planTeamRuntimeLanes({
      leadProviderId: 'anthropic',
      members: [{ name: 'worker', providerId: 'anthropic' }],
    }),
    rosterGeneration: 1,
    memberBindings: [
      {
        memberId: parseMemberId(`member_${'c'.repeat(32)}`),
        memberRevision: 1,
        legacyMemberKey: parseLegacyMemberKey('worker'),
        providerId: 'anthropic',
        laneId,
        policy: 'required',
      },
    ],
    laneCredentials: [{ laneId, requiredCredentialExposureSet: { secretRefs: [] } }],
    workspaceBinding: {
      workspaceId: parseWorkspaceId(`workspace_${'d'.repeat(32)}`),
      registrationRevision: 1,
      bindingGeneration: 1,
      mountGeneration: 1,
    },
    executionUnits: [
      {
        executionUnitId: parseExecutionUnitId('unit-composition-authority'),
        backendBinding: {
          backend: 'provisioning_cli',
          bindingId: parseRuntimeBackendBindingId('binding-composition-authority'),
          bindingRevision: 1,
        },
        laneId,
        binaryPolicy: {
          policy: 'registered_exact_binary',
          binaryId: parseRuntimeBinaryId('binary-composition-authority'),
          binaryRevision: 1,
          binaryHash: `sha256:${binaryHashCharacter.repeat(64)}`,
        },
        environmentPolicy: { policy: 'explicit_allowlist', variables: [] },
        credentialExposureSet: { secretRefs: [] },
        resourcePolicy: {
          maxRuntimeMs: 30_000,
          gracefulStopMs: 2_000,
          maxOutputBytes: 100_000,
          maxProcessCount: 2,
        },
      },
    ],
  });
}

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
    expect(
      Reflect.get(
        Reflect.get(service, 'compatibilityDelegation') as Record<PropertyKey, unknown>,
        'applicationFeature'
      )
    ).toBe(Reflect.get(service, 'applicationFeature'));
    expect(cleanupStaleAnthropicTeamApiKeyHelpersMock).toHaveBeenCalledTimes(1);
  });

  it('installs exactly one boot-local hosted runtime authority and none in standalone', () => {
    const service = new TeamProvisioningService();
    const authority = Reflect.get(service, 'hostedRuntimeAuthority') as {
      authorityId: string;
      bootId: string;
    };
    const compositionSource = readFileSync(COMPOSITION_SOURCE_PATH, 'utf8');
    const standaloneSource = readFileSync(STANDALONE_SOURCE_PATH, 'utf8');

    expect(TEAM_PROVISIONING_SERVICE_COMPOSITION_KEYS).toEqual(
      expect.arrayContaining(['hostedRuntimeAuthority'])
    );
    expect(
      TEAM_PROVISIONING_SERVICE_COMPOSITION_KEYS.filter((key) => key === 'hostedRuntimeAuthority')
    ).toHaveLength(1);
    expect(authority.authorityId).toMatch(/^runtime-authority:/);
    expect(authority.bootId).toMatch(/^runtime-boot:/);
    expect(Object.isFrozen(authority)).toBe(true);
    expect(() => createTeamProvisioningServiceComposition(service)).toThrow(
      'hosted-runtime-authority-already-mounted'
    );
    expect(compositionSource.match(/mountHostedRuntimeAuthority\(/g)).toHaveLength(1);
    expect(standaloneSource).not.toContain('TeamProvisioningHostedRuntimeAuthority');
    expect(standaloneSource).not.toContain('hostedRuntimeAuthority');
  });

  it('exposes the production remember, issue, and redeem seam without another lifecycle owner', async () => {
    const service = new TeamProvisioningService();
    const authority = Reflect.get(service, 'hostedRuntimeAuthority') as ReturnType<
      typeof createTeamProvisioningServiceComposition
    >['hostedRuntimeAuthority'];
    const plan = authoritativePlan();
    const binding = {
      authorityId: authority.authorityId,
      bootId: authority.bootId,
      laneId: parseLaneId('primary'),
      operation: 'launch' as const,
      operationId: 'composition-operation:test',
    };

    authority.rememberReconstructedPlan(plan);
    authority.rememberReconstructedPlan(plan);
    const stale = await authority.issue({ candidate: plan, binding });
    expect(stale).not.toBeNull();
    const replacement = authoritativePlan('f');
    authority.rememberReconstructedPlan(replacement);
    await expect(authority.redeem(stale, binding)).resolves.toEqual({
      status: 'rejected',
      reason: 'unavailable',
    });
    const attestation = await authority.issue({ candidate: replacement, binding });
    expect(attestation?.token).not.toBe(stale?.token);
    await expect(authority.redeem(attestation, binding)).resolves.toEqual({
      status: 'redeemed',
      plan: replacement,
    });
    expect(TEAM_PROVISIONING_SERVICE_COMPOSITION_KEYS).not.toContain('agentRuntimeLifecycleOwner');
  });

  it('combines the accepted slices without changing receivers, promises, results, or sync errors', async () => {
    const snapshot = { teamName: 'alpha' } as TeamAgentRuntimeSnapshot;
    const snapshotPromise = Promise.resolve(snapshot);
    const responsePromise = Promise.resolve();
    const deliveryAck = {
      ok: true,
      providerId: 'opencode',
      teamName: 'alpha',
      runId: 'run-1',
      state: 'delivered',
      diagnostics: [],
      observedAt: '2026-07-26T00:00:00.000Z',
    } satisfies RuntimeMessageDeliveryAck;
    const deliveryPromise = Promise.resolve(deliveryAck);
    const deliveryStatus = {
      providerId: 'opencode',
      attempted: true,
      delivered: true,
      messageId: 'message-1',
    } satisfies RuntimeDeliveryStatus;
    const statusPromise = Promise.resolve(deliveryStatus);
    const settings = {} as ToolApprovalSettings;
    const settingsFailure = new Error('settings write failed');
    const snapshotSource = {
      getTeamAgentRuntimeSnapshot(this: unknown, teamName: string) {
        expect(this).toBe(snapshotSource);
        expect(teamName).toBe(' alpha ');
        return snapshotPromise;
      },
    };
    const toolApprovalSource = {
      respondToToolApproval(
        this: unknown,
        _teamName: string,
        _runId: string,
        _requestId: string,
        _allow: boolean,
        _message?: string
      ) {
        expect(this).toBe(toolApprovalSource);
        return responsePromise;
      },
      updateToolApprovalSettings(
        this: unknown,
        _teamName: string,
        _settings: ToolApprovalSettings
      ) {
        expect(this).toBe(toolApprovalSource);
        throw settingsFailure;
      },
    };
    const runtimeDelivery = {
      deliverOpenCodeRuntimeMessage(this: unknown, _raw: unknown) {
        expect(this).toBe(runtimeDelivery);
        return deliveryPromise;
      },
      getOpenCodeRuntimeDeliveryStatus(this: unknown, _teamName: string, _messageId: string) {
        expect(this).toBe(runtimeDelivery);
        return statusPromise;
      },
    };
    const applicationFeature = createTeamProvisioningApplicationFeature({
      runtimeSnapshot: {
        readByTeamName: snapshotSource.getTeamAgentRuntimeSnapshot.bind(snapshotSource),
      },
      toolApproval: {
        respondToToolApproval: ({ teamName, runId, requestId, allow, message }) =>
          toolApprovalSource.respondToToolApproval(teamName, runId, requestId, allow, message),
        updateToolApprovalSettings: ({ teamName, settings: nextSettings }) =>
          toolApprovalSource.updateToolApprovalSettings(teamName, nextSettings),
      },
      runtimeDelivery: {
        deliverRuntimeMessage: runtimeDelivery.deliverOpenCodeRuntimeMessage.bind(runtimeDelivery),
        getRuntimeDeliveryStatus:
          runtimeDelivery.getOpenCodeRuntimeDeliveryStatus.bind(runtimeDelivery),
      },
    });

    const snapshotResult = applicationFeature.getTeamAgentRuntimeSnapshot(' alpha ');
    const responseResult = applicationFeature.respondToToolApproval(
      'alpha',
      'run-1',
      'request-1',
      true
    );
    const deliveryResult = applicationFeature.deliverRuntimeMessage({});
    const statusResult = applicationFeature.getRuntimeDeliveryStatus('alpha', 'message-1');
    const legacyDeliveryResult = applicationFeature.deliverOpenCodeRuntimeMessage({});
    const legacyStatusResult = applicationFeature.getOpenCodeRuntimeDeliveryStatus(
      'alpha',
      'message-1'
    );

    expect(snapshotResult).toBe(snapshotPromise);
    expect(responseResult).toBe(responsePromise);
    expect(deliveryResult).toBe(deliveryPromise);
    expect(statusResult).toBe(statusPromise);
    expect(legacyDeliveryResult).toBe(deliveryPromise);
    expect(legacyStatusResult).toBe(statusPromise);
    expect(() => applicationFeature.updateToolApprovalSettings('alpha', settings)).toThrow(
      settingsFailure
    );
    await expect(snapshotResult).resolves.toBe(snapshot);
    await expect(responseResult).resolves.toBeUndefined();
    await expect(deliveryResult).resolves.toBe(deliveryAck);
    await expect(statusResult).resolves.toBe(deliveryStatus);
    await expect(legacyDeliveryResult).resolves.toBe(deliveryAck);
    await expect(legacyStatusResult).resolves.toBe(deliveryStatus);
  });

  it('keeps moved boundary factories in composition instead of the compatibility facade', () => {
    const serviceSource = readFileSync(SERVICE_SOURCE_PATH, 'utf8');
    const compositionSource = readFileSync(COMPOSITION_SOURCE_PATH, 'utf8');

    for (const factoryName of COMPOSITION_OWNED_FACTORY_MARKERS) {
      expect(serviceSource).not.toContain(`${factoryName}(`);
      expect(compositionSource).toContain(`${factoryName}(`);
    }
  });

  it('routes provisioning status through the composed feature without starting a runtime', async () => {
    const service = new TeamProvisioningService();
    const snapshot = {
      runId: 'status-run',
      teamName: 'status-team',
      state: 'spawning' as const,
      message: 'Starting',
      startedAt: '2026-07-22T10:00:00.000Z',
      updatedAt: '2026-07-22T10:00:01.000Z',
    };
    const runs = Reflect.get(service, 'runs') as Map<string, { progress: typeof snapshot }>;
    runs.set(snapshot.runId, { progress: snapshot });

    await expect(service.getProvisioningStatus(snapshot.runId)).resolves.toBe(snapshot);
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
