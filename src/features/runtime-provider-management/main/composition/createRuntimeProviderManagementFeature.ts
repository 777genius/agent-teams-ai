import { AgentTeamsRuntimeProviderManagementCliClient } from '../infrastructure/AgentTeamsRuntimeProviderManagementCliClient';

import type { RuntimeProviderManagementPort } from '../../core/application';
import type {
  RuntimeProviderManagementApi,
  RuntimeProviderManagementConnectApiKeyInput,
  RuntimeProviderManagementDirectoryResponse,
  RuntimeProviderManagementForgetInput,
  RuntimeProviderManagementLoadDirectoryInput,
  RuntimeProviderManagementLoadModelsInput,
  RuntimeProviderManagementLoadViewInput,
  RuntimeProviderManagementModelTestResponse,
  RuntimeProviderManagementModelsResponse,
  RuntimeProviderManagementProviderResponse,
  RuntimeProviderManagementSetDefaultModelInput,
  RuntimeProviderManagementTestModelInput,
  RuntimeProviderManagementViewResponse,
} from '@features/runtime-provider-management/contracts';

export type RuntimeProviderManagementFeatureFacade = RuntimeProviderManagementApi;

export function createRuntimeProviderManagementFeature(
  deps: {
    port?: RuntimeProviderManagementPort;
  } = {}
): RuntimeProviderManagementFeatureFacade {
  const port = deps.port ?? new AgentTeamsRuntimeProviderManagementCliClient();

  return {
    loadView: (
      input: RuntimeProviderManagementLoadViewInput
    ): Promise<RuntimeProviderManagementViewResponse> => port.loadView(input),
    loadProviderDirectory: (
      input: RuntimeProviderManagementLoadDirectoryInput
    ): Promise<RuntimeProviderManagementDirectoryResponse> => port.loadProviderDirectory(input),
    connectWithApiKey: (
      input: RuntimeProviderManagementConnectApiKeyInput
    ): Promise<RuntimeProviderManagementProviderResponse> => port.connectWithApiKey(input),
    forgetCredential: (
      input: RuntimeProviderManagementForgetInput
    ): Promise<RuntimeProviderManagementProviderResponse> => port.forgetCredential(input),
    loadModels: (
      input: RuntimeProviderManagementLoadModelsInput
    ): Promise<RuntimeProviderManagementModelsResponse> => port.loadModels(input),
    testModel: (
      input: RuntimeProviderManagementTestModelInput
    ): Promise<RuntimeProviderManagementModelTestResponse> => port.testModel(input),
    setDefaultModel: (
      input: RuntimeProviderManagementSetDefaultModelInput
    ): Promise<RuntimeProviderManagementViewResponse> => port.setDefaultModel(input),
  };
}
