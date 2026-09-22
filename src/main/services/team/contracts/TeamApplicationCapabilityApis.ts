import type {
  TeamCreateConfigRequest,
  TeamCreateRequest,
  TeamCreateResponse,
  TeamLaunchRequest,
  TeamLaunchResponse,
  TeamProvisioningProgress,
  TeamRuntimeState,
  TeamSummary,
  TeamViewSnapshot,
} from '@shared/types/team';

/**
 * Provider-neutral data operations consumed by the team application host.
 *
 * This contract deliberately contains only application-visible data methods;
 * provider execution, process supervision, and transport concerns stay behind
 * their respective capability boundaries.
 */
export interface TeamApplicationDataApi {
  listTeams(): Promise<TeamSummary[]>;
  getTeamData(teamName: string): Promise<TeamViewSnapshot>;
  getSavedRequest(teamName: string): Promise<TeamCreateRequest | null>;
  createTeamConfig(request: TeamCreateConfigRequest): Promise<void>;
}

/** Application-visible create and launch commands. */
export interface TeamApplicationProvisioningStartApi {
  createTeam(
    request: TeamCreateRequest,
    onProgress: (progress: TeamProvisioningProgress) => void
  ): Promise<TeamCreateResponse>;
  launchTeam(
    request: TeamLaunchRequest,
    onProgress: (progress: TeamProvisioningProgress) => void
  ): Promise<TeamLaunchResponse>;
}

/** Application-visible provisioning status query. */
export interface TeamApplicationProvisioningStatusApi {
  getProvisioningStatus(runId: string): Promise<TeamProvisioningProgress>;
}

/** Application-visible runtime read/stop operations. */
export interface TeamApplicationRuntimeApi {
  getRuntimeState(teamName: string): Promise<TeamRuntimeState>;
  stopTeam(teamName: string): Promise<void>;
  getAliveTeams(): string[];
}

/**
 * Provider-neutral runtime ingress acknowledgements exposed to application
 * hosts. Provider adapters retain ownership of their payload vocabulary.
 */
export interface TeamApplicationRuntimeIngressAck {
  readonly ok: true;
  readonly providerId: string;
  readonly teamName: string;
  readonly runId: string;
  readonly state: 'accepted' | 'delivered' | 'duplicate' | 'recorded';
  readonly memberName?: string;
  readonly runtimeSessionId?: string;
  readonly idempotencyKey?: string;
  readonly location?: Readonly<Record<string, string | number | boolean | null>>;
  readonly diagnostics: readonly string[];
  readonly observedAt: string;
}

/**
 * Application-visible callbacks from a runtime lane. Input translation stays
 * in the provider compatibility adapter at the transport edge.
 */
export interface TeamApplicationRuntimeIngressApi {
  recordRuntimeBootstrapCheckin(payload: unknown): Promise<TeamApplicationRuntimeIngressAck>;
  deliverRuntimeMessage(payload: unknown): Promise<TeamApplicationRuntimeIngressAck>;
  recordRuntimeTaskEvent(payload: unknown): Promise<TeamApplicationRuntimeIngressAck>;
  recordRuntimeHeartbeat(payload: unknown): Promise<TeamApplicationRuntimeIngressAck>;
}

/** Explicit snapshot reconciliation needed before an application read. */
export interface TeamApplicationTaskActivityApi {
  repairStaleTaskActivityIntervalsBeforeSnapshot(teamName: string): Promise<void>;
}

/** Post-write work-sync resumption delegated to its existing owner. */
export interface TeamApplicationResumeApi {
  resumeTeam(teamName: string): void;
}
