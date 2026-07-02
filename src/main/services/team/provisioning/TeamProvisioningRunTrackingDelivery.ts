import type { TeamProvisioningProgress } from '@shared/types';

type RuntimeProgressState = TeamProvisioningProgress['state'];

export interface RunTrackingProvisioningRun {
  processKilled: boolean;
  cancelRequested: boolean;
  progress: Pick<TeamProvisioningProgress, 'state'>;
}

export interface RunTrackingRuntimeAdapterRun {
  runId: string;
}

export interface TeamProvisioningRunTrackingDeliveryState<
  TRun extends RunTrackingProvisioningRun = RunTrackingProvisioningRun,
> {
  provisioningRunByTeam: Map<string, string>;
  aliveRunByTeam: Map<string, string>;
  runs: ReadonlyMap<string, TRun>;
  runtimeAdapterProgressByRunId: ReadonlyMap<string, Pick<TeamProvisioningProgress, 'state'>>;
  runtimeAdapterRunByTeam: ReadonlyMap<string, RunTrackingRuntimeAdapterRun>;
  getRetainedProvisioningProgressMap(): ReadonlyMap<
    string,
    Pick<TeamProvisioningProgress, 'state'>
  >;
}

export interface TeamProvisioningRunTrackingDeliveryPorts {
  notifyTeamWatchScopeChanged(): void;
  isTeamAlive(teamName: string): boolean;
  hasAlivePersistedTeamProcess(teamName: string): boolean;
  hasOnlyExplicitlyStoppedPersistedTeamProcesses(teamName: string): boolean;
  logDebug(message: string): void;
}

export interface TeamProvisioningRunTrackingDeliveryOptions<
  TRun extends RunTrackingProvisioningRun = RunTrackingProvisioningRun,
> {
  state: TeamProvisioningRunTrackingDeliveryState<TRun>;
  ports: TeamProvisioningRunTrackingDeliveryPorts;
  liveRuntimeSnapshotCacheTtlMs: number;
  persistedRuntimeSnapshotCacheTtlMs: number;
}

const TERMINAL_RUNTIME_PROGRESS_STATES = new Set<RuntimeProgressState>([
  'disconnected',
  'failed',
  'cancelled',
]);

function isTerminalRuntimeProgressState(state: RuntimeProgressState): boolean {
  return TERMINAL_RUNTIME_PROGRESS_STATES.has(state);
}

function isNonEmptyRunId(runId: string | undefined): runId is string {
  return typeof runId === 'string' && runId.trim() !== '';
}

export class TeamProvisioningRunTrackingDeliveryHelper<
  TRun extends RunTrackingProvisioningRun = RunTrackingProvisioningRun,
> {
  constructor(private readonly options: TeamProvisioningRunTrackingDeliveryOptions<TRun>) {}

  getProvisioningRunId(teamName: string): string | null {
    return this.options.state.provisioningRunByTeam.get(teamName) ?? null;
  }

  getResolvableProvisioningRunId(teamName: string): string | null {
    const runId = this.getProvisioningRunId(teamName);
    if (!runId) {
      return null;
    }
    if (
      this.options.state.runs.has(runId) ||
      this.options.state.runtimeAdapterProgressByRunId.has(runId)
    ) {
      return runId;
    }
    if (this.options.state.provisioningRunByTeam.get(teamName) === runId) {
      this.options.state.provisioningRunByTeam.delete(teamName);
    }
    this.options.ports.logDebug(
      `[${teamName}] Cleared stale provisioning run id before launch: ${runId}`
    );
    return null;
  }

  getAliveRunId(teamName: string): string | null {
    return this.options.state.aliveRunByTeam.get(teamName) ?? null;
  }

  setAliveRunId(teamName: string, runId: string): void {
    if (!teamName || !runId || this.options.state.aliveRunByTeam.get(teamName) === runId) {
      return;
    }
    this.options.state.aliveRunByTeam.set(teamName, runId);
    this.options.ports.notifyTeamWatchScopeChanged();
  }

  deleteAliveRunId(teamName: string): void {
    if (this.options.state.aliveRunByTeam.delete(teamName)) {
      this.options.ports.notifyTeamWatchScopeChanged();
    }
  }

  getAliveTeamNames(): string[] {
    return [...this.options.state.aliveRunByTeam.keys()];
  }

  getTrackedRunId(teamName: string): string | null {
    return this.getProvisioningRunId(teamName) ?? this.getAliveRunId(teamName);
  }

  getAgentRuntimeSnapshotCacheTtlMs(teamName: string, runId: string | null): number {
    if (runId || this.options.state.runtimeAdapterRunByTeam.has(teamName)) {
      return this.options.liveRuntimeSnapshotCacheTtlMs;
    }
    return this.options.persistedRuntimeSnapshotCacheTtlMs;
  }

  canDeliverToTrackedRuntimeRun(teamName: string, runId: string): boolean {
    const runtimeProgress =
      this.options.state.runtimeAdapterProgressByRunId.get(runId) ??
      this.options.state.getRetainedProvisioningProgressMap().get(runId);
    if (runtimeProgress && isTerminalRuntimeProgressState(runtimeProgress.state)) {
      return false;
    }

    const run = this.options.state.runs.get(runId);
    if (
      run &&
      (run.processKilled ||
        run.cancelRequested ||
        isTerminalRuntimeProgressState(run.progress.state))
    ) {
      return false;
    }

    return (
      this.options.state.runtimeAdapterRunByTeam.get(teamName)?.runId === runId ||
      this.options.state.provisioningRunByTeam.get(teamName) === runId ||
      this.options.state.aliveRunByTeam.get(teamName) === runId
    );
  }

  resolveDeliverableTrackedRuntimeRunId(teamName: string): string | null {
    const candidates = Array.from(
      new Set(
        [
          this.options.state.provisioningRunByTeam.get(teamName),
          this.options.state.aliveRunByTeam.get(teamName),
          this.options.state.runtimeAdapterRunByTeam.get(teamName)?.runId,
        ].filter(isNonEmptyRunId)
      )
    );
    for (const runId of candidates) {
      if (this.canDeliverToTrackedRuntimeRun(teamName, runId)) {
        return runId;
      }
    }
    return null;
  }

  canDeliverToOpenCodeRuntimeForTeam(teamName: string): boolean {
    if (this.options.ports.isTeamAlive(teamName)) {
      return true;
    }
    return this.options.ports.hasAlivePersistedTeamProcess(teamName);
  }

  canAttemptCommittedOpenCodeSessionRecovery(teamName: string): boolean {
    if (this.canDeliverToOpenCodeRuntimeForTeam(teamName)) {
      return true;
    }
    return !this.options.ports.hasOnlyExplicitlyStoppedPersistedTeamProcesses(teamName);
  }
}
