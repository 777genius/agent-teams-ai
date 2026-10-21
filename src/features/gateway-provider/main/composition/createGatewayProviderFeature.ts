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
import type { GatewayProviderServiceDeps } from '../application/GatewayProviderService';
import type { ResolvedMemberGatewayConnection } from '../application/GatewayProviderService';
import type { ApiKeyService } from '@main/services/extensions/apikeys/ApiKeyService';

export interface GatewayProviderFeatureFacade {
  listGatewayProfiles(): Promise<GatewayProfileDto[]>;
  saveGatewayProfile(request: GatewayProfileSaveRequest): Promise<GatewayProfileDto>;
  deleteGatewayProfile(id: string): Promise<void>;
  probeGatewayModels(request: GatewayProbeModelsRequest): Promise<string[]>;
  listGatewayBindings(teamName?: string): Promise<GatewayMemberBindingDto[]>;
  bindGatewayMember(
    request: GatewayBindMemberRequest,
    draftOwner?: string
  ): Promise<GatewayMemberBindingDto>;
  recoverGatewayDraftBindings(owner?: string): Promise<void>;
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
  onBindingsChanged?: () => void;
  drafts?: GatewayProviderServiceDeps['drafts'];
}): GatewayProviderFeatureFacade {
  const service = new GatewayProviderService({
    store: new JsonGatewayProviderStore(deps.storePath),
    credentials: new GatewayCredentialStore(deps.apiKeys),
    clock: { now: () => new Date() },
    onBindingsChanged: deps.onBindingsChanged,
    drafts: deps.drafts,
  });

  let recovery: Promise<void> | undefined;
  const ready = <T>(operation: () => Promise<T>): Promise<T> => {
    recovery ??= service.recoverDraftBindings().catch((error: unknown) => {
      recovery = undefined;
      throw error;
    });
    return recovery.then(operation);
  };
  return {
    listGatewayProfiles: () => ready(() => service.listProfiles()),
    saveGatewayProfile: (request) => ready(() => service.saveProfile(request)),
    deleteGatewayProfile: (id) => ready(() => service.deleteProfile(id)),
    probeGatewayModels: (request) => ready(() => service.probeModels(request)),
    listGatewayBindings: (teamName) => ready(() => service.listBindings(teamName)),
    bindGatewayMember: (request, owner) => ready(() => service.bindMember(request, owner)),
    unbindGatewayMember: (request) => ready(() => service.unbindMember(request)),
    recoverGatewayDraftBindings: (owner) =>
      ready(() => (owner === undefined ? Promise.resolve() : service.recoverDraftBindings(owner))),
    retireTeamGatewayBindings: (teamName) => ready(() => service.unbindTeam(teamName)),
    resolveMemberConnection: (teamName, memberName, model) =>
      ready(() => service.resolveMemberConnection(teamName, memberName, model)),
    markRuntimeArtifactActive: (ref) => ready(() => service.markRuntimeArtifactActive(ref)),
    markRuntimeArtifactRetired: (ref) => ready(() => service.markRuntimeArtifactRetired(ref)),
    listGatewayUsageSources: () => ready(() => service.listUsageSources()),
    readGatewayUsageDay: (ref, day) => ready(() => service.readUsageDay(ref, day)),
  };
}
