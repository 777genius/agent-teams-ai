import type {
  RuntimeProviderCompanionInput,
  RuntimeProviderCompanionStatusDto,
  RuntimeProviderManagementCancelOAuthInput,
  RuntimeProviderManagementConfigureModelLimitsInput,
  RuntimeProviderManagementConnectApiKeyInput,
  RuntimeProviderManagementConnectInput,
  RuntimeProviderManagementDirectoryResponse,
  RuntimeProviderManagementForgetInput,
  RuntimeProviderManagementLoadDirectoryInput,
  RuntimeProviderManagementLoadModelsInput,
  RuntimeProviderManagementLoadSetupFormInput,
  RuntimeProviderManagementLoadViewInput,
  RuntimeProviderManagementModelLimitsResponse,
  RuntimeProviderManagementModelsResponse,
  RuntimeProviderManagementModelTestResponse,
  RuntimeProviderManagementOAuthControlResponse,
  RuntimeProviderManagementProviderResponse,
  RuntimeProviderManagementSetDefaultModelInput,
  RuntimeProviderManagementSetupFormResponse,
  RuntimeProviderManagementSubmitOAuthCodeInput,
  RuntimeProviderManagementTestModelInput,
  RuntimeProviderManagementViewResponse,
  RuntimeProviderOAuthProgressDto,
} from './types';

export interface RuntimeProviderManagementApi {
  getCompanionStatus(
    input: RuntimeProviderCompanionInput
  ): Promise<RuntimeProviderCompanionStatusDto>;
  installAndConnectCompanion(
    input: RuntimeProviderCompanionInput
  ): Promise<RuntimeProviderCompanionStatusDto>;
  connectCompanion(
    input: RuntimeProviderCompanionInput
  ): Promise<RuntimeProviderCompanionStatusDto>;
  onCompanionProgress(listener: (event: RuntimeProviderCompanionStatusDto) => void): () => void;
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
  configureModelLimits(
    input: RuntimeProviderManagementConfigureModelLimitsInput
  ): Promise<RuntimeProviderManagementModelLimitsResponse>;
  submitOAuthCode(
    input: RuntimeProviderManagementSubmitOAuthCodeInput
  ): Promise<RuntimeProviderManagementOAuthControlResponse>;
  cancelOAuth(
    input: RuntimeProviderManagementCancelOAuthInput
  ): Promise<RuntimeProviderManagementOAuthControlResponse>;
  onOAuthProgress(listener: (event: RuntimeProviderOAuthProgressDto) => void): () => void;
}
