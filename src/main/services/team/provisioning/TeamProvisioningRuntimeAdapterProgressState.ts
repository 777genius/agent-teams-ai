import { buildProgressLiveOutput, buildProgressTraceLine } from '../progressPayload';

import { buildProvisioningTraceDetail } from './TeamProvisioningDiagnosticsHelpers';

import type { TeamProvisioningProgress } from '@shared/types';

const PROVISIONING_TRACE_STORAGE_LIMIT = 500;

export interface TeamProvisioningRuntimeAdapterProgressMaps {
  runtimeAdapterProgressByRunId: Map<string, TeamProvisioningProgress>;
  runtimeAdapterTraceLinesByRunId: Map<string, string[]>;
  runtimeAdapterTraceKeyByRunId: Map<string, string>;
}

export interface TeamProvisioningRuntimeAdapterProgressStateOptions {
  state: TeamProvisioningRuntimeAdapterProgressMaps;
  retainProvisioningProgress(runId: string, progress: TeamProvisioningProgress): void;
}

export class TeamProvisioningRuntimeAdapterProgressState {
  constructor(private readonly options: TeamProvisioningRuntimeAdapterProgressStateOptions) {}

  enrichRuntimeAdapterProgressTrace(
    progress: TeamProvisioningProgress
  ): TeamProvisioningProgress {
    const detail = buildProvisioningTraceDetail(progress);
    const key = `${progress.state}\u0000${progress.message}\u0000${detail ?? ''}`;
    const lines = this.options.state.runtimeAdapterTraceLinesByRunId.get(progress.runId) ?? [];
    if (this.options.state.runtimeAdapterTraceKeyByRunId.get(progress.runId) !== key) {
      this.options.state.runtimeAdapterTraceKeyByRunId.set(progress.runId, key);
      lines.push(
        buildProgressTraceLine({
          timestamp: progress.updatedAt,
          state: progress.state,
          message: progress.message,
          detail,
        })
      );
      if (lines.length > PROVISIONING_TRACE_STORAGE_LIMIT) {
        lines.splice(0, lines.length - PROVISIONING_TRACE_STORAGE_LIMIT);
      }
      this.options.state.runtimeAdapterTraceLinesByRunId.set(progress.runId, lines);
    }
    return {
      ...progress,
      assistantOutput: buildProgressLiveOutput(lines, []) ?? progress.assistantOutput,
    };
  }

  setRuntimeAdapterProgress(
    progress: TeamProvisioningProgress,
    onProgress?: (progress: TeamProvisioningProgress) => void
  ): TeamProvisioningProgress {
    const nextProgress = this.enrichRuntimeAdapterProgressTrace(progress);
    this.options.state.runtimeAdapterProgressByRunId.set(nextProgress.runId, nextProgress);
    if (
      nextProgress.state === 'disconnected' ||
      nextProgress.state === 'failed' ||
      nextProgress.state === 'cancelled'
    ) {
      this.options.retainProvisioningProgress(nextProgress.runId, nextProgress);
    }
    onProgress?.(nextProgress);
    return nextProgress;
  }
}

export const RUNTIME_ADAPTER_PROVISIONING_TRACE_STORAGE_LIMIT =
  PROVISIONING_TRACE_STORAGE_LIMIT;
