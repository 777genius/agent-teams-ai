import type {
  RuntimeProviderManagementConnectApiKeyInput,
  RuntimeProviderManagementConnectInput,
  RuntimeProviderManagementDirectoryResponse,
  RuntimeProviderManagementForgetInput,
  RuntimeProviderManagementLoadDirectoryInput,
  RuntimeProviderManagementLoadSetupFormInput,
  RuntimeProviderManagementLoadViewInput,
  RuntimeProviderManagementLoadModelsInput,
  RuntimeProviderManagementModelTestResponse,
  RuntimeProviderManagementModelsResponse,
  RuntimeProviderManagementProviderResponse,
  RuntimeProviderManagementSetDefaultModelInput,
  RuntimeProviderManagementSetupFormResponse,
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
  loadSetupForm(
    input: RuntimeProviderManagementLoadSetupFormInput
  ): Promise<RuntimeProviderManagementSetupFormResponse>;
  connectProvider(
    input: RuntimeProviderManagementConnectInput
  ): Promise<RuntimeProviderManagementProviderResponse>;
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
