import { createLogger } from '@shared/utils/logger';

import { TeamTaskActivityIntervalService } from '../TeamTaskActivityIntervalService';

import {
  type LeadActivityState,
  setLeadActivity as setLeadActivityHelper,
  type SetLeadActivityPorts,
  syncLeadTaskActivityForState as syncLeadTaskActivityForStateHelper,
} from './TeamProvisioningLeadActivity';
import {
  createTeamProvisioningLeadActivityPortsFromService,
  type TeamProvisioningLeadActivityPortsServiceHost,
} from './TeamProvisioningLeadActivityPortsFactory';
import { emitLeadContextUsageForRun } from './TeamProvisioningLeadContextUsage';
import { TeamProvisioningMemberSpawnStatusCompatibilityFacade } from './TeamProvisioningMemberSpawnStatusCompatibilityFacade';
import { type ProvisioningRun } from './TeamProvisioningRunModel';
import { nowIso, updateProgress } from './TeamProvisioningRunProgress';
import {
  createRuntimeToolActivityHandlerPortsFromService,
  createRuntimeToolActivityHandlers,
  type RuntimeToolActivityServiceHost,
} from './TeamProvisioningRuntimeToolActivity';

import type { TeamChangeEvent } from '@shared/types';

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
