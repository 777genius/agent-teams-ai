import { createLogger } from '@shared/utils/logger';

import { TeamTaskActivityIntervalService } from '../TeamTaskActivityIntervalService';

import {
  getLeadActivityStateForTeam,
  type LeadActivityState,
  setLeadActivity as setLeadActivityHelper,
  type SetLeadActivityPorts,
  syncLeadTaskActivityForState as syncLeadTaskActivityForStateHelper,
} from './TeamProvisioningLeadActivity';
import {
  createTeamProvisioningLeadActivityPortsFromService,
  type TeamProvisioningLeadActivityPortsServiceHost,
} from './TeamProvisioningLeadActivityPortsFactory';
import {
  emitLeadContextUsageForRun,
  getLeadContextUsageForTeam,
} from './TeamProvisioningLeadContextUsage';
import { TeamProvisioningMemberSpawnStatusCompatibilityFacade } from './TeamProvisioningMemberSpawnStatusCompatibilityFacade';
import { type ProvisioningRun } from './TeamProvisioningRunModel';
import { nowIso, updateProgress } from './TeamProvisioningRunProgress';
import {
  createRuntimeToolActivityHandlerPortsFromService,
  createRuntimeToolActivityHandlers,
  type RuntimeToolActivityServiceHost,
} from './TeamProvisioningRuntimeToolActivity';

import type { LeadContextUsage, TeamChangeEvent } from '@shared/types';

const logger = createLogger('Service:TeamProvisioning');

export abstract class TeamProvisioningTaskActivityCompatibilityFacade<
  TRun extends ProvisioningRun = ProvisioningRun,
> extends TeamProvisioningMemberSpawnStatusCompatibilityFacade<TRun> {
  protected readonly taskActivityIntervalService = new TeamTaskActivityIntervalService();
  protected readonly runtimeToolActivity = createRuntimeToolActivityHandlers<TRun>(
    createRuntimeToolActivityHandlerPortsFromService(
      this as unknown as RuntimeToolActivityServiceHost<TRun>,
      {
        nowIso,
        logInfo: (message) => logger.info(message),
        logWarn: (message) => logger.warn(message),
        updateProgress,
      }
    )
  );
  private readonly leadTaskActivitySyncedRunKeys = new Set<string>();

  protected syncLeadTaskActivityForState(
    run: TRun,
    state: LeadActivityState,
    previousState: LeadActivityState,
    at = nowIso()
  ): void {
    syncLeadTaskActivityForStateHelper(
      run,
      state,
      previousState,
      this.createLeadActivityPorts(),
      at
    );
  }

  protected setLeadActivity(run: TRun, state: LeadActivityState): void {
    setLeadActivityHelper(run, state, this.createLeadActivityPorts());
  }

  private createLeadActivityPorts(): SetLeadActivityPorts<TRun> {
    return createTeamProvisioningLeadActivityPortsFromService(
      this as unknown as TeamProvisioningLeadActivityPortsServiceHost<TRun>,
      { nowIso }
    );
  }

  getLeadActivityState(teamName: string): {
    state: 'active' | 'idle' | 'offline';
    runId: string | null;
  } {
    const service = this as unknown as {
      runTracking: { getTrackedRunId(targetTeamName: string): string | null };
      runs: ReadonlyMap<string, TRun>;
      runtimeAdapterRunByTeam: ReadonlyMap<string, { runId: string }>;
      runtimeAdapterProgressByRunId: ReadonlyMap<string, { state?: string }>;
    };
    return getLeadActivityStateForTeam(teamName, {
      getTrackedRunId: (targetTeamName) => service.runTracking.getTrackedRunId(targetTeamName),
      getRun: (runId) => service.runs.get(runId),
      getRuntimeAdapterRun: (targetTeamName) =>
        service.runtimeAdapterRunByTeam.get(targetTeamName) ?? null,
      getRuntimeAdapterProgress: (runId) =>
        service.runtimeAdapterProgressByRunId.get(runId) ?? null,
      // Read-repair active lead task intervals for runs that were already active
      // before interval tracking was introduced or before the renderer polled state.
      syncLeadTaskActivityForState: (run, state, previousState) =>
        this.syncLeadTaskActivityForState(run, state, previousState),
    });
  }

  getLeadContextUsage(teamName: string): { usage: LeadContextUsage | null; runId: string | null } {
    const service = this as unknown as {
      runTracking: { getTrackedRunId(targetTeamName: string): string | null };
      runs: ReadonlyMap<string, TRun>;
    };
    return getLeadContextUsageForTeam(teamName, {
      getTrackedRunId: (targetTeamName) => service.runTracking.getTrackedRunId(targetTeamName),
      getRun: (runId) => service.runs.get(runId),
      nowIso: () => new Date().toISOString(),
    });
  }

  protected emitLeadContextUsage(run: TRun): void {
    const service = this as unknown as {
      isCurrentTrackedRun(targetRun: TRun): boolean;
      teamChangeEmitter?: ((event: TeamChangeEvent) => void) | null;
    };
    emitLeadContextUsageForRun(run, {
      isCurrentTrackedRun: (targetRun) => service.isCurrentTrackedRun(targetRun),
      nowMs: () => Date.now(),
      nowIso: () => new Date().toISOString(),
      emitTeamChange: (event) => service.teamChangeEmitter?.(event),
    });
  }
}
