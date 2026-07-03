import type { TeamProviderId, TeamProvisioningProgress, TeamRuntimeState } from '@shared/types';

export interface TeamProvisioningRuntimeStateProjectionRun {
  runId: string;
  child: unknown | null | undefined;
  processKilled: boolean;
  cancelRequested: boolean;
  progress: TeamProvisioningProgress;
}

export interface TeamProvisioningRuntimeStateProjectionRuntimeAdapterRun {
  runId: string;
  providerId: TeamProviderId;
}

export interface TeamProvisioningRuntimeStateProjectionState<
  TRun extends TeamProvisioningRuntimeStateProjectionRun =
    TeamProvisioningRuntimeStateProjectionRun,
> {
  provisioningRunByTeam: ReadonlyMap<string, string>;
  runs: ReadonlyMap<string, TRun>;
  runtimeAdapterRunByTeam: ReadonlyMap<
    string,
    TeamProvisioningRuntimeStateProjectionRuntimeAdapterRun
  >;
  runtimeAdapterProgressByRunId: ReadonlyMap<string, TeamProvisioningProgress>;
  getRetainedProvisioningProgressMap(): ReadonlyMap<string, TeamProvisioningProgress>;
}

export interface TeamProvisioningRuntimeStateProjectionPorts {
  getAliveRunId(teamName: string): string | null;
  getTrackedRunId(teamName: string): string | null;
  getAliveTeamNames(): string[];
  hasSecondaryRuntimeRuns(teamName: string): boolean;
  readBootstrapRuntimeState(teamName: string): Promise<TeamRuntimeState | null>;
}

export interface TeamProvisioningRuntimeStateProjectionOptions<
  TRun extends TeamProvisioningRuntimeStateProjectionRun =
    TeamProvisioningRuntimeStateProjectionRun,
> {
  state: TeamProvisioningRuntimeStateProjectionState<TRun>;
  ports: TeamProvisioningRuntimeStateProjectionPorts;
}

export class TeamProvisioningRuntimeStateProjection<
  TRun extends TeamProvisioningRuntimeStateProjectionRun =
    TeamProvisioningRuntimeStateProjectionRun,
> {
  constructor(private readonly options: TeamProvisioningRuntimeStateProjectionOptions<TRun>) {}

  hasProvisioningRun(teamName: string): boolean {
    return this.options.state.provisioningRunByTeam.has(teamName);
  }

  isTeamAlive(teamName: string): boolean {
    const runId = this.options.ports.getAliveRunId(teamName);
    if (!runId) return false;

    const run = this.options.state.runs.get(runId);
    if (!run && this.options.state.runtimeAdapterRunByTeam.get(teamName)?.runId === runId) {
      return true;
    }

    if (run && this.options.ports.hasSecondaryRuntimeRuns(teamName)) {
      return !run.processKilled && !run.cancelRequested;
    }

    return run?.child != null && !run.processKilled && !run.cancelRequested;
  }

  getAliveTeams(): string[] {
    return this.options.ports.getAliveTeamNames().filter((teamName) => this.isTeamAlive(teamName));
  }

  async getRuntimeState(teamName: string): Promise<TeamRuntimeState> {
    const runId = this.options.ports.getTrackedRunId(teamName);
    const run = runId ? (this.options.state.runs.get(runId) ?? null) : null;

    if (!run) {
      const recovered = await this.options.ports.readBootstrapRuntimeState(teamName);
      if (recovered) {
        return recovered;
      }
    }

    return {
      teamName,
      isAlive: this.isTeamAlive(teamName),
      runId: run?.runId ?? runId ?? null,
      progress:
        run?.progress ??
        (runId
          ? (this.options.state.runtimeAdapterProgressByRunId.get(runId) ??
            this.options.state.getRetainedProvisioningProgressMap().get(runId) ??
            null)
          : null),
    };
  }
}
