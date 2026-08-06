import { killProcessByPid } from '@main/utils/processKill';

import type { TeamDataProcessCapability } from './TeamDataControllerCompatibilityAdapter';
import type { TeamDataProcessCompatibilityPort } from './TeamDataProcessCompatibilityService';
import type { TeamSummary } from '@shared/types';

/**
 * Adapts existing controller and OS stop capabilities for the compatibility
 * service without creating a lifecycle or process-supervision owner.
 */
export class TeamDataProcessCompatibilityAdapter implements TeamDataProcessCompatibilityPort {
  constructor(
    private readonly processes: TeamDataProcessCapability,
    private readonly listTeamsForCompatibility: () => Promise<TeamSummary[]>,
    private readonly killByPid: (pid: number) => void = killProcessByPid
  ) {}

  listTeams(): Promise<TeamSummary[]> {
    return this.listTeamsForCompatibility();
  }

  listProcesses(teamName: string) {
    return this.processes.listProcesses(teamName);
  }

  stopProcess(teamName: string, pid: number): void {
    this.processes.stopProcess(teamName, pid);
  }

  killProcessByPid(pid: number): void {
    this.killByPid(pid);
  }
}
