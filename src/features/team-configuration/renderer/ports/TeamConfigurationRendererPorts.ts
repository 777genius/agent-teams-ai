import type {
  TeamConfig,
  TeamCreateConfigRequest,
  TeamCreateRequest,
  TeamUpdateConfigRequest,
} from '@shared/types';

export interface TeamConfigurationRendererPorts {
  createConfig(request: TeamCreateConfigRequest): Promise<void>;
  getSavedRequest(teamName: string): Promise<TeamCreateRequest | null>;
  updateConfig(teamName: string, updates: TeamUpdateConfigRequest): Promise<TeamConfig>;
}
