import type {
  TeamMemberSpawnStatusPort,
  TeamRuntimeDiagnosticsPort,
  TeamRuntimeStatusPort,
} from '../ports/TeamRuntimeOperationPorts';
import type {
  LeadActivitySnapshot,
  LeadContextUsageSnapshot,
  MemberSpawnStatusesSnapshot,
  TeamAgentRuntimeSnapshot,
} from '@shared/types';

export class ReadTeamRuntimeDiagnostics {
  constructor(
    private readonly status: TeamRuntimeStatusPort,
    private readonly diagnostics: TeamRuntimeDiagnosticsPort,
    private readonly lifecycle: TeamMemberSpawnStatusPort
  ) {}

  getAliveTeams(): string[] {
    return this.status.getAliveTeams();
  }

  getLeadActivity(teamName: string): LeadActivitySnapshot {
    return this.diagnostics.getLeadActivityState(teamName);
  }

  getLeadContext(teamName: string): LeadContextUsageSnapshot {
    return this.diagnostics.getLeadContextUsage(teamName);
  }

  getMemberSpawnStatuses(teamName: string): Promise<MemberSpawnStatusesSnapshot> {
    return this.lifecycle.getMemberSpawnStatuses(teamName);
  }

  getAgentRuntime(teamName: string): Promise<TeamAgentRuntimeSnapshot> {
    return this.diagnostics.getTeamAgentRuntimeSnapshot(teamName);
  }
}
