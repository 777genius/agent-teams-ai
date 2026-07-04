import { vi } from 'vitest';

import type { TeamProvisioningConfigFacade } from '@main/services/team/provisioning/TeamProvisioningConfigFacade';
import type {
  TeamProvisioningMemberLifecycleController,
  TeamProvisioningMemberLifecycleHost,
} from '@main/services/team/provisioning/TeamProvisioningMemberLifecycle';
import type { TeamProvisioningRuntimeResourceSampling } from '@main/services/team/provisioning/TeamProvisioningRuntimeResourceSampling';
import type { OpenCodeTeamRuntimeMessageResult } from '@main/services/team/runtime/OpenCodeTeamRuntimeAdapter';
import type { createPersistedLaunchSnapshot } from '@main/services/team/TeamLaunchStateEvaluator';
import type { TeamProvisioningService } from '@main/services/team/TeamProvisioningService';

export type TeamProvisioningServicePrivateHarness = {
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
  aliveRunByTeam: Map<string, string>;
  readRecentBootstrapTranscriptOutcome: (
    filePath: string,
    sinceMs: number | null,
    memberName: string,
    teamName: string,
    options?: { allowAnonymousFailure?: boolean; contextMemberNames?: readonly string[] }
  ) => Promise<{ kind: string; observedAt: string; source?: string; reason?: string } | null>;
  readPersistedRuntimeMembers: (teamName: string) => Array<Record<string, unknown>>;
  readPersistedTeamProjectPath: (teamName: string) => string | null;
};

export function privateHarness(
  svc: TeamProvisioningService
): TeamProvisioningServicePrivateHarness {
  return svc as unknown as TeamProvisioningServicePrivateHarness;
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
