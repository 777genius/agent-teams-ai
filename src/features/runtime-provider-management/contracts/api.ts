import type {
  RuntimeLocalProviderConfigureInput,
  RuntimeLocalProviderConfigureResponse,
  RuntimeLocalProviderListInput,
  RuntimeLocalProviderListResponse,
  RuntimeLocalProviderProbeInput,
  RuntimeLocalProviderProbeResponse,
  RuntimeLocalProviderScanInput,
  RuntimeLocalProviderScanResponse,
  RuntimeProviderCompanionActionInput,
  RuntimeProviderCompanionInput,
  RuntimeProviderCompanionStatusDto,
  RuntimeProviderManagementCancelModelLoadInput,
  RuntimeProviderManagementCancelModelTestInput,
  RuntimeProviderManagementCancelOAuthInput,
  RuntimeProviderManagementClearProjectDefaultInput,
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
  RuntimeProviderManagementModelTestControlResponse,
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
  listLocalProviders(
    input: RuntimeLocalProviderListInput
  ): Promise<RuntimeLocalProviderListResponse>;
  scanLocalProviders(
    input: RuntimeLocalProviderScanInput
  ): Promise<RuntimeLocalProviderScanResponse>;
  probeLocalProvider(
    input: RuntimeLocalProviderProbeInput
  ): Promise<RuntimeLocalProviderProbeResponse>;
  configureLocalProvider(
    input: RuntimeLocalProviderConfigureInput
  ): Promise<RuntimeLocalProviderConfigureResponse>;
  getCompanionStatus(
    input: RuntimeProviderCompanionInput
  ): Promise<RuntimeProviderCompanionStatusDto>;
  installAndConnectCompanion(
    input: RuntimeProviderCompanionInput
  ): Promise<RuntimeProviderCompanionStatusDto>;
  connectCompanion(
    input: RuntimeProviderCompanionInput
  ): Promise<RuntimeProviderCompanionStatusDto>;
  runCompanionAction(
    input: RuntimeProviderCompanionActionInput
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
  cancelModelLoad(
    input: RuntimeProviderManagementCancelModelLoadInput
  ): Promise<RuntimeProviderManagementModelTestControlResponse>;
  testModel(
    input: RuntimeProviderManagementTestModelInput
  ): Promise<RuntimeProviderManagementModelTestResponse>;
  cancelModelTest(
    input: RuntimeProviderManagementCancelModelTestInput
  ): Promise<RuntimeProviderManagementModelTestControlResponse>;
  setDefaultModel(
    input: RuntimeProviderManagementSetDefaultModelInput
  ): Promise<RuntimeProviderManagementViewResponse>;
  clearProjectDefaultModel(
    input: RuntimeProviderManagementClearProjectDefaultInput
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
