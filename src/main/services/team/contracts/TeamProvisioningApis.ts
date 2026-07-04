import type {
  TeamCreateRequest,
  TeamCreateResponse,
  TeamLaunchRequest,
  TeamLaunchResponse,
  TeamProvisioningProgress,
  TeamRuntimeState,
} from '@shared/types/team';

export interface TeamProvisioningStartApi {
  createTeam(
    request: TeamCreateRequest,
    onProgress: (progress: TeamProvisioningProgress) => void
  ): Promise<TeamCreateResponse>;
  launchTeam(
    request: TeamLaunchRequest,
    onProgress: (progress: TeamProvisioningProgress) => void
  ): Promise<TeamLaunchResponse>;
  getProvisioningStatus(runId: string): Promise<TeamProvisioningProgress>;
  repairStaleTaskActivityIntervalsBeforeSnapshot?(teamName: string): Promise<void>;
}

export interface OpenCodeRuntimeControlAck {
  ok: true;
  providerId: 'opencode';
  teamName: string;
  runId: string;
  state: 'accepted' | 'delivered' | 'duplicate' | 'recorded';
  memberName?: string;
  runtimeSessionId?: string;
  idempotencyKey?: string;
  location?: unknown;
  diagnostics: string[];
  observedAt: string;
}

export interface TeamRuntimeApi {
  getRuntimeState(teamName: string): Promise<TeamRuntimeState>;
  stopTeam(teamName: string): Promise<void>;
  isTeamAlive(teamName: string): boolean;
  getAliveTeams(): string[];
  getCurrentRunId(teamName: string): string | null;
  recordOpenCodeRuntimeBootstrapCheckin(raw: unknown): Promise<OpenCodeRuntimeControlAck>;
  deliverOpenCodeRuntimeMessage(raw: unknown): Promise<OpenCodeRuntimeControlAck>;
  recordOpenCodeRuntimeTaskEvent(raw: unknown): Promise<OpenCodeRuntimeControlAck>;
  recordOpenCodeRuntimeHeartbeat(raw: unknown): Promise<OpenCodeRuntimeControlAck>;
}
