import { api } from '@renderer/api';

import type {
  GatewayBindMemberRequest,
  GatewayMemberBindingDto,
  GatewayProbeModelsRequest,
  GatewayProbeModelsResult,
  GatewayProfileDto,
  GatewayProfileSaveRequest,
  GatewayUnbindMemberRequest,
} from '../../contracts';

/** Renderer boundary for `window.electronAPI.gatewayProvider`. */
export function listGatewayProfiles(): Promise<GatewayProfileDto[]> {
  return api.gatewayProvider.listGatewayProfiles();
}

export function saveGatewayProfile(request: GatewayProfileSaveRequest): Promise<GatewayProfileDto> {
  return api.gatewayProvider.saveGatewayProfile(request);
}

export function deleteGatewayProfile(id: string): Promise<void> {
  return api.gatewayProvider.deleteGatewayProfile(id);
}

export function probeGatewayModels(
  request: GatewayProbeModelsRequest
): Promise<GatewayProbeModelsResult> {
  return api.gatewayProvider.probeGatewayModels(request);
}

export function listGatewayBindings(teamName?: string): Promise<GatewayMemberBindingDto[]> {
  return api.gatewayProvider.listGatewayBindings(teamName);
}

export function bindGatewayMember(
  request: GatewayBindMemberRequest
): Promise<GatewayMemberBindingDto> {
  return api.gatewayProvider.bindGatewayMember(request);
}

export function unbindGatewayMember(request: GatewayUnbindMemberRequest): Promise<void> {
  return api.gatewayProvider.unbindGatewayMember(request);
}
