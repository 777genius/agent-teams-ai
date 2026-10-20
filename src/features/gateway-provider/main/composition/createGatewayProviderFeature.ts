import { GatewayCredentialStore } from '../adapters/output/GatewayCredentialStore';
import { GatewayProviderService } from '../application/GatewayProviderService';
import { JsonGatewayProviderStore } from '../infrastructure/JsonGatewayProviderStore';

import type {
  GatewayBindMemberRequest,
  GatewayMemberBindingDto,
  GatewayProbeModelsRequest,
  GatewayProfileDto,
  GatewayProfileSaveRequest,
  GatewayUnbindMemberRequest,
} from '../../contracts/index';
import type { GatewayModelUsage, GatewayUsageSourceInfo } from '../../core/application/usage';
import type { ResolvedMemberGatewayConnection } from '../application/GatewayProviderService';
import type { ApiKeyService } from '@main/services/extensions/apikeys/ApiKeyService';

export interface GatewayProviderFeatureFacade {
  listGatewayProfiles(): Promise<GatewayProfileDto[]>;
  saveGatewayProfile(request: GatewayProfileSaveRequest): Promise<GatewayProfileDto>;
  deleteGatewayProfile(id: string): Promise<void>;
  probeGatewayModels(request: GatewayProbeModelsRequest): Promise<string[]>;
  listGatewayBindings(teamName?: string): Promise<GatewayMemberBindingDto[]>;
  bindGatewayMember(request: GatewayBindMemberRequest): Promise<GatewayMemberBindingDto>;
  unbindGatewayMember(request: GatewayUnbindMemberRequest): Promise<void>;
  retireTeamGatewayBindings(teamName: string): Promise<void>;
  resolveMemberConnection(
    teamName: string,
    memberName: string,
    model?: string
  ): Promise<ResolvedMemberGatewayConnection | null>;
  markRuntimeArtifactActive(gatewayUsageRef: string): Promise<void>;
  markRuntimeArtifactRetired(gatewayUsageRef: string): Promise<void>;
  listGatewayUsageSources(): Promise<GatewayUsageSourceInfo[]>;
  readGatewayUsageDay(gatewayUsageRef: string, day: string): Promise<GatewayModelUsage[]>;
}

export function createGatewayProviderFeature(deps: {
  storePath: string;
  apiKeys: Pick<ApiKeyService, 'save' | 'readValueById'>;
}): GatewayProviderFeatureFacade {
  const service = new GatewayProviderService({
    store: new JsonGatewayProviderStore(deps.storePath),
    credentials: new GatewayCredentialStore(deps.apiKeys),
    clock: { now: () => new Date() },
  });

  return {
    listGatewayProfiles: () => service.listProfiles(),
    saveGatewayProfile: (request) => service.saveProfile(request),
    deleteGatewayProfile: (id) => service.deleteProfile(id),
    probeGatewayModels: (request) => service.probeModels(request),
    listGatewayBindings: (teamName) => service.listBindings(teamName),
    bindGatewayMember: (request) => service.bindMember(request),
    unbindGatewayMember: (request) => service.unbindMember(request),
    retireTeamGatewayBindings: (teamName) => service.unbindTeam(teamName),
    resolveMemberConnection: (teamName, memberName, model) =>
      service.resolveMemberConnection(teamName, memberName, model),
    markRuntimeArtifactActive: (gatewayUsageRef) =>
      service.markRuntimeArtifactActive(gatewayUsageRef),
    markRuntimeArtifactRetired: (gatewayUsageRef) =>
      service.markRuntimeArtifactRetired(gatewayUsageRef),
    listGatewayUsageSources: () => service.listUsageSources(),
    readGatewayUsageDay: (gatewayUsageRef, day) => service.readUsageDay(gatewayUsageRef, day),
  };
}
