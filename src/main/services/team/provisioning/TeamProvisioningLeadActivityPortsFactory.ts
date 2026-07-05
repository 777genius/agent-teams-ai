import type { LeadActivityRunLike, SetLeadActivityPorts } from './TeamProvisioningLeadActivity';
import type { TeamChangeEvent } from '@shared/types';

export interface TeamProvisioningLeadActivityIntervalService {
  resumeActiveIntervalsForMember(
    teamName: string,
    memberName: string,
    at: string
  ): { failed?: boolean };
  pauseActiveIntervalsForMember(
    teamName: string,
    memberName: string,
    at: string
  ): { failed?: boolean };
}

export interface TeamProvisioningLeadActivityPortsFactoryDeps<TRun extends LeadActivityRunLike> {
  syncedRunKeys: Set<string>;
  getRunLeadName(run: TRun): string;
  taskActivityIntervalService: TeamProvisioningLeadActivityIntervalService;
  isCurrentTrackedRun(run: TRun): boolean;
  nowIso(): string;
  emitTeamChange(event: TeamChangeEvent): void;
}

export function createTeamProvisioningLeadActivityPorts<TRun extends LeadActivityRunLike>(
  deps: TeamProvisioningLeadActivityPortsFactoryDeps<TRun>
): SetLeadActivityPorts<TRun> {
  return {
    syncedRunKeys: deps.syncedRunKeys,
    getRunLeadName: (run) => deps.getRunLeadName(run),
    resumeActiveIntervalsForMember: (teamName, memberName, at) =>
      deps.taskActivityIntervalService.resumeActiveIntervalsForMember(teamName, memberName, at),
    pauseActiveIntervalsForMember: (teamName, memberName, at) =>
      deps.taskActivityIntervalService.pauseActiveIntervalsForMember(teamName, memberName, at),
    isCurrentTrackedRun: (run) => deps.isCurrentTrackedRun(run),
    nowIso: deps.nowIso,
    emitTeamChange: (event) => deps.emitTeamChange(event),
  };
}
