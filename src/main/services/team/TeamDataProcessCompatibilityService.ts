import type { TeamProcess, TeamSummary } from '@shared/types';

const DEFAULT_PROCESS_HEALTH_INTERVAL_MS = 2_000;

export interface TeamDataProcessCompatibilityPort {
  listTeams(): Promise<TeamSummary[]>;
  listProcesses(teamName: string): TeamProcess[];
  stopProcess(teamName: string, pid: number): void;
  killProcessByPid(pid: number): void;
}

/**
 * Preserves TeamDataService's legacy process API without taking runtime ownership.
 * The injected port remains an adapter over the external controller and OS process APIs.
 */
export class TeamDataProcessCompatibilityService {
  private processHealthTimer: ReturnType<typeof setInterval> | null = null;
  private readonly processHealthTeams = new Set<string>();

  constructor(
    private readonly port: TeamDataProcessCompatibilityPort,
    private readonly processHealthIntervalMs = DEFAULT_PROCESS_HEALTH_INTERVAL_MS
  ) {}

  async listAliveProcessTeams(): Promise<string[]> {
    const teams = await this.port.listTeams();
    const alive: string[] = [];

    for (const team of teams) {
      if (team.deletedAt) continue;
      try {
        const processes = await this.readProcesses(team.teamName);
        if (processes.some((process) => !process.stoppedAt)) {
          alive.push(team.teamName);
        }
      } catch {
        // Process reads are best-effort per team for legacy stall monitoring.
      }
    }

    return alive.sort((left, right) => left.localeCompare(right));
  }

  observeTeamAlive(teamName: string, isAlive: boolean): void {
    // eslint-disable-next-line sonarjs/no-selector-parameter -- Preserves TeamDataService's legacy compatibility API.
    if (isAlive) {
      this.trackProcessHealthForTeam(teamName);
    } else {
      this.untrackProcessHealthForTeam(teamName);
    }
  }

  startProcessHealthPolling(): void {
    if (this.processHealthTimer) return;
    this.processHealthTimer = setInterval(() => {
      this.processHealthTick();
    }, this.processHealthIntervalMs);
    // Background compatibility maintenance should not keep the process alive.
    this.processHealthTimer.unref();
  }

  stopProcessHealthPolling(): void {
    if (this.processHealthTimer) {
      clearInterval(this.processHealthTimer);
      this.processHealthTimer = null;
    }
    this.processHealthTeams.clear();
  }

  trackProcessHealthForTeam(teamName: string): void {
    this.processHealthTeams.add(teamName);
  }

  untrackProcessHealthForTeam(teamName: string): void {
    this.processHealthTeams.delete(teamName);
  }

  async readProcesses(teamName: string): Promise<TeamProcess[]> {
    return this.port.listProcesses(teamName);
  }

  async killProcess(teamName: string, pid: number): Promise<void> {
    try {
      this.port.killProcessByPid(pid);
    } catch (error: unknown) {
      // ESRCH means the OS process is already gone; still reconcile the registry below.
      if (
        error instanceof Error &&
        'code' in error &&
        (error as NodeJS.ErrnoException).code !== 'ESRCH'
      ) {
        throw new Error(`Failed to kill process ${pid}: ${error.message}`);
      }
    }

    try {
      this.port.stopProcess(teamName, pid);
    } catch {
      // Missing persisted registry rows are compatible with an OS-level stop.
    }
  }

  private processHealthTick(): void {
    for (const teamName of this.processHealthTeams) {
      try {
        this.port.listProcesses(teamName);
      } catch {
        // Process health polling is best-effort per team.
      }
    }
  }
}
