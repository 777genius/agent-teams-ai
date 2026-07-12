import { createLogger } from '@shared/utils/logger';
import { randomUUID } from 'crypto';

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

export async function createTeamInnerWithService(
  service: TeamProvisioningCreateLaunchOrchestrationServiceHost,
  request: TeamCreateRequest,
  onProgress: (progress: TeamProvisioningProgress) => void
): Promise<TeamCreateResponse> {
  service.cleanedStoppedTeamOpenCodeRuntimeLanes.delete(request.teamName);
  const existingProvisioningRunId = service.runTracking.getResolvableProvisioningRunId(
    request.teamName
  );
  if (existingProvisioningRunId) {
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
  if (service.shouldRouteOpenCodeToRuntimeAdapter(request)) {
    return service.createOpenCodeTeamThroughRuntimeAdapter(request, onProgress);
  }
  assertOpenCodeNotLaunchedThroughLegacyProvisioning(request);

  const pendingKey = `pending-${randomUUID()}`;
  service.provisioningRunByTeam.set(request.teamName, pendingKey);

  try {
    const runtimeAuthMaterialId = randomUUID();
    const createSetup = await prepareDeterministicCreateSetupFlow({
      request,
      runtimeAuthMaterialId,
      ports: service.createDeterministicCreateSetupFlowPorts(),
    });
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
    if (service.provisioningRunByTeam.get(request.teamName) === pendingKey) {
      service.provisioningRunByTeam.delete(request.teamName);
    }
    throw error;
  }
}

export async function launchTeamInnerWithService(
  service: TeamProvisioningCreateLaunchOrchestrationServiceHost,
  request: TeamLaunchRequest,
  onProgress: (progress: TeamProvisioningProgress) => void
): Promise<TeamLaunchResponse> {
  const existingProvisioningRunId = service.runTracking.getResolvableProvisioningRunId(
    request.teamName
  );
  if (existingProvisioningRunId) {
    return {
      runId: existingProvisioningRunId,
      launchStatus: 'already_launching',
      alreadyLaunching: true,
    };
  }

  const stopAllGenerationAtStart = service.stopAllTeamsGeneration;
  assertAppDeterministicBootstrapEnabled();
  if (service.shouldRouteOpenCodeToRuntimeAdapter(request)) {
    return service.launchOpenCodeTeamThroughRuntimeAdapter(request, onProgress);
  }
  assertOpenCodeNotLaunchedThroughLegacyProvisioning(request);

  const pendingKey = `pending-${randomUUID()}`;
  service.provisioningRunByTeam.set(request.teamName, pendingKey);

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
    if (service.provisioningRunByTeam.get(request.teamName) === pendingKey) {
      service.provisioningRunByTeam.delete(request.teamName);
    }
    throw error;
  }
}
