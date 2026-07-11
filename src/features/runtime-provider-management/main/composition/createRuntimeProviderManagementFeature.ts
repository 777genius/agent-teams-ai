import {
  AgentTeamsRuntimeProviderManagementCliClient,
  type RuntimeProviderOAuthClientDependencies,
} from '../infrastructure/AgentTeamsRuntimeProviderManagementCliClient';
import {
  KiroCliCompanionService,
  type KiroCliCompanionServiceDependencies,
} from '../infrastructure/KiroCliCompanionService';

import type { RuntimeProviderManagementPort } from '../../core/application';
import type {
  RuntimeProviderCompanionInput,
  RuntimeProviderCompanionStatusDto,
  RuntimeProviderManagementApi,
  RuntimeProviderManagementCancelOAuthInput,
  RuntimeProviderManagementConnectApiKeyInput,
  RuntimeProviderManagementConnectInput,
  RuntimeProviderManagementDirectoryResponse,
  RuntimeProviderManagementForgetInput,
  RuntimeProviderManagementLoadDirectoryInput,
  RuntimeProviderManagementLoadModelsInput,
  RuntimeProviderManagementLoadSetupFormInput,
  RuntimeProviderManagementLoadViewInput,
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
} from '@features/runtime-provider-management/contracts';

export type RuntimeProviderManagementFeatureFacade = RuntimeProviderManagementApi;

function assertKiroCompanion(input: RuntimeProviderCompanionInput): void {
  if (!input || input.companionId !== 'kiro-cli') {
    throw new Error('Unsupported runtime provider companion');
  }
}

export function createRuntimeProviderManagementFeature(
  deps: {
    port?: RuntimeProviderManagementPort;
    companionService?: KiroCliCompanionService;
  } & RuntimeProviderOAuthClientDependencies &
    Pick<KiroCliCompanionServiceDependencies, 'emitProgress'> = {}
): RuntimeProviderManagementFeatureFacade {
  const port = deps.port ?? new AgentTeamsRuntimeProviderManagementCliClient(deps);
  const companionService =
    deps.companionService ?? new KiroCliCompanionService({ emitProgress: deps.emitProgress });

  const verifyConnectedCompanion = async (
    input: RuntimeProviderCompanionInput,
    status: RuntimeProviderCompanionStatusDto
  ): Promise<RuntimeProviderCompanionStatusDto> => {
    if (!status.authenticated) return status;
    companionService.setModelVerificationPending();
    const response = await port.testModel({
      runtimeId: 'opencode',
      providerId: 'kiro',
      modelId: 'kiro/auto',
      projectPath: input.projectPath ?? null,
    });
    const ok = response.result?.ok === true && response.result.availability === 'available';
    const detail =
      response.result?.message ??
      response.error?.message ??
      (ok ? 'Kiro completed a verified OpenCode request.' : 'OpenCode could not verify kiro/auto.');
    return companionService.setModelVerificationResult(ok, detail);
  };

  return {
    getCompanionStatus: async (
      input: RuntimeProviderCompanionInput
    ): Promise<RuntimeProviderCompanionStatusDto> => {
      assertKiroCompanion(input);
      return companionService.getStatus();
    },
    installAndConnectCompanion: async (
      input: RuntimeProviderCompanionInput
    ): Promise<RuntimeProviderCompanionStatusDto> => {
      assertKiroCompanion(input);
      return verifyConnectedCompanion(input, await companionService.installAndConnect());
    },
    connectCompanion: async (
      input: RuntimeProviderCompanionInput
    ): Promise<RuntimeProviderCompanionStatusDto> => {
      assertKiroCompanion(input);
      return verifyConnectedCompanion(input, await companionService.connect());
    },
    onCompanionProgress: (): (() => void) => () => {},
    loadView: (
      input: RuntimeProviderManagementLoadViewInput
    ): Promise<RuntimeProviderManagementViewResponse> => port.loadView(input),
    loadProviderDirectory: (
      input: RuntimeProviderManagementLoadDirectoryInput
    ): Promise<RuntimeProviderManagementDirectoryResponse> => port.loadProviderDirectory(input),
    loadSetupForm: (
      input: RuntimeProviderManagementLoadSetupFormInput
    ): Promise<RuntimeProviderManagementSetupFormResponse> => port.loadSetupForm(input),
    connectProvider: (
      input: RuntimeProviderManagementConnectInput
    ): Promise<RuntimeProviderManagementProviderResponse> => port.connectProvider(input),
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
    submitOAuthCode: (
      input: RuntimeProviderManagementSubmitOAuthCodeInput
    ): Promise<RuntimeProviderManagementOAuthControlResponse> => port.submitOAuthCode(input),
    cancelOAuth: (
      input: RuntimeProviderManagementCancelOAuthInput
    ): Promise<RuntimeProviderManagementOAuthControlResponse> => port.cancelOAuth(input),
    onOAuthProgress: (listener: (event: RuntimeProviderOAuthProgressDto) => void): (() => void) =>
      port.onOAuthProgress(listener),
  };
}
