import type {
  TeamAgentRuntimeSnapshot,
  TeamLeadActivitySnapshot,
  TeamLeadContextUsageSnapshot,
  TeamMemberSpawnStatusesSnapshot,
  TeamMemberSpawnStatusPort,
  TeamRuntimeDiagnosticsPort,
  TeamRuntimeStatusPort,
} from '../ports/TeamRuntimeOperationPorts';

export class ReadTeamRuntimeDiagnostics {
  constructor(
    private readonly status: TeamRuntimeStatusPort,
    private readonly diagnostics: TeamRuntimeDiagnosticsPort,
    private readonly lifecycle: TeamMemberSpawnStatusPort
  ) {}

  getAliveTeams(): string[] {
    return this.status.getAliveTeams();
  }

  getLeadActivity(teamName: string): TeamLeadActivitySnapshot {
    return this.diagnostics.getLeadActivityState(teamName);
  }

  getLeadContext(teamName: string): TeamLeadContextUsageSnapshot {
    return this.diagnostics.getLeadContextUsage(teamName);
  }

  getMemberSpawnStatuses(teamName: string): Promise<TeamMemberSpawnStatusesSnapshot> {
    return this.lifecycle.getMemberSpawnStatuses(teamName);
  }

  getAgentRuntime(teamName: string): Promise<TeamAgentRuntimeSnapshot> {
    return this.diagnostics.getTeamAgentRuntimeSnapshot(teamName);
  }
}
