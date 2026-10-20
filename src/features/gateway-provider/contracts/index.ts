export const GATEWAY_PROVIDER_CHANNELS = {
  listProfiles: 'gateway-provider:listProfiles',
  saveProfile: 'gateway-provider:saveProfile',
  deleteProfile: 'gateway-provider:deleteProfile',
  probeModels: 'gateway-provider:probeModels',
  listBindings: 'gateway-provider:listBindings',
  bindMember: 'gateway-provider:bindMember',
  unbindMember: 'gateway-provider:unbindMember',
} as const;

export interface GatewayProfileDto {
  id: string;
  displayName: string;
  /** Canonical gateway root without a trailing `/v1`. */
  baseUrl: string;
  allowPrivateNetwork: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface GatewayProfileSaveRequest {
  id?: string;
  displayName: string;
  baseUrl: string;
  allowPrivateNetwork?: boolean;
}

export type GatewayCredentialStatus = 'ready' | 'credential_changed' | 'credential_missing';

export interface GatewayMemberBindingDto {
  teamName: string;
  memberName: string;
  profileId: string;
  profileDisplayName: string;
  gatewayUsageRef: string;
  boundAt: string;
  credentialStatus: GatewayCredentialStatus;
}

export interface GatewayBindMemberRequest {
  teamName: string;
  memberName: string;
  profileId: string;
  apiKey: string;
}

export interface GatewayUnbindMemberRequest {
  teamName: string;
  memberName: string;
}

export interface GatewayProbeModelsRequest {
  profileId: string;
  apiKey: string;
}

export interface GatewayProbeModelsResult {
  models: string[];
}

export interface GatewayProviderApi {
  listGatewayProfiles(): Promise<GatewayProfileDto[]>;
  saveGatewayProfile(request: GatewayProfileSaveRequest): Promise<GatewayProfileDto>;
  deleteGatewayProfile(id: string): Promise<void>;
  probeGatewayModels(request: GatewayProbeModelsRequest): Promise<GatewayProbeModelsResult>;
  listGatewayBindings(teamName?: string): Promise<GatewayMemberBindingDto[]>;
  bindGatewayMember(request: GatewayBindMemberRequest): Promise<GatewayMemberBindingDto>;
  unbindGatewayMember(request: GatewayUnbindMemberRequest): Promise<void>;
}
