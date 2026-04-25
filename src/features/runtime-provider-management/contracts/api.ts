import type {
  RuntimeProviderManagementConnectApiKeyInput,
  RuntimeProviderManagementDirectoryResponse,
  RuntimeProviderManagementForgetInput,
  RuntimeProviderManagementLoadDirectoryInput,
  RuntimeProviderManagementLoadViewInput,
  RuntimeProviderManagementLoadModelsInput,
  RuntimeProviderManagementModelTestResponse,
  RuntimeProviderManagementModelsResponse,
  RuntimeProviderManagementProviderResponse,
  RuntimeProviderManagementSetDefaultModelInput,
  RuntimeProviderManagementTestModelInput,
  RuntimeProviderManagementViewResponse,
} from './types';

export interface RuntimeProviderManagementApi {
  loadView(
    input: RuntimeProviderManagementLoadViewInput
  ): Promise<RuntimeProviderManagementViewResponse>;
  loadProviderDirectory(
    input: RuntimeProviderManagementLoadDirectoryInput
  ): Promise<RuntimeProviderManagementDirectoryResponse>;
  connectWithApiKey(
    input: RuntimeProviderManagementConnectApiKeyInput
  ): Promise<RuntimeProviderManagementProviderResponse>;
  forgetCredential(
    input: RuntimeProviderManagementForgetInput
  ): Promise<RuntimeProviderManagementProviderResponse>;
  loadModels(
    input: RuntimeProviderManagementLoadModelsInput
  ): Promise<RuntimeProviderManagementModelsResponse>;
  testModel(
    input: RuntimeProviderManagementTestModelInput
  ): Promise<RuntimeProviderManagementModelTestResponse>;
  setDefaultModel(
    input: RuntimeProviderManagementSetDefaultModelInput
  ): Promise<RuntimeProviderManagementViewResponse>;
}
