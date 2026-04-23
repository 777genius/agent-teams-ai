import type {
  EffortLevel,
  MemberLaunchState,
  PersistedTeamLaunchPhase,
  PersistedTeamLaunchSnapshot,
  TeamAgentRuntimeBackendType,
  TeamLaunchAggregateState,
} from '@shared/types';

export const TEAM_RUNTIME_PROVIDER_IDS = ['anthropic', 'codex', 'gemini', 'opencode'] as const;

export type TeamRuntimeProviderId = (typeof TEAM_RUNTIME_PROVIDER_IDS)[number];

export interface TeamRuntimeMemberSpec {
  name: string;
  role?: string;
  workflow?: string;
  isolation?: 'worktree';
  providerId: TeamRuntimeProviderId;
  model?: string;
  effort?: EffortLevel;
  cwd: string;
}

export interface TeamRuntimeLaunchInput {
  runId: string;
  teamName: string;
  laneId?: string;
  cwd: string;
  prompt?: string;
  providerId: TeamRuntimeProviderId;
  model?: string;
  effort?: EffortLevel;
  /**
   * Runtime-only preflight skips model-scoped execution/evidence checks.
   * Use only for warm-up diagnostics before a concrete launch model is selected.
   */
  runtimeOnly?: boolean;
  skipPermissions: boolean;
  expectedMembers: TeamRuntimeMemberSpec[];
  previousLaunchState: PersistedTeamLaunchSnapshot | null;
}

export interface TeamRuntimePrepareSuccess {
  ok: true;
  providerId: TeamRuntimeProviderId;
  modelId: string | null;
  diagnostics: string[];
  warnings: string[];
}

export interface TeamRuntimePrepareFailure {
  ok: false;
  providerId: TeamRuntimeProviderId;
  reason: string;
  diagnostics: string[];
  warnings: string[];
  retryable: boolean;
}

export type TeamRuntimePrepareResult = TeamRuntimePrepareSuccess | TeamRuntimePrepareFailure;

export interface TeamRuntimeMemberLaunchEvidence {
  memberName: string;
  providerId: TeamRuntimeProviderId;
  launchState: MemberLaunchState;
  agentToolAccepted: boolean;
  runtimeAlive: boolean;
  bootstrapConfirmed: boolean;
  hardFailure: boolean;
  hardFailureReason?: string;
  pendingPermissionRequestIds?: string[];
  sessionId?: string;
  backendType?: TeamAgentRuntimeBackendType;
  runtimePid?: number;
  diagnostics: string[];
}

export interface TeamRuntimeLaunchResult {
  runId: string;
  teamName: string;
  leadSessionId?: string;
  launchPhase: PersistedTeamLaunchPhase;
  teamLaunchState: TeamLaunchAggregateState;
  members: Record<string, TeamRuntimeMemberLaunchEvidence>;
  warnings: string[];
  diagnostics: string[];
}

export type TeamRuntimeReconcileReason =
  | 'startup_recovery'
  | 'manual_refresh'
  | 'launch_progress'
  | 'provider_event'
  | 'watcher_event'
  | 'stop';

export interface TeamRuntimeReconcileInput {
  runId: string;
  teamName: string;
  laneId?: string;
  providerId: TeamRuntimeProviderId;
  expectedMembers: TeamRuntimeMemberSpec[];
  previousLaunchState: PersistedTeamLaunchSnapshot | null;
  reason: TeamRuntimeReconcileReason;
}

export interface TeamRuntimeReconcileResult {
  runId: string;
  teamName: string;
  launchPhase: PersistedTeamLaunchPhase;
  teamLaunchState: TeamLaunchAggregateState;
  members: Record<string, TeamRuntimeMemberLaunchEvidence>;
  snapshot: PersistedTeamLaunchSnapshot | null;
  warnings: string[];
  diagnostics: string[];
}

export type TeamRuntimeStopReason = 'user_requested' | 'relaunch' | 'cleanup' | 'app_shutdown';

export interface TeamRuntimeStopInput {
  runId: string;
  teamName: string;
  laneId?: string;
  cwd?: string;
  providerId: TeamRuntimeProviderId;
  reason: TeamRuntimeStopReason;
  previousLaunchState: PersistedTeamLaunchSnapshot | null;
  force?: boolean;
}

export interface TeamRuntimeMemberStopEvidence {
  memberName: string;
  providerId: TeamRuntimeProviderId;
  stopped: boolean;
  sessionId?: string;
  diagnostics: string[];
}

export interface TeamRuntimeStopResult {
  runId: string;
  teamName: string;
  stopped: boolean;
  members: Record<string, TeamRuntimeMemberStopEvidence>;
  warnings: string[];
  diagnostics: string[];
}

export interface TeamLaunchRuntimeAdapter {
  readonly providerId: TeamRuntimeProviderId;
  prepare(input: TeamRuntimeLaunchInput): Promise<TeamRuntimePrepareResult>;
  launch(input: TeamRuntimeLaunchInput): Promise<TeamRuntimeLaunchResult>;
  reconcile(input: TeamRuntimeReconcileInput): Promise<TeamRuntimeReconcileResult>;
  stop(input: TeamRuntimeStopInput): Promise<TeamRuntimeStopResult>;
}

export function isTeamRuntimeProviderId(value: unknown): value is TeamRuntimeProviderId {
  return value === 'anthropic' || value === 'codex' || value === 'gemini' || value === 'opencode';
}

export class TeamRuntimeAdapterRegistry {
  private readonly adapters = new Map<TeamRuntimeProviderId, TeamLaunchRuntimeAdapter>();

  constructor(adapters: readonly TeamLaunchRuntimeAdapter[] = []) {
    for (const adapter of adapters) {
      this.register(adapter);
    }
  }

  register(adapter: TeamLaunchRuntimeAdapter): void {
    if (!isTeamRuntimeProviderId(adapter.providerId)) {
      throw new Error(`Invalid runtime adapter provider: ${String(adapter.providerId)}`);
    }
    if (this.adapters.has(adapter.providerId)) {
      throw new Error(`Runtime adapter already registered: ${adapter.providerId}`);
    }
    this.adapters.set(adapter.providerId, adapter);
  }

  get(providerId: TeamRuntimeProviderId): TeamLaunchRuntimeAdapter {
    const adapter = this.adapters.get(providerId);
    if (!adapter) {
      throw new Error(`Runtime adapter is not available for provider ${providerId}`);
    }
    return adapter;
  }

  has(providerId: TeamRuntimeProviderId): boolean {
    return this.adapters.has(providerId);
  }

  providers(): TeamRuntimeProviderId[] {
    return Array.from(this.adapters.keys());
  }
}
