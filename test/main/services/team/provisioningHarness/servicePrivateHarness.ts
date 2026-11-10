import { vi } from 'vitest';

import type { TeamProvisioningConfigFacade } from '@main/services/team/provisioning/TeamProvisioningConfigFacade';
import type { TeamProvisioningMemberLifecycleController } from '@main/services/team/provisioning/TeamProvisioningMemberLifecycle';
import type { TeamProvisioningMemberLifecycleHost } from '@main/services/team/provisioning/TeamProvisioningMemberLifecycleHostPorts';
import type { TeamProvisioningMemberLifecycleServiceUseCases } from '@main/services/team/provisioning/TeamProvisioningMemberLifecycleServiceUseCases';
import type { TeamProvisioningRuntimeResourceSampling } from '@main/services/team/provisioning/TeamProvisioningRuntimeResourceSampling';
import type { UpdateDirectTmuxRestartMemberConfigUseCase } from '@main/services/team/provisioning/TeamProvisioningUpdateDirectTmuxRestartMemberConfigUseCase';
import type { OpenCodeTeamRuntimeMessageResult } from '@main/services/team/runtime/OpenCodeTeamRuntimeAdapter';
import type { createPersistedLaunchSnapshot } from '@main/services/team/TeamLaunchStateEvaluator';
import type { TeamProvisioningService } from '@main/services/team/TeamProvisioningService';
import type { TeamProvisioningProgress } from '@shared/types';

export interface TeamProvisioningServicePrivateRunHarness {
  runId: string;
  teamName: string;
  request: {
    cwd?: string;
  };
  child: unknown;
  processKilled: boolean;
  cancelRequested: boolean;
  // Real runs always carry progress (TeamProvisioningRunModel); run-tracking reads
  // progress.state to clear terminal runs, so harness runs must model it too.
  progress: Pick<TeamProvisioningProgress, 'state'>;
  spawnContext?: {
    cwd?: string;
  };
}

export interface TeamProvisioningServicePrivateRuntimeAdapterProgressHarness {
  runId: TeamProvisioningProgress['runId'];
  state: TeamProvisioningProgress['state'];
}

export interface TeamProvisioningServicePrivateHarness {
  getLiveTeamAgentRuntimeMetadata: (
    teamName: string
  ) => Promise<Map<string, Record<string, unknown>>>;
  attachLiveRuntimeMetadataToStatuses: (
    teamName: string,
    statuses: Record<string, Record<string, unknown>>,
    options?: Record<string, unknown>
  ) => Promise<Record<string, Record<string, unknown>>>;
  applyBootstrapTranscriptEvidenceOverlay: (
    snapshot: ReturnType<typeof createPersistedLaunchSnapshot> | null
  ) => Promise<ReturnType<typeof createPersistedLaunchSnapshot> | null>;
  applyProcessBootstrapTransportOverlay: (
    input: Record<string, unknown>
  ) => Record<string, unknown>;
  reconcilePersistedLaunchState: (teamName: string) => Promise<{
    snapshot: null;
    statuses: Record<string, never>;
  }>;
  sendOpenCodeMemberMessageToRuntimeSerialized: (input: {
    teamName: string;
    laneId: string;
    send: () => Promise<OpenCodeTeamRuntimeMessageResult>;
  }) => Promise<OpenCodeTeamRuntimeMessageResult>;
  getRuntimeSnapshotCacheGeneration: (teamName: string) => number;
  invalidateRuntimeSnapshotCaches: (teamName: string) => void;
  runs: Map<string, TeamProvisioningServicePrivateRunHarness>;
  provisioningRunByTeam: Map<string, string>;
  aliveRunByTeam: Map<string, string>;
  runtimeAdapterProgressByRunId: Map<
    string,
    TeamProvisioningServicePrivateRuntimeAdapterProgressHarness
  >;
  readRecentBootstrapTranscriptOutcome: (
    filePath: string,
    sinceMs: number | null,
    memberName: string,
    teamName: string,
    options?: { allowAnonymousFailure?: boolean; contextMemberNames?: readonly string[] }
  ) => Promise<{ kind: string; observedAt: string; source?: string; reason?: string } | null>;
  readPersistedRuntimeMembers: (teamName: string) => Record<string, unknown>[];
  readPersistedTeamProjectPath: (teamName: string) => string | null;
}

export function privateHarness(
  svc: TeamProvisioningService
): TeamProvisioningServicePrivateHarness {
  return svc as unknown as TeamProvisioningServicePrivateHarness;
}

export function registerAliveRun(
  svc: TeamProvisioningService,
  run: TeamProvisioningServicePrivateRunHarness
): void {
  const harness = privateHarness(svc);
  harness.runs.set(run.runId, run);
  harness.aliveRunByTeam.set(run.teamName, run.runId);
}

export function markTeamRunAlive(
  svc: TeamProvisioningService,
  teamName: string,
  runId: string
): void {
  privateHarness(svc).aliveRunByTeam.set(teamName, runId);
}

export function registerActiveProvisioningRun(
  svc: TeamProvisioningService,
  run: TeamProvisioningServicePrivateRunHarness
): void {
  const harness = privateHarness(svc);
  harness.runs.set(run.runId, run);
  harness.provisioningRunByTeam.set(run.teamName, run.runId);
}

export function registerProvisioningRun(
  svc: TeamProvisioningService,
  teamName: string,
  runId: string,
  options: {
    runtimeAdapterProgressState?: TeamProvisioningServicePrivateRuntimeAdapterProgressHarness['state'];
  } = {}
): void {
  const harness = privateHarness(svc);
  harness.provisioningRunByTeam.set(teamName, runId);
  if (options.runtimeAdapterProgressState) {
    harness.runtimeAdapterProgressByRunId.set(runId, {
      runId,
      state: options.runtimeAdapterProgressState,
    });
  }
}

export function getRegisteredProvisioningRunId(
  svc: TeamProvisioningService,
  teamName: string
): string | undefined {
  return privateHarness(svc).provisioningRunByTeam.get(teamName);
}

export function getResolvableProvisioningRunId(
  svc: TeamProvisioningService,
  teamName: string
): string | null {
  const withRunTracking = svc as unknown as {
    runTracking: { getResolvableProvisioningRunId(teamName: string): string | null };
  };
  return withRunTracking.runTracking.getResolvableProvisioningRunId(teamName);
}

export interface TeamProvisioningOutputRecoveryFacadeHarness {
  updateStdoutParserCarry(run: unknown, carry: string): void;
  flushStdoutParserCarry(run: unknown): void;
  respawnAfterAuthFailure(run: unknown): Promise<void>;
}

export function outputRecoveryFacadeHarness(
  svc: TeamProvisioningService
): TeamProvisioningOutputRecoveryFacadeHarness {
  return (
    svc as unknown as {
      outputRecoveryFacade: TeamProvisioningOutputRecoveryFacadeHarness;
    }
  ).outputRecoveryFacade;
}

export interface TeamProvisioningProviderRuntimeHarness {
  buildProvisioningEnv(
    providerId?: unknown,
    providerBackendId?: unknown,
    options?: unknown
  ): Promise<Record<string, unknown>>;
  validateAgentTeamsMcpRuntime(
    claudePath: string,
    cwd: string,
    env: NodeJS.ProcessEnv,
    mcpConfigPath: string,
    options?: unknown
  ): Promise<void>;
}

export function providerRuntimeHarness(
  svc: TeamProvisioningService
): TeamProvisioningProviderRuntimeHarness {
  return (
    svc as unknown as {
      providerRuntime: TeamProvisioningProviderRuntimeHarness;
    }
  ).providerRuntime;
}

export interface TeamProvisioningVerificationProbePortsHarness {
  waitForValidConfig(run: unknown): Promise<{
    ok: boolean;
    location?: string;
    configPath?: string;
  }>;
  waitForTeamInList(teamName: string, run?: unknown): Promise<boolean>;
  waitForMissingInboxes(run: unknown): Promise<string[]>;
}

export function verificationProbePortsHarness(
  svc: TeamProvisioningService
): TeamProvisioningVerificationProbePortsHarness {
  return (
    svc as unknown as {
      verificationProbePorts: TeamProvisioningVerificationProbePortsHarness;
    }
  ).verificationProbePorts;
}

export function runtimeResourceSamplingHarness(
  svc: TeamProvisioningService
): TeamProvisioningRuntimeResourceSampling {
  return (
    svc as unknown as {
      runtimeResourceSampling: TeamProvisioningRuntimeResourceSampling;
    }
  ).runtimeResourceSampling;
}

export function memberLifecycleControllerHarness(
  svc: TeamProvisioningService
): TeamProvisioningMemberLifecycleController {
  return (
    svc as unknown as {
      memberLifecycleController: TeamProvisioningMemberLifecycleController;
    }
  ).memberLifecycleController;
}

export function memberLifecycleHostHarness(
  svc: TeamProvisioningService
): TeamProvisioningMemberLifecycleHost {
  return (
    svc as unknown as {
      memberLifecycleHost: TeamProvisioningMemberLifecycleHost;
    }
  ).memberLifecycleHost;
}

export function memberLifecycleUseCasesHarness(
  svc: TeamProvisioningService
): TeamProvisioningMemberLifecycleServiceUseCases {
  return (
    svc as unknown as {
      memberLifecycleUseCases: TeamProvisioningMemberLifecycleServiceUseCases;
    }
  ).memberLifecycleUseCases;
}

type MutableMemberLifecycleHostOptionalSeam =
  | 'enqueueDirectRestartPrompt'
  | 'updateDirectTmuxRestartMemberConfig';

interface MutableMemberLifecycleSeamMap {
  enqueueDirectRestartPrompt: NonNullable<
    TeamProvisioningMemberLifecycleHost['enqueueDirectRestartPrompt']
  >;
  updateDirectTmuxRestartMemberConfig: UpdateDirectTmuxRestartMemberConfigUseCase;
}

export function stubMemberLifecycleHostOptionalSeam<
  TKey extends MutableMemberLifecycleHostOptionalSeam,
>(
  svc: TeamProvisioningService,
  key: TKey,
  seam: MutableMemberLifecycleSeamMap[TKey]
): MutableMemberLifecycleSeamMap[TKey] {
  const target =
    key === 'updateDirectTmuxRestartMemberConfig'
      ? memberLifecycleUseCasesHarness(svc)
      : memberLifecycleHostHarness(svc);
  Object.defineProperty(target, key, {
    configurable: true,
    writable: true,
    value: seam,
  });
  return seam;
}

export function provisioningConfigFacadeHarness(
  svc: TeamProvisioningService
): TeamProvisioningConfigFacade {
  return (
    svc as unknown as {
      configFacade: TeamProvisioningConfigFacade;
    }
  ).configFacade;
}

export function stubMemberLifecyclePersistedRuntimeMembers(
  svc: TeamProvisioningService,
  members: ReturnType<TeamProvisioningConfigFacade['readPersistedRuntimeMembers']>
): void {
  memberLifecycleHostHarness(svc).readPersistedRuntimeMembers = vi.fn(() => members);
}

export function stubProvisioningConfigProjectPath(
  svc: TeamProvisioningService,
  projectPath: string
): void {
  provisioningConfigFacadeHarness(svc).readPersistedTeamProjectPath = vi.fn(() => projectPath);
}
