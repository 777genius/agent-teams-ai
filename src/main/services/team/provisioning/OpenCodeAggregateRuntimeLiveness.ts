import type { ProvisioningRun } from './TeamProvisioningRunModel';

interface OpenCodeAggregateRuntimeLivenessPorts {
  getAliveRunId(teamName: string): string | null;
  hasPrimaryRuntime(teamName: string, runId: string): boolean;
  hasSecondaryRuntime(teamName: string): boolean;
  getRuntimeProgressState(runId: string): string | undefined;
  getRun(runId: string): ProvisioningRun | undefined;
}

/** Read-only liveness policy for an aggregate OpenCode runtime composition. */
export class OpenCodeAggregateRuntimeLiveness {
  constructor(private readonly ports: OpenCodeAggregateRuntimeLivenessPorts) {}

  isTeamAlive(teamName: string): boolean {
    const runId = this.ports.getAliveRunId(teamName);
    if (!runId) return false;

    const hasPrimaryRuntime = this.ports.hasPrimaryRuntime(teamName, runId);
    const hasSecondaryRuntime = this.ports.hasSecondaryRuntime(teamName);
    const runtimeProgressState = this.ports.getRuntimeProgressState(runId);
    if (
      !hasSecondaryRuntime &&
      (runtimeProgressState === 'disconnected' ||
        runtimeProgressState === 'failed' ||
        runtimeProgressState === 'cancelled')
    ) {
      return false;
    }

    const run = this.ports.getRun(runId);
    if (!run) return hasPrimaryRuntime || hasSecondaryRuntime;
    if (hasPrimaryRuntime || hasSecondaryRuntime) {
      return !run.processKilled && !run.cancelRequested;
    }
    return run.child != null && !run.processKilled && !run.cancelRequested;
  }
}
