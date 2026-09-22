import type { CrossTeamMessageCandidate, OrgStructureModel, OrgTeamCandidate } from '../domain';

export interface OrganizationsStructurePort {
  loadStructure(input: { organizationId?: string }): Promise<OrgStructureModel | null>;
  saveStructure(structure: OrgStructureModel): Promise<OrgStructureModel>;
}

export interface OrganizationsTeamDirectoryPort {
  listTeams(input: { includeDeletedTeams: boolean }): Promise<OrgTeamCandidate[]>;
}

export interface OrganizationsCrossTeamMessagePort {
  listRecentMessages(input: {
    teamNames: readonly string[];
    maxMessages: number;
  }): Promise<CrossTeamMessageCandidate[]>;
}

export interface OrganizationsClockPort {
  now(): number;
}

export interface OrganizationsLoggerPort {
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, error?: unknown): void;
}
