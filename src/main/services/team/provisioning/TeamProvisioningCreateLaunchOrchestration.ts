import { createLogger } from '@shared/utils/logger';
import { randomUUID } from 'crypto';

import {
  type AnthropicApiKeyHelperCleanupRetryOwner,
  type AnthropicApiKeyHelperSetupLease,
  throwIfAnthropicApiKeyHelperCleanupRemainsSourceOwned,
} from './TeamProvisioningAnthropicApiKeyHelperLease';
import {
  type DeterministicCreateRunFlowPorts,
  runDeterministicCreateRunFlow,
} from './TeamProvisioningCreateDeterministicRunFlow';
import {
  type DeterministicCreateSetupFlowPorts,
  prepareDeterministicCreateSetupFlow,
} from './TeamProvisioningCreateDeterministicSetupFlow';
import { type DeterministicCreateSpawnFlowPorts } from './TeamProvisioningCreateDeterministicSpawnFlow';
import { assertAppDeterministicBootstrapEnabled } from './TeamProvisioningEnvGuards';
import { assertOpenCodeNotLaunchedThroughLegacyProvisioning } from './TeamProvisioningLaunchCompatibility';
import {
  runDeterministicLaunchRunFlow,
  type RunDeterministicLaunchRunFlowPorts,
} from './TeamProvisioningLaunchDeterministicRunFlow';
import {
  type DeterministicLaunchSetupPorts,
  type DeterministicLaunchSetupResult,
  prepareDeterministicLaunchSetup,
} from './TeamProvisioningLaunchDeterministicSetupFlow';
import {
  APP_TEAM_RUNTIME_DISALLOWED_TOOLS,
  type ProvisioningRun,
} from './TeamProvisioningRunModel';
import { nowIso } from './TeamProvisioningRunProgress';
import { type MixedSecondaryRuntimeLaneState } from './TeamProvisioningSecondaryRuntimeRuns';

import type {
  PersistedTeamLaunchSnapshot,
  TeamCreateRequest,
  TeamCreateResponse,
  TeamLaunchRequest,
  TeamLaunchResponse,
  TeamProviderId,
  TeamProvisioningProgress,
} from '@shared/types';

const logger = createLogger('Service:TeamProvisioning');

export interface TeamProvisioningCreateLaunchOrchestrationServiceHost {
  anthropicApiKeyHelperCleanupRetryOwner: AnthropicApiKeyHelperCleanupRetryOwner;
  cleanedStoppedTeamOpenCodeRuntimeLanes: Set<string>;
  runTracking: {
    getResolvableProvisioningRunId(teamName: string): string | null;
  };
  configTaskActivityBoundary: {
    readTaskActivityRepairLaunchSnapshot(
      teamName: string
    ): Promise<PersistedTeamLaunchSnapshot | null>;
    repairStaleTaskActivityIntervalsOnce(
      teamName: string,
      previousLaunchSnapshot: PersistedTeamLaunchSnapshot | null
    ): void;
  };
  initializeToolApprovalSettingsForLaunch(
    teamName: string,
    skipPermissions: boolean | undefined
  ): void;
  stopAllTeamsGeneration: number;
  provisioningRunByTeam: Map<string, string>;
  shouldRouteOpenCodeToRuntimeAdapter(request: {
    providerId?: TeamProviderId;
    members?: readonly { providerId?: TeamProviderId; provider?: TeamProviderId }[];
  }): boolean;
  createOpenCodeTeamThroughRuntimeAdapter(
    request: TeamCreateRequest,
    onProgress: (progress: TeamProvisioningProgress) => void
  ): Promise<TeamCreateResponse>;
  launchOpenCodeTeamThroughRuntimeAdapter(
    request: TeamLaunchRequest,
    onProgress: (progress: TeamProvisioningProgress) => void
  ): Promise<TeamLaunchResponse>;
  createDeterministicCreateSetupFlowPorts(): DeterministicCreateSetupFlowPorts<MixedSecondaryRuntimeLaneState>;
  createDeterministicCreateRunFlowPorts(): DeterministicCreateRunFlowPorts<
    ProvisioningRun,
    MixedSecondaryRuntimeLaneState
  >;
  createDeterministicCreateSpawnFlowPorts(input: {
    request: TeamCreateRequest;
    claudePath: string;
    shellEnv: NodeJS.ProcessEnv;
  }): DeterministicCreateSpawnFlowPorts<ProvisioningRun>;
  deterministicLaunchFlowBoundary: {
    createSetupPorts(): DeterministicLaunchSetupPorts<MixedSecondaryRuntimeLaneState>;
    createRunFlowPorts(input: {
      request: TeamLaunchRequest;
      setup: Extract<
        DeterministicLaunchSetupResult<MixedSecondaryRuntimeLaneState>,
        { kind: 'prepared' }
      >;
    }): RunDeterministicLaunchRunFlowPorts<MixedSecondaryRuntimeLaneState>;
  };
}

async function cleanupSetupLeaseOrRetainRetryOwner(
  lease: AnthropicApiKeyHelperSetupLease | null,
  retryOwner: AnthropicApiKeyHelperCleanupRetryOwner
): Promise<void> {
  if (!lease) {
    return;
  }
  try {
    await lease.cleanup();
  } catch (error) {
    const retention = await retryOwner.retainSetupLease(lease);
    throwIfAnthropicApiKeyHelperCleanupRemainsSourceOwned(retention, error);
  }
}

export async function createTeamInnerWithService(
  service: TeamProvisioningCreateLaunchOrchestrationServiceHost,
  request: TeamCreateRequest,
  onProgress: (progress: TeamProvisioningProgress) => void
): Promise<TeamCreateResponse> {
  service.cleanedStoppedTeamOpenCodeRuntimeLanes.delete(request.teamName);
  await service.anthropicApiKeyHelperCleanupRetryOwner.retryPendingForTeam(request.teamName);
  const existingProvisioningRunId = service.runTracking.getResolvableProvisioningRunId(
    request.teamName
  );
  if (existingProvisioningRunId) {
    service.initializeToolApprovalSettingsForLaunch(request.teamName, request.skipPermissions);
    return {
      runId: existingProvisioningRunId,
      launchStatus: 'already_launching',
      alreadyLaunching: true,
    };
  }
  const stopAllGenerationAtStart = service.stopAllTeamsGeneration;
  const previousLaunchSnapshot =
    await service.configTaskActivityBoundary.readTaskActivityRepairLaunchSnapshot(request.teamName);
  if (service.stopAllTeamsGeneration !== stopAllGenerationAtStart) {
    throw new Error('Team launch cancelled by app shutdown');
  }
  service.configTaskActivityBoundary.repairStaleTaskActivityIntervalsOnce(
    request.teamName,
    previousLaunchSnapshot
  );
  assertAppDeterministicBootstrapEnabled();
  service.initializeToolApprovalSettingsForLaunch(request.teamName, request.skipPermissions);
  if (service.shouldRouteOpenCodeToRuntimeAdapter(request)) {
    return service.createOpenCodeTeamThroughRuntimeAdapter(request, onProgress);
  }
  assertOpenCodeNotLaunchedThroughLegacyProvisioning(request);

  const pendingKey = `pending-${randomUUID()}`;
  service.provisioningRunByTeam.set(request.teamName, pendingKey);
  let createSetupLease:
    | Awaited<ReturnType<typeof prepareDeterministicCreateSetupFlow>>['anthropicApiKeyHelperLease']
    | null = null;

  try {
    const runtimeAuthMaterialId = randomUUID();
    const createSetup = await prepareDeterministicCreateSetupFlow({
      request,
      runtimeAuthMaterialId,
      ports: service.createDeterministicCreateSetupFlowPorts(),
    });
    createSetupLease = createSetup.anthropicApiKeyHelperLease;
    return await runDeterministicCreateRunFlow({
      request,
      onProgress,
      createSetup,
      runId: randomUUID(),
      startedAt: nowIso(),
      stopAllGenerationAtStart,
      disallowedTools: APP_TEAM_RUNTIME_DISALLOWED_TOOLS,
      logger,
      spawnPorts: service.createDeterministicCreateSpawnFlowPorts({
        request,
        claudePath: createSetup.claudePath,
        shellEnv: createSetup.shellEnv,
      }),
      ports: service.createDeterministicCreateRunFlowPorts(),
    });
  } catch (error) {
    let cleanupOwnershipError: unknown = null;
    try {
      await cleanupSetupLeaseOrRetainRetryOwner(
        createSetupLease,
        service.anthropicApiKeyHelperCleanupRetryOwner
      );
    } catch (cleanupError) {
      cleanupOwnershipError = cleanupError;
    }
    if (service.provisioningRunByTeam.get(request.teamName) === pendingKey) {
      service.provisioningRunByTeam.delete(request.teamName);
    }
    throw cleanupOwnershipError ?? error;
  }
}

export async function launchTeamInnerWithService(
  service: TeamProvisioningCreateLaunchOrchestrationServiceHost,
  request: TeamLaunchRequest,
  onProgress: (progress: TeamProvisioningProgress) => void
): Promise<TeamLaunchResponse> {
  await service.anthropicApiKeyHelperCleanupRetryOwner.retryPendingForTeam(request.teamName);
  const existingProvisioningRunId = service.runTracking.getResolvableProvisioningRunId(
    request.teamName
  );
  if (existingProvisioningRunId) {
    service.initializeToolApprovalSettingsForLaunch(request.teamName, request.skipPermissions);
    return {
      runId: existingProvisioningRunId,
      launchStatus: 'already_launching',
      alreadyLaunching: true,
    };
  }
  const stopAllGenerationAtStart = service.stopAllTeamsGeneration;
  assertAppDeterministicBootstrapEnabled();
  service.initializeToolApprovalSettingsForLaunch(request.teamName, request.skipPermissions);
  if (service.shouldRouteOpenCodeToRuntimeAdapter(request)) {
    return service.launchOpenCodeTeamThroughRuntimeAdapter(request, onProgress);
  }
  assertOpenCodeNotLaunchedThroughLegacyProvisioning(request);

  const pendingKey = `pending-${randomUUID()}`;
  service.provisioningRunByTeam.set(request.teamName, pendingKey);
  let launchSetupLease:
    | Extract<
        DeterministicLaunchSetupResult<MixedSecondaryRuntimeLaneState>,
        { kind: 'prepared' }
      >['anthropicApiKeyHelperLease']
    | null = null;

  try {
    const setup = await prepareDeterministicLaunchSetup(
      request,
      service.deterministicLaunchFlowBoundary.createSetupPorts()
    );
    if (setup.kind === 'reuse') {
      return {
        runId: setup.runId,
        launchStatus: 'already_running',
        alreadyRunning: true,
      };
    }
    launchSetupLease = setup.anthropicApiKeyHelperLease;

    return runDeterministicLaunchRunFlow(
      {
        request,
        setup,
        stopAllGenerationAtStart,
        onProgress,
        teammateRuntimeDisallowedTools: APP_TEAM_RUNTIME_DISALLOWED_TOOLS,
      },
      service.deterministicLaunchFlowBoundary.createRunFlowPorts({ request, setup })
    );
  } catch (error) {
    let cleanupOwnershipError: unknown = null;
    try {
      await cleanupSetupLeaseOrRetainRetryOwner(
        launchSetupLease,
        service.anthropicApiKeyHelperCleanupRetryOwner
      );
    } catch (cleanupError) {
      cleanupOwnershipError = cleanupError;
    }
    if (service.provisioningRunByTeam.get(request.teamName) === pendingKey) {
      service.provisioningRunByTeam.delete(request.teamName);
    }
    throw cleanupOwnershipError ?? error;
  }
}
