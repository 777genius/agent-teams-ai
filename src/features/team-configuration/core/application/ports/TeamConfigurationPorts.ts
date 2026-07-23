import type {
  TeamConfig,
  TeamCreateConfigRequest,
  TeamCreateRequest,
  TeamUpdateConfigRequest,
} from '@shared/types';

export interface TeamConfigCreationRepositoryPort {
  createTeamConfig(request: TeamCreateConfigRequest): Promise<void>;
}

export interface TeamConfigUpdateRepositoryPort {
  getTeamDisplayName(teamName: string): Promise<string | null>;
  updateConfig(teamName: string, updates: TeamUpdateConfigRequest): Promise<TeamConfig | null>;
}

export interface SavedTeamRequestRepositoryPort {
  getSavedRequest(teamName: string): Promise<TeamCreateRequest | null>;
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
