import { GATEWAY_PROVIDER_CHANNELS, type GatewayProviderApi } from '@features/gateway-provider/contracts';
import { ipcRenderer } from 'electron';

export function createGatewayProviderBridge(): GatewayProviderApi {
  return {
    listGatewayProfiles: () => ipcRenderer.invoke(GATEWAY_PROVIDER_CHANNELS.listProfiles),
    saveGatewayProfile: (request) =>
      ipcRenderer.invoke(GATEWAY_PROVIDER_CHANNELS.saveProfile, request),
    deleteGatewayProfile: (id) =>
      ipcRenderer.invoke(GATEWAY_PROVIDER_CHANNELS.deleteProfile, id),
    probeGatewayModels: (request) =>
      ipcRenderer.invoke(GATEWAY_PROVIDER_CHANNELS.probeModels, request),
    listGatewayBindings: (teamName) =>
      ipcRenderer.invoke(GATEWAY_PROVIDER_CHANNELS.listBindings, teamName),
    bindGatewayMember: (request) =>
      ipcRenderer.invoke(GATEWAY_PROVIDER_CHANNELS.bindMember, request),
    unbindGatewayMember: (request) =>
      ipcRenderer.invoke(GATEWAY_PROVIDER_CHANNELS.unbindMember, request),
  };
}
