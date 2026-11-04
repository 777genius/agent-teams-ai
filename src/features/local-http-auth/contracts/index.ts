/** Private authority. Never expose this DTO through IPC, HTTP or renderer bootstrap. */
export interface ApiAuthority {
  schemaVersion: 1;
  service: 'api';
  profileScope: string;
  instanceId: string;
  generation: string;
  baseUrl: string;
  token: string;
}

export interface ApiDiscoveryReference {
  schemaVersion: 1;
  service: 'api';
  profileScope: string;
  instanceId: string;
  generation: string;
  descriptorPath: string;
}

export const API_AUTH_REFERENCE_ENV = 'CLAUDE_TEAM_CONTROL_AUTH_REF';
