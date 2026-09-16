export interface TeamConfigurationMember {
  name: string;
}

export interface TeamConfigurationConfig {
  name: string;
  members?: TeamConfigurationMember[];
}

export interface TeamConfigurationCreateConfigRequest {
  teamName: string;
  members: TeamConfigurationMember[];
}

export interface TeamConfigurationSavedRequest extends TeamConfigurationCreateConfigRequest {
  cwd: string;
}

export interface TeamConfigurationUpdateRequest {
  name?: string;
  description?: string;
  color?: string;
  language?: string;
}

export interface TeamConfigCreationRepositoryPort {
  createTeamConfig(request: TeamConfigurationCreateConfigRequest): Promise<void>;
}

export interface TeamConfigUpdateRepositoryPort {
  getTeamDisplayName(teamName: string): Promise<string | null>;
  updateConfig(
    teamName: string,
    updates: TeamConfigurationUpdateRequest
  ): Promise<TeamConfigurationConfig | null>;
}

export interface SavedTeamRequestRepositoryPort {
  getSavedRequest(teamName: string): Promise<TeamConfigurationSavedRequest | null>;
}

export interface DraftTeamDeletionRepositoryPort {
  permanentlyDeleteTeam(teamName: string): Promise<void>;
}

export type TeamConfigurationRepositoryPort = TeamConfigCreationRepositoryPort &
  TeamConfigUpdateRepositoryPort &
  SavedTeamRequestRepositoryPort &
  DraftTeamDeletionRepositoryPort;

export interface TeamConfigurationRuntimePort {
  isTeamAlive(teamName: string): boolean;
}

export interface TeamConfigurationMessagingPort {
  sendMessageToTeam(teamName: string, message: string): Promise<void>;
}

export interface TeamConfigurationCachePort {
  invalidateTeamConfig(teamName: string): void;
}

export interface DraftTeamConfigGuardPort {
  assertDraftCanBeDeleted(teamName: string): Promise<void>;
}

export interface TeamConfigurationLoggerPort {
  error(message: string): void;
  warn(message: string): void;
}
